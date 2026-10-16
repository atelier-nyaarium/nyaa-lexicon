import { afterEach, describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rejection } from "@nyaa-lexicon/protocol/rejection";
import { systemClock } from "../clock.js";
import type {
	CollectedScopeEvidence,
	FileScope,
	GitRunner,
	LinkEvidenceFileSystem,
	ScopeConfig,
	ScopeConfigRead,
} from "../fileScope.js";
import { CONFIG_FILE, runGit } from "../fileScope.js";
import type { GitRepository } from "../gitEvidence.js";
import { evidenceInputsFor, evidenceRevision, PolicyEvidence } from "../policyEvidence.js";
import { SecretPolicy } from "../secretPolicy.js";
import { sourceReader } from "../sourceRead.js";
import { IndexStore } from "../store.js";
import { fakeSupervisor } from "./fakeProvider.js";
import { gitAdd, gitCommit, gitInit, gitRmCached, gitSubmoduleAdd } from "./gitFixture.js";
import { TestLexiconService, testPolicy } from "./testPolicy.js";

////////////////////////////////
//  Types

////////////////////////////////
//  Fixtures

const roots: string[] = [];

function temporary(label: string): string {
	const root = mkdtempSync(path.join(tmpdir(), `lexicon-${label}-`));
	roots.push(root);
	return root;
}

function collected(root: string): CollectedScopeEvidence {
	const repository: GitRepository = {
		prefix: "",
		state: "ok",
		gitDir: path.join(root, ".git"),
		indexPath: path.join(root, ".git", "index"),
		tracked: new Set(["tracked.ts"]),
		links: new Set(),
		gitlinks: new Set(),
		untracked: new Set(),
		nested: new Set(),
		discovered: new Set(),
		undiscovered: new Set(),
		walkedLinks: new Set(),
		externals: [{ kind: "index", path: path.join(root, ".git", "index"), stamp: null }],
	};
	return {
		known: new Set(["tracked.ts"]),
		tracking: { kind: "tracked", files: new Set(["tracked.ts"]) },
		repositories: [repository],
		modules: new Set(["tracked.ts"]),
		links: new Map(),
		aliasesByTarget: new Map(),
		targets: new Map(),
		directoryLinks: new Map(),
		ignoredSecrets: new Set(),
		undiscovered: new Set(),
		entries: new Map([["", ["tracked.ts"]]]),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("policy evidence", () => {
	it("derives repository evidence inputs", () => {
		const root = temporary("evidence-revision");
		const read: ScopeConfigRead = { kind: "absent" };
		const config: ScopeConfig = {};
		const initial = collected(root);
		const baseline = evidenceInputsFor(initial, read, config, root);
		expect(baseline.map(({ kind }) => kind)).toEqual(["config", "repositories", "listing:", "ignored:", "links"]);
		expect(baseline.find(({ kind }) => kind === "config")?.subscriptions).toEqual([
			{ path: path.join(root, CONFIG_FILE), fingerprint: "missing" },
		]);
		expect(baseline.find(({ kind }) => kind === "listing:")?.subscriptions).toEqual([
			{ path: path.join(root, ".git", "index"), fingerprint: "missing" },
		]);
		expect(baseline.find(({ kind }) => kind === "ignored:")?.derivedAfter).toEqual(["config", "listing:"]);

		const changedConfig = { include: ["tracked.ts"] };
		const changedRead: ScopeConfigRead = { kind: "valid", config: changedConfig };
		const changedRepository = collected(root);
		changedRepository.repositories = [{ ...changedRepository.repositories[0]!, state: "failed" }];
		const changedListing = collected(root);
		changedListing.repositories = [
			{ ...changedListing.repositories[0]!, tracked: new Set(["tracked.ts", "other.ts"]) },
		];
		const changedIgnored = collected(root);
		changedIgnored.repositories = [{ ...changedIgnored.repositories[0]!, discovered: new Set(["ignored.env"]) }];
		const changedLinks = collected(root);
		changedLinks.aliasesByTarget = new Map([["target.ts", ["alias.ts"]]]);
		changedLinks.targets = new Map([["alias.ts", "target.ts"]]);
		const changedEvidence = new Map([
			["config", { collected: initial, read: changedRead, config: changedConfig }],
			["repositories", { collected: changedRepository, read, config }],
			["listing:", { collected: changedListing, read, config }],
			["ignored:", { collected: changedIgnored, read, config }],
			["links", { collected: changedLinks, read, config }],
		] as const);
		for (const [kind, evidence] of changedEvidence) {
			const next = evidenceInputsFor(evidence.collected, evidence.read, evidence.config, root);
			const beforeInput = baseline.find((input) => input.kind === kind);
			const afterInput = next.find((input) => input.kind === kind);
			if (beforeInput === undefined || afterInput === undefined) throw new Error(`missing ${kind} evidence`);
			expect(afterInput.digest, kind).not.toBe(beforeInput.digest);
			const feedsRevision = kind === "config" || kind === "repositories" || kind === "links";
			if (feedsRevision) expect(evidenceRevision(next)).not.toBe(evidenceRevision(baseline));
			else expect(evidenceRevision(next)).toBe(evidenceRevision(baseline));
			const isolated = baseline.map((input) =>
				input.kind === kind ? { ...input, digest: afterInput.digest } : input,
			);
			if (feedsRevision) {
				expect(evidenceRevision(baseline)).not.toBe(evidenceRevision(isolated));
				expect(evidenceRevision(baseline.filter((input) => input.kind !== kind))).toBe(
					evidenceRevision(isolated.filter((input) => input.kind !== kind)),
				);
			} else expect(evidenceRevision(isolated)).toBe(evidenceRevision(baseline));
		}
		const fixOnly = { fix: ["format", "--stdin"] };
		const fixInputs = evidenceInputsFor(initial, { kind: "valid", config: fixOnly }, fixOnly, root);
		expect(evidenceRevision(fixInputs)).toBe(evidenceRevision(baseline));
	});

	it("matches ignored discovery to untracked whole-file rules", () => {
		const policy = testPolicy(temporary("evidence-discovers"));
		for (const module of [
			".env",
			".ENV",
			"service/.env.local",
			"service/.ENV.PRODUCTION",
			"server.key",
			"plain.json",
		]) {
			const answer = policy.current.answer(module);
			expect(policy.discovers(module)).toBe(
				answer.kind === "wholeRedact" || (answer.kind === "omit" && answer.by === "secret"),
			);
		}
	});

	it("surfaces unfinished ignored walks in scope notes", async () => {
		const root = temporary("evidence-undiscovered");
		await gitInit(root);
		mkdirSync(path.join(root, "big"));
		for (let index = 0; index < 10; index++) writeFileSync(path.join(root, "big", `file-${index}.txt`), "");
		writeFileSync(path.join(root, "big", ".env"), "API_KEY=private\n");
		writeFileSync(path.join(root, ".gitignore"), "big/\n");
		const policy = SecretPolicy.initial({ root, walkBound: 5 });
		policy.attach({
			index: { installScope: () => {} },
			journal: { policyChanged: () => {} },
			providers: { policyChanged: () => {} },
		});
		await policy.refresh({ kind: "startup" });

		expect(policy.notes).toContain("undiscovered ignored folder: big");
	});

	it("revises the judge when a tracked secret path changes class", async () => {
		const root = temporary("evidence-tracking");
		await gitInit(root);
		writeFileSync(path.join(root, ".env"), "API_KEY=not-read-here\n");
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });
		const untrackedRevision = policy.current.revision;

		expect(policy.current.answer(".env").kind).toBe("wholeRedact");
		await gitAdd(root, ".env");
		const change = await policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });

		expect(change.moved).toBe(true);
		expect(policy.current.revision).not.toBe(untrackedRevision);
		expect(policy.current.answer(".env").kind).toBe("plain");
	});

	it("keeps its revision for a new path covered by an untracked rule", async () => {
		const root = temporary("evidence-module");
		await gitInit(root);
		const policy = testPolicy(root, { secrets: { "deploy.env": { "@untracked": "redact" } } });
		await policy.refresh({ kind: "startup" });
		const beforeRevision = policy.current.revision;
		expect(policy.current.answer("deploy.env").kind).toBe("wholeRedact");
		expect(policy.current.access("deploy.env")).toBe("bytes");

		writeFileSync(path.join(root, "deploy.env"), "API_KEY=not-read-here\n");
		const change = await policy.refresh({ kind: "startup" });

		expect(change.moved).toBe(false);
		expect(policy.current.revision).toBe(beforeRevision);
		expect(policy.current.answer("deploy.env").kind).toBe("wholeRedact");
		expect(policy.current.access("deploy.env")).toBe("bytes");
	});

	it("does not collect Git evidence for a content-only batch", async () => {
		const root = temporary("evidence-content-only");
		await gitInit(root);
		writeFileSync(path.join(root, "source.ts"), "export {};");
		await gitAdd(root, "source.ts");
		const runs: string[][] = [];
		const policy = testPolicy(root, undefined, undefined, (clock, cwd, args, options) => {
			runs.push([...args]);
			return runGit(clock, cwd, args, options);
		});
		await policy.refresh({ kind: "startup" });
		runs.length = 0;

		const change = await policy.refresh({
			kind: "events",
			modules: ["source.ts"],
			changed: ["source.ts"],
		});

		expect(runs).toEqual([]);
		expect(change.affected).toEqual({ modules: new Set(), prefixes: [] });
	});

	it("catches an index change while its event was unwatched", async () => {
		const root = temporary("evidence-index-fingerprint");
		await gitInit(root);
		writeFileSync(path.join(root, ".env"), "API_KEY=private\n");
		const runs: string[][] = [];
		const policy = testPolicy(root, undefined, undefined, (clock, cwd, args, options) => {
			runs.push([...args]);
			return runGit(clock, cwd, args, options);
		});
		await policy.refresh({ kind: "startup" });
		expect(policy.current.answer(".env").kind).toBe("wholeRedact");
		await gitAdd(root, ".env");
		runs.length = 0;

		const change = await policy.refresh({ kind: "events", modules: [] });

		expect(runs).toHaveLength(3);
		expect(policy.current.answer(".env").kind).toBe("plain");
		expect(change.affected === "all" ? false : change.affected.modules.has(".env")).toBe(true);
	});

	it("redacts a secret when the Git directory disappears", async () => {
		const root = temporary("evidence-no-git");
		await gitInit(root);
		writeFileSync(path.join(root, ".env"), "API_KEY=private\n");
		await gitAdd(root, ".env");
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });
		expect(policy.current.answer(".env").kind).toBe("plain");
		rmSync(path.join(root, ".git"), { recursive: true, force: true });

		await policy.refresh({ kind: "audit" });

		expect(policy.current.answer(".env").kind).toBe("wholeRedact");
	});

	it("adds a new untracked file without refreshing the listing", async () => {
		const root = temporary("evidence-untracked-event");
		await gitInit(root);
		const installed: { scope: FileScope | null } = { scope: null };
		const policy = SecretPolicy.initial({ root });
		policy.attach({
			index: { installScope: (scope) => (installed.scope = scope) },
			journal: { policyChanged: () => {} },
			providers: { policyChanged: () => {} },
		});
		await policy.refresh({ kind: "startup" });
		writeFileSync(path.join(root, "new.ts"), "export {};");

		const change = await policy.refresh({ kind: "events", modules: ["new.ts"], changed: ["new.ts"] });

		expect(change.affected === "all" ? false : change.affected.modules.has("new.ts")).toBe(true);
		expect(installed.scope?.known?.has("new.ts")).toBe(true);
	});

	it("installs a newly discovered ignored secret", async () => {
		const root = temporary("evidence-ignored-add");
		await gitInit(root);
		mkdirSync(path.join(root, "hidden"));
		writeFileSync(path.join(root, ".gitignore"), "hidden/\n");
		await gitAdd(root, ".gitignore");
		const installed: { scope: FileScope | null } = { scope: null };
		const policy = SecretPolicy.initial({ root });
		policy.attach({
			index: { installScope: (scope) => (installed.scope = scope) },
			journal: { policyChanged: () => {} },
			providers: { policyChanged: () => {} },
		});
		await policy.refresh({ kind: "startup" });
		writeFileSync(path.join(root, "hidden/.env.local"), "API_KEY=private\n");

		const change = await policy.refresh({ kind: "events", modules: [".gitignore"], evidence: ["listing:"] });

		expect(change.affected === "all" ? false : change.affected.modules.has("hidden/.env.local")).toBe(true);
		expect(installed.scope?.known?.has("hidden/.env.local")).toBe(true);
	});

	it("marks a newly added submodule prefix affected", async () => {
		const root = temporary("evidence-gitlink-parent");
		const child = temporary("evidence-gitlink-child");
		await gitInit(root);
		await gitInit(child);
		mkdirSync(path.join(root, "sub"));
		writeFileSync(path.join(root, "sub/source.ts"), "export {};\n");
		writeFileSync(path.join(child, "source.ts"), "export {};\n");
		await gitAdd(root, "sub/source.ts");
		await gitAdd(child, "source.ts");
		await gitCommit(child, "source");
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });
		await gitRmCached(root, "sub/source.ts");
		rmSync(path.join(root, "sub"), { recursive: true, force: true });
		await gitSubmoduleAdd(root, child, "sub");

		const change = await policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });

		expect(change.affected === "all" ? false : change.affected.prefixes).toContain("sub");
	});

	it("covers stale answer stamps across randomized evidence changes", async () => {
		const root = temporary("evidence-affected-oracle");
		await gitInit(root);
		mkdirSync(path.join(root, "vendor"), { recursive: true });
		mkdirSync(path.join(root, "vault"));
		writeFileSync(path.join(root, ".env"), "API_KEY=private\n");
		writeFileSync(path.join(root, "plain.env"), "NAME=value\n");
		writeFileSync(path.join(root, "vault/credentials.yaml"), "password: private\n");
		writeFileSync(
			path.join(root, "lexicon.json"),
			JSON.stringify({ include: ["vendor/**"], secrets: { "vault/**": { "@untracked": "redact" } } }),
		);
		symlinkSync(".env", path.join(root, "alias.env"));
		symlinkSync("vault", path.join(root, "vaultLink"));
		await gitAdd(root, ".env", "alias.env", "vault", "vaultLink", "lexicon.json");
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });
		const modules = [
			".env",
			"plain.env",
			"alias.env",
			"vault/credentials.yaml",
			"vaultLink/credentials.yaml",
			"vendor/.env",
		];
		const aliasStamp = policy.current.answer("alias.env").stamp;
		await gitRmCached(root, ".env");
		const change = await policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });
		expect(policy.current.answer("alias.env").stamp).not.toBe(aliasStamp);
		expect(change.affected === "all" ? false : change.affected.modules.has("alias.env")).toBe(true);
		let tracked = false;
		let aliasTargetsSecret = true;
		let denied = false;
		let nested = false;
		let directoryTracked = true;
		let random = 0x51f15e;
		const nextRandom = () => {
			random = (random * 1_664_525 + 1_013_904_223) >>> 0;
			return random;
		};
		const operations = ["track", "retarget", "config", "nested", "directory"];
		const covers = (change: Awaited<ReturnType<typeof policy.refresh>>, module: string) =>
			change.affected === "all" ||
			change.affected.modules.has(module) ||
			change.affected.prefixes.some((prefix) => prefix === "" || module.startsWith(`${prefix}/`));
		for (let index = 0; index < 24; index++) {
			const operation = operations[nextRandom() % operations.length];
			const before = new Map(modules.map((module) => [module, policy.current.answer(module).stamp]));
			let change: Awaited<ReturnType<typeof policy.refresh>>;
			if (operation === "track") {
				if (tracked) await gitRmCached(root, ".env");
				else await gitAdd(root, ".env");
				tracked = !tracked;
				change = await policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });
			} else if (operation === "retarget") {
				rmSync(path.join(root, "alias.env"));
				aliasTargetsSecret = !aliasTargetsSecret;
				symlinkSync(aliasTargetsSecret ? ".env" : "plain.env", path.join(root, "alias.env"));
				change = await policy.refresh({ kind: "events", modules: ["alias.env"], evidence: ["links"] });
			} else if (operation === "config") {
				denied = !denied;
				writeFileSync(
					path.join(root, "lexicon.json"),
					JSON.stringify({
						include: ["vendor/**"],
						secrets: { "vault/**": { "@untracked": "redact" } },
						deny: denied ? [".env"] : [],
					}),
				);
				change = await policy.refresh({ kind: "events", modules: ["lexicon.json"] });
			} else if (operation === "nested") {
				if (!nested) {
					mkdirSync(path.join(root, "vendor"), { recursive: true });
					await gitInit(path.join(root, "vendor"));
					writeFileSync(path.join(root, "vendor", ".env"), "API_KEY=nested\n");
					await gitAdd(path.join(root, "vendor"), ".env");
				} else rmSync(path.join(root, "vendor", ".git"), { recursive: true, force: true });
				nested = !nested;
				change = await policy.refresh({ kind: "events", modules: ["vendor/.git"], evidence: ["repositories"] });
			} else {
				if (directoryTracked) await gitRmCached(root, "vault/credentials.yaml");
				else await gitAdd(root, "vault/credentials.yaml");
				directoryTracked = !directoryTracked;
				change = await policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });
			}
			const oracle = testPolicy(root);
			await oracle.refresh({ kind: "startup" });
			const stale = modules.filter((module) => before.get(module) !== oracle.current.answer(module).stamp);
			for (const module of stale) expect(covers(change, module), `${operation}: ${module}`).toBe(true);
			if (operation === "directory") expect(stale).toContain("vaultLink/credentials.yaml");
		}
	});

	it("routes config, links, targets and new symlinks", async () => {
		const root = temporary("evidence-router");
		await gitInit(root);
		writeFileSync(path.join(root, "lexicon.json"), "{}");
		writeFileSync(path.join(root, "target.ts"), "export {};");
		writeFileSync(path.join(root, "ordinary.ts"), "export {};");
		writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
		mkdirSync(path.join(root, "ignored"));
		symlinkSync("target.ts", path.join(root, "alias.ts"));
		symlinkSync("../target.ts", path.join(root, "ignored/walked-alias.ts"));
		const evidence = new PolicyEvidence(root);
		await evidence.collect({ kind: "valid", config: {} }, {}, () => false);

		expect(evidence.inputsFor({ module: "lexicon.json" })).toContain("config");
		expect(evidence.inputsFor({ module: ".gitignore" })).toContain("listing:");
		expect(evidence.inputsFor({ module: "alias.ts" })).toContain("links");
		expect(evidence.inputsFor({ module: "target.ts" })).toContain("links");
		expect(evidence.inputsFor({ module: "ordinary.ts" })).not.toContain("links");
		symlinkSync("target.ts", path.join(root, "new-alias.ts"));
		expect(evidence.inputsFor({ module: "new-alias.ts" })).toContain("links");
		await evidence.collect({ kind: "valid", config: {} }, {}, () => false);

		expect(evidence.current()?.collected.links.get("new-alias.ts")).toEqual({
			kind: "file",
			target: "target.ts",
		});
		expect(evidence.current()?.collected.links.get("ignored/walked-alias.ts")).toEqual({
			kind: "file",
			target: "target.ts",
		});
	});

	it("answers directory link descendants through their target paths", async () => {
		const root = temporary("evidence-directory-links");
		await gitInit(root);
		mkdirSync(path.join(root, ".kube"));
		mkdirSync(path.join(root, "secrets"));
		writeFileSync(path.join(root, ".kube/config"), "apiVersion: v1\nkind: Config\n");
		writeFileSync(path.join(root, "secrets/app.json"), '{"password":"not indexed"}\n');
		writeFileSync(path.join(root, "lexicon.json"), JSON.stringify({ secrets: { "secrets/**": "redact" } }));
		symlinkSync(".kube", path.join(root, "kubelink"));
		symlinkSync("secrets", path.join(root, "cfg"));
		await gitAdd(root, "-A");
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });

		expect(policy.current.answer("kubelink/config").kind).toBe("wholeRedact");
		expect(policy.current.answer("cfg/app.json").kind).toBe("wholeRedact");
	});

	it("judges a retargeted read by its real path and marks links stale", async () => {
		const root = temporary("evidence-retargeted-link");
		await gitInit(root);
		writeFileSync(path.join(root, "ordinary.json"), '{"kind":"Other"}\n');
		writeFileSync(path.join(root, ".credentials.json"), '{"password":"private"}\n');
		symlinkSync("ordinary.json", path.join(root, "alias.json"));
		await gitAdd(root, "-A");
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });
		expect(policy.current.answer("alias.json").kind).toBe("matchers");

		rmSync(path.join(root, "alias.json"));
		symlinkSync(".credentials.json", path.join(root, "alias.json"));
		const read = sourceReader(root)("alias.json");
		const verdict = policy.current.verdict(read);

		expect(read.real).toBe(".credentials.json");
		expect(verdict.route).toBe("reader");
		expect(verdict.admission.as).toBe("keys");
		expect(policy.evidence.isStale("links")).toBe(true);
		expect(policy.evidence.inputsFor({ module: "ordinary.ts" })).toContain("links");
	});

	it("inspects only the fifty links in a five thousand file fixture", async () => {
		const root = temporary("evidence-link-counts");
		await gitInit(root);
		mkdirSync(path.join(root, "files"));
		mkdirSync(path.join(root, "aliases"));
		for (let index = 0; index < 4_950; index++)
			writeFileSync(path.join(root, "files", `file-${index}.ts`), "export {};\n");
		for (let index = 0; index < 50; index++)
			symlinkSync(`../files/file-${index}.ts`, path.join(root, "aliases", `link-${index}.ts`));
		await gitAdd(root, "-A");
		let lstats = 0;
		let realpaths = 0;
		const linkFs: LinkEvidenceFileSystem = {
			lstat(file) {
				lstats++;
				try {
					return lstatSync(file).isSymbolicLink() ? "link" : "other";
				} catch {
					return null;
				}
			},
			realpath(file) {
				realpaths++;
				try {
					return realpathSync.native(file);
				} catch {
					return null;
				}
			},
			isDirectory: (file) => statSync(file).isDirectory(),
		};
		const evidence = new PolicyEvidence(root, systemClock, undefined, undefined, linkFs);
		await evidence.collect({ kind: "absent" }, {}, () => false);

		expect(evidence.current()?.collected.links.size).toBe(50);
		expect(lstats).toBe(50);
		expect(realpaths).toBe(50);
	});

	it("rejects startup refresh before attachment", async () => {
		const policy = SecretPolicy.initial({ root: temporary("evidence-attach") });
		const failure = await rejection(policy.refresh({ kind: "startup" }));
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("secret policy consumers are not attached");
	});

	it("judges workspace denies and built-ins in the policy", async () => {
		const root = temporary("evidence-provider-deny");
		writeFileSync(path.join(root, "lexicon.json"), JSON.stringify({ deny: ["**/first-secret/**"] }));
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });

		expect(policy.current.access(".git/config")).toBe("closed");
		expect(policy.current.access("first-secret/file.ts")).toBe("closed");
		expect(policy.current.access("credentials.json")).toBe("bytes");
	});

	it("collects startup evidence once for twenty thousand files", async () => {
		const root = temporary("evidence-20k");
		await gitInit(root);
		for (let index = 0; index < 20_000; index++) writeFileSync(path.join(root, `file-${index}.ts`), "export {};");
		await gitAdd(root, "-A");
		const runs: string[][] = [];
		const countingRunner: GitRunner = (clock, cwd, args, options) => {
			runs.push([...args]);
			return runGit(clock, cwd, args, options);
		};
		const beforeEvidence = new PolicyEvidence(root, systemClock, countingRunner);
		const beforeStart = performance.now();
		for (let count = 0; count < 3; count++) await beforeEvidence.collect({ kind: "absent" }, {}, () => false);
		const beforeMs = performance.now() - beforeStart;
		const beforeRuns = runs.length;
		const runsPerCollection = beforeRuns / 3;
		runs.length = 0;
		const indexFile = path.join(temporary("evidence-store"), "index.sqlite");
		const store = IndexStore.open(indexFile, undefined, root).store;
		try {
			const policy = testPolicy(root, undefined, store, countingRunner);
			const service = new TestLexiconService(
				store,
				fakeSupervisor({ claims: [] }),
				sourceReader(root),
				root,
				systemClock,
				policy,
			);
			const afterStart = performance.now();
			await service.currentScope();
			const afterMs = performance.now() - afterStart;
			const afterRuns = runs.length;
			await service.currentScope();
			expect(runs.length).toBe(afterRuns);
			expect(beforeRuns).toBe(runsPerCollection * 3);
			expect(afterRuns).toBe(runsPerCollection);
			console.log(
				`Startup collection, 20k files: repeated ${beforeMs.toFixed(1)} ms / ${beforeRuns} git runs; single ${afterMs.toFixed(1)} ms / ${afterRuns} git runs`,
			);
		} finally {
			store.close();
		}
	});
});
