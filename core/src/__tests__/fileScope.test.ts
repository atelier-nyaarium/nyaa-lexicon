import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globToRegExp } from "@nyaa-lexicon/protocol";
import type { FileScope, GitRunner, ScopeConfig } from "../fileScope";
import {
	describeScope,
	discoverSubmodules,
	generatedVerdicts,
	gitIgnored,
	includedFiles,
	isExternalModule,
	runGit,
	submoduleRoots,
} from "../fileScope";
import { watchWorkspace } from "../watcher";
import { fakeClock } from "./fakeClock";
import { gitAdd, gitClone, gitCommit, gitConfig, gitInit, gitSubmoduleAdd, gitSubmoduleUpdate } from "./gitFixture";
import { hashOfRead } from "./reads";
import { testPolicy } from "./testPolicy";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function write(root: string, module: string, text = "x\n") {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

async function policyScope(root: string, config?: ScopeConfig, runGit?: GitRunner) {
	if (config !== undefined) write(root, "lexicon.json", JSON.stringify(config));
	const policy = testPolicy(root, undefined, undefined, runGit);
	const installed: { scope: FileScope | null } = { scope: null };
	policy.attach({
		index: { installScope: (scope) => (installed.scope = scope) },
		journal: { policyChanged: () => {} },
		providers: { policyChanged: () => {} },
	});
	await policy.refresh({ kind: "startup" });
	if (installed.scope === null) throw new Error("expected the policy to install a scope");
	return { policy, scope: installed.scope };
}

/** A real repository, because the whole point is that git answers rather than we do. */
async function repo(files: Record<string, string>, ignore?: string): Promise<string> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-"));
	roots.push(root);
	await gitInit(root);
	for (const [module, text] of Object.entries(files)) write(root, module, text);
	if (ignore !== undefined) write(root, ".gitignore", ignore);
	return root;
}

/** A second, separately committed repository, so it can be added as a real submodule of another. */
async function submoduleSource(): Promise<string> {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-submodule-src-"));
	roots.push(root);
	await gitInit(root);
	write(root, "inner.txt");
	await gitAdd(root, "inner.txt");
	await gitCommit(root, "seed");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("globs", () => {
	it("keeps * inside one segment and lets ** cross them", () => {
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
		expect(globToRegExp("src/**/*.ts").test("src/deep/a.ts")).toBe(true);
	});

	it("matches the directory itself, so dist/** covers dist", () => {
		expect(globToRegExp("dist/**").test("dist/main.js")).toBe(true);
		expect(globToRegExp("dist/**").test("dist")).toBe(true);
	});

	it("treats a dot as a dot rather than as any character", () => {
		expect(globToRegExp("a.ts").test("axts")).toBe(false);
	});
});

describe("what git ignores", () => {
	it("names the ignored paths among those asked, and only those", async () => {
		const root = await repo({ "src/a.ts": "" }, "volumes/\n");
		write(root, "volumes/state.json", "{}");
		expect(await gitIgnored(root, ["volumes/state.json", "src/new.ts"])).toEqual(new Set(["volumes/state.json"]));
	});

	// git exits 1 for "none ignored", which is an answer and not a failure.
	it("answers an empty set when nothing asked is ignored", async () => {
		const root = await repo({ "src/a.ts": "" });
		expect(await gitIgnored(root, ["src/a.ts", "src/new.ts"])).toEqual(new Set());
	});

	it("cannot say outside a repository, rather than guessing", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-"));
		roots.push(root);
		expect(await gitIgnored(root, ["a.ts"])).toBeNull();
	});
});

describe("what git says belongs to the project", () => {
	it("lists the project's tracked and untracked files", async () => {
		const root = await repo({ "src/a.ts": "", "notes.txt": "" });
		const { scope } = await policyScope(root);

		expect(scope.known?.has("src/a.ts")).toBe(true);
		expect(scope.known?.has("notes.txt")).toBe(true);
	});

	/**
	 * The measurement that motivated all of this.
	 *
	 * One real repository had 350 files git knew about and 136,333 on disk, because a devcontainer
	 * mounts a home directory inside it. Without this the index describes somebody else's plugins
	 * while looking like it describes yours.
	 */
	it("keeps ignored non-secret files out and discovers ignored secrets", async () => {
		const root = await repo(
			{ "src/a.ts": "", "volumes/home/plugin.py": "", ".env": "SECRET=1", "server.key": "PRIVATE" },
			"volumes/\n.env\nserver.key\n",
		);
		const { policy, scope } = await policyScope(root);

		expect(scope.known?.has("src/a.ts")).toBe(true);
		expect(scope.known?.has("volumes/home/plugin.py")).toBe(false);
		expect(scope.known?.has(".env")).toBe(true);
		expect(scope.known?.has("server.key")).toBe(true);
		expect(scope.denies("server.key")).toBe(false);
		expect(scope.allows("server.key")).toBe(true);
		expect(policy.current.answer("server.key")).toMatchObject({ kind: "omit", by: "secret" });
	});

	it("never runs the fsmonitor command a repository's own config names", async () => {
		const root = await repo({ "src/a.ts": "" });
		const marker = path.join(root, "..", `${path.basename(root)}-fsmonitor-ran`);
		roots.push(marker);
		write(root, "fsmonitor.sh", `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
		chmodSync(path.join(root, "fsmonitor.sh"), 0o755);
		await gitConfig(root, "core.fsmonitor", path.join(root, "fsmonitor.sh"));

		const { scope } = await policyScope(root);
		expect(scope.known?.has("src/a.ts")).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	it("uses walk mode outside a repository", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-nogit-"));
		roots.push(root);
		const { scope } = await policyScope(root);
		expect(scope.mode).toBe("walk");
		expect(scope.known).toBeNull();
	});
});

describe("the scoping rule", () => {
	it("recognizes dependency and outside-workspace modules", async () => {
		const root = await repo({ "src/a.ts": "" });

		expect(isExternalModule(root, "src/a.ts")).toBe(false);
		expect(isExternalModule(root, "node_modules/pkg/index.d.ts")).toBe(true);
		expect(isExternalModule(root, "packages/node_modules_helper.ts")).toBe(false);
		expect(isExternalModule(root, "../outside.ts")).toBe(true);
	});

	it("reads generated declarations from git attributes", async () => {
		const root = await repo({
			".gitattributes": "generated/** linguist-generated\n",
			"generated/a.ts": "",
			"src/a.ts": "",
		});

		expect(await generatedVerdicts(root, ["generated/a.ts", "src/a.ts"])).toEqual(
			new Map([
				["generated/a.ts", { status: "yes" }],
				["src/a.ts", { status: "no" }],
			]),
		);
	});

	it("reads an attribute set to false as not generated, the way linguist does", async () => {
		const root = await repo({
			".gitattributes": "generated/** linguist-generated\ngenerated/keep.ts linguist-generated=false\n",
			"generated/a.ts": "",
			"generated/keep.ts": "",
		});

		expect(await generatedVerdicts(root, ["generated/a.ts", "generated/keep.ts"])).toEqual(
			new Map([
				["generated/a.ts", { status: "yes" }],
				["generated/keep.ts", { status: "no" }],
			]),
		);
	});

	it("answers unknown with the reason when there is no git to ask", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-nogit-"));
		try {
			expect(await generatedVerdicts(root, ["src/a.ts"])).toEqual(
				new Map([["src/a.ts", { status: "unknown", reason: "noGit" }]]),
			);
			expect(await generatedVerdicts(root, [])).toEqual(new Map());
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets an explicit include override an exclude", async () => {
		const root = await repo({ "generated/a.ts": "", "src/a.ts": "" });
		const { scope } = await policyScope(root, { include: ["generated/**"], exclude: ["generated/**"] });

		expect(scope.allows("generated/a.ts")).toBe(true);
		expect(scope.allows("src/a.ts")).toBe(true);
	});

	it("keeps a tracked conditional omission plain", async () => {
		const root = await repo({ ".env.local": "API_KEY=value\n" });
		await gitAdd(root, ".env.local");
		const { policy, scope } = await policyScope(root, {
			secrets: { "**/.env*": { "@untracked": "omit" } },
		});

		expect(scope.denies(".env.local")).toBe(false);
		expect(scope.allows(".env.local")).toBe(true);
		expect(policy.current.access(".env.local")).toBe("open");
	});

	it("lets deny, its own and the built-in `.git`, override an explicit include", async () => {
		const root = await repo({ "reference/a.ts": "", "src/a.ts": "" });
		const { scope } = await policyScope(root, { include: ["reference/**", ".git/**"], deny: ["reference/**"] });

		expect(scope.allows("reference/a.ts")).toBe(false);
		expect(scope.denies("reference/a.ts")).toBe(true);
		expect(scope.denies("src/a.ts")).toBe(false);
		expect([".git/config", "vendor/lib/.git/HEAD", ".github/ci.yml"].map((module) => scope.denies(module))).toEqual(
			[true, true, false],
		);
	});

	it("marks only configured bundle globs for surface indexing", async () => {
		const root = await repo({ "opaque/runtime.js": "", "src/a.js": "" });
		const { scope } = await policyScope(root, { bundles: ["opaque/**"] });

		expect(scope.surface("opaque/runtime.js")).toBe(true);
		expect(scope.surface("src/a.js")).toBe(false);
	});

	it("refuses an ignored file to auto-discovery", async () => {
		const root = await repo({ "src/a.ts": "", "dist/built.js": "" }, "dist/\n");
		const { scope } = await policyScope(root, {});

		expect(scope.mode).toBe("git");
		expect(scope.allows("src/a.ts")).toBe(true);
		expect(scope.allows("dist/built.js")).toBe(false);
	});

	// Ignore governs DISCOVERY, not reachability. Naming a path explicitly is the whole point of
	// naming it, so it wins over the ignore that would otherwise hide it.
	it("allows an ignored file that was named explicitly", async () => {
		const root = await repo({ "src/a.ts": "", "dist/built.js": "" }, "dist/\n");
		const { scope } = await policyScope(root, { include: ["dist/**"] });

		expect(scope.allows("dist/built.js")).toBe(true);
	});

	/**
	 * Permitting is not indexing.
	 *
	 * A provider's own discovery decides what exists, and a TypeScript one reads its tsconfig, which
	 * is exactly the list that omits the build output somebody is pointing at. Measured on a real
	 * bundle: allowing `dist/**` indexed nothing until includes ADDED candidates, after which one
	 * bundled file contributed 4,111 symbols.
	 */
	it("finds included files itself rather than waiting to be offered them", async () => {
		const root = await repo({ "src/a.ts": "", "dist/bundle.js": "", "dist/deep/more.js": "" }, "dist/\n");

		expect(includedFiles(root, ["dist/**"]).sort()).toEqual(["dist/bundle.js", "dist/deep/more.js"]);
	});

	it("walks only where a glob could match, so one include never walks the world", async () => {
		const root = await repo({ "dist/bundle.js": "", "elsewhere/huge.js": "" });
		expect(includedFiles(root, ["dist/**"])).toEqual(["dist/bundle.js"]);
	});

	it("finds nothing when nothing was included, rather than everything", async () => {
		expect(includedFiles(await repo({ "src/a.ts": "" }), [])).toEqual([]);
	});

	// Walk mode is weaker and says so, rather than presenting itself as the same guarantee.
	it("allows everything outside a repository, and reports that it is doing so", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-nogit-"));
		roots.push(root);
		const { scope } = await policyScope(root, {});

		expect(scope.mode).toBe("walk");
		expect(scope.allows("anything/at/all.ts")).toBe(true);
		expect(describeScope(scope)).toContain("no git repository");
	});
});

describe("a command that never answers", () => {
	/**
	 * The reap and cap machinery itself lives in, and is proven by, boundedChild.test.ts. This is
	 * runGit's own mapping: a fake clock drives the same timeout road runGit hands it, and a
	 * non-exited BoundedResult, whichever kind, answers null.
	 */
	it("answers null when the clock's timeout fires before a wedged child exits", async () => {
		const clock = fakeClock();
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-hang-"));
		roots.push(root);
		let reaped = false;

		const call = runGit(clock, root, ["999"], {
			command: "sleep",
			onSpawn: (child) => {
				child.once("close", () => {
					reaped = true;
				});
			},
		});

		clock.advance(60_000);
		const result = await call;

		expect(result).toBeNull();
		expect(reaped).toBe(true);
	});

	it("answers within the timeout for a command that exits cleanly, not only for one that hangs", async () => {
		const clock = fakeClock();
		const root = mkdtempSync(path.join(tmpdir(), "lexicon-scope-quick-"));
		roots.push(root);

		const result = await runGit(clock, root, ["0"], { command: "sleep" });

		expect(result).toEqual({ code: 0, stdout: "" });
	});
});

describe("submodules", () => {
	it("finds initialized nested gitlinks and treats a non-Git workspace as complete", async () => {
		const leaf = await submoduleSource();
		const nested = await repo({ "src/nested.ts": "" });
		await gitSubmoduleAdd(nested, leaf, "leaf");
		await gitAdd(nested, "-A");
		await gitCommit(nested, "nested");
		const root = await repo({ "src/root.ts": "" });
		await gitSubmoduleAdd(root, nested, "nested");
		await gitSubmoduleUpdate(root);
		const nestedRoot = path.join(root, "nested");
		const leafRoot = path.join(nestedRoot, "leaf");

		expect(await discoverSubmodules(root)).toEqual({
			roots: [nestedRoot, leafRoot].map((candidate) => path.resolve(candidate)).sort(),
			complete: true,
		});
		const plain = mkdtempSync(path.join(tmpdir(), "lexicon-not-git-"));
		roots.push(plain);
		expect(await discoverSubmodules(plain)).toEqual({ roots: [], complete: true });
	});

	/**
	 * `git check-ignore --stdin` and `check-attr --stdin` refuse a pathspec reaching into a
	 * submodule, and the refusal is of the WHOLE batch: git saw exactly this, `fatal: Pathspec
	 * '...' is in submodule '...'`, over a path this scope reader's own includes walked into.
	 */
	it("lists a submodule's own root, and nothing beneath it", async () => {
		const source = await submoduleSource();
		const root = await repo({ "src/a.ts": "" });
		await gitSubmoduleAdd(root, source, "sub");

		expect(await submoduleRoots(root)).toEqual(new Set(["sub"]));
	});

	it("keeps submodule paths out of the parent evidence", async () => {
		const source = await submoduleSource();
		const root = await repo({});
		await gitSubmoduleAdd(root, source, "sub");
		await gitCommit(root, "add submodule");
		const calls: string[] = [];
		const countingGit: GitRunner = (clock, cwd, args, options) => {
			calls.push(`${cwd}:${args[0]}`);
			return runGit(clock, cwd, args, options);
		};
		const { policy, scope } = await policyScope(root, { include: ["sub/**"] }, countingGit);
		const collected = policy.evidence.current()?.collected;

		expect(collected?.repositories.map(({ prefix }) => prefix)).toEqual([""]);
		expect(collected?.repositories[0]?.gitlinks).toEqual(new Set(["sub"]));
		expect(collected?.modules.has("sub/inner.txt")).toBe(false);
		expect(scope.known?.has("sub/inner.txt")).toBe(false);
		expect(scope.allows("sub/inner.txt")).toBe(false);
		expect(scope.cause("sub/inner.txt")).toBe("nestedProject");
		expect(scope.cause("sub", true)).toBe("nestedProject");
		expect(calls).toHaveLength(3);
		expect(calls.every((call) => call.startsWith(`${root}:`))).toBe(true);
	});

	it("uses an included standalone repository's own tracking", async () => {
		const root = await repo({});
		const nested = path.join(root, "vendor/lib");
		write(root, "vendor/lib/.env", "API_KEY=private\n");
		await gitInit(nested);
		await gitAdd(nested, ".env");

		const included = await policyScope(root, { include: ["vendor/lib/**"] });
		const excluded = await policyScope(root, {});

		expect(included.policy.evidenceInputs.map(({ kind }) => kind)).toContain("listing:vendor/lib");
		expect(included.scope.known?.has("vendor/lib/.env")).toBe(true);
		expect(included.policy.current.answer("vendor/lib/.env").kind).toBe("plain");
		expect(included.scope.allows("vendor/lib/.env")).toBe(true);
		expect(excluded.scope.known?.has("vendor/lib/.env")).toBe(false);
		expect(excluded.scope.cause("vendor/lib/.env")).toBe("nestedProject");
		expect(excluded.policy.current.answer("vendor/lib/.env").kind).toBe("wholeRedact");
	});

	it("treats an included repository that cannot answer as untracked", async () => {
		const root = await repo({});
		const nested = path.join(root, "vendor/lib");
		write(root, "vendor/lib/.env", "API_KEY=private\n");
		await gitInit(nested);
		writeFileSync(path.join(nested, ".git", "index"), "not an index");

		const { policy, scope } = await policyScope(root, { include: ["vendor/lib/**"] });
		const repository = policy.evidence
			.current()
			?.collected.repositories.find(({ prefix }) => prefix === "vendor/lib");

		expect(repository?.state).toBe("failed");
		expect(scope.known?.has("vendor/lib/.env")).toBe(false);
		expect(policy.current.answer("vendor/lib/.env").kind).toBe("wholeRedact");
	});

	it("keeps an included repository's gitlinks outside its scope", async () => {
		const source = await submoduleSource();
		const root = await repo({});
		const nested = path.join(root, "vendor/lib");
		mkdirSync(nested, { recursive: true });
		await gitInit(nested);
		await gitSubmoduleAdd(nested, source, "sub");
		await gitCommit(nested, "add submodule");

		const { policy, scope } = await policyScope(root, { include: ["vendor/lib/**"] });
		const repositories = policy.evidence.current()?.collected.repositories;

		expect(repositories?.map(({ prefix }) => prefix)).toEqual(["", "vendor/lib"]);
		expect(scope.known?.has("vendor/lib/sub/inner.txt")).toBe(false);
		expect(scope.allows("vendor/lib/sub/inner.txt")).toBe(false);
	});

	it("revises only for tracked secret paths and link topology", async () => {
		const root = await repo({ "src/config.json": "{}\n", "plain.ts": "export {};\n" });
		await gitAdd(root, "src/config.json", "plain.ts");
		const { policy: initialPolicy } = await policyScope(root, {});

		write(root, "unrelated.ts", "export {};\n");
		await gitAdd(root, "unrelated.ts");
		const { policy: unrelatedPolicy } = await policyScope(root, {});
		expect(unrelatedPolicy.current.revision).toBe(initialPolicy.current.revision);

		symlinkSync("config.json", path.join(root, "src/credentials.json"));
		await gitAdd(root, "src/credentials.json");
		const { policy: linkedPolicy } = await policyScope(root, {});
		expect(linkedPolicy.current.revision).not.toBe(unrelatedPolicy.current.revision);
		expect(linkedPolicy.current.answer("src/config.json").kind).toBe("wholeRedact");
	});

	it("subscribes to the absolute index path named by a submodule root", async () => {
		const source = await submoduleSource();
		write(source, ".gitignore", ".env.local\n");
		await gitAdd(source, ".gitignore");
		await gitCommit(source, "ignore local env");
		const parent = await repo({});
		await gitSubmoduleAdd(parent, source, "sub");
		await gitCommit(parent, "add submodule");
		const root = path.join(parent, "sub");
		write(root, ".env.local", "API_KEY=private\n");
		const { policy } = await policyScope(root, {});
		const gitFile = readFileSync(path.join(root, ".git"), "utf8").trim();
		const gitDirectory = gitFile.replace(/^gitdir: /, "");
		const submoduleIndex = path.resolve(root, gitDirectory, "index");
		const subscriptions = policy.evidence.subscriptions();
		expect(subscriptions.some(({ path: subscribed }) => subscribed === submoduleIndex)).toBe(true);
		expect(policy.evidence.current()?.collected.ignoredSecrets).toContain(".env.local");

		let notified: (() => void) | undefined;
		const changed = new Promise<void>((resolve) => {
			notified = resolve;
		});
		const watcher = watchWorkspace({
			workspaceRoot: root,
			debounceMs: 5,
			scope: {
				subscriptions: () => subscriptions,
				onSubscriptionsChanged: () => () => {},
				watchesModule: () => false,
				admits: () => true,
				ignored: async () => new Set(),
			},
			hash: hashOfRead,
			onBatch: (_files, evidence) => {
				if (evidence.includes("listing:")) notified?.();
			},
		});
		write(root, "trigger.ts");
		await gitAdd(root, "trigger.ts");
		const observed = await Promise.race([
			changed.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
		]);
		watcher.stop();
		expect(observed).toBe(true);
	});

	it("answers the rest of a batch correctly when one path reaches into a submodule", async () => {
		const source = await submoduleSource();
		const root = await repo({ "src/a.ts": "" }, "build/\n");
		write(root, "build/output.js");
		await gitSubmoduleAdd(root, source, "sub");

		const ignored = await gitIgnored(root, ["sub/inner.txt", "src/a.ts", "build/output.js"]);

		expect(ignored).not.toBeNull();
		expect(ignored?.has("build/output.js")).toBe(true);
		expect(ignored?.has("src/a.ts")).toBe(false);
		expect(ignored?.has("sub/inner.txt")).toBe(false);
	});

	it("never sends git a path that reaches into a submodule, answering it not ignored", async () => {
		const source = await submoduleSource();
		const root = await repo({}, "*.txt\n");
		await gitSubmoduleAdd(root, source, "sub");

		// "*.txt" would match inner.txt's own name if it ever reached git; not ignored proves it
		// never did, since this scope reader answers a path under a submodule without asking.
		const ignored = await gitIgnored(root, ["sub/inner.txt"]);

		expect(ignored?.has("sub/inner.txt")).toBe(false);
	});

	it("answers generated verdicts too, a path inside a submodule always not generated", async () => {
		const source = await submoduleSource();
		const root = await repo({
			".gitattributes": "generated/** linguist-generated\n",
			"generated/a.ts": "",
			"src/a.ts": "",
		});
		await gitSubmoduleAdd(root, source, "sub");

		const verdicts = await generatedVerdicts(root, ["sub/inner.txt", "generated/a.ts", "src/a.ts"]);

		expect(verdicts.get("generated/a.ts")).toEqual({ status: "yes" });
		expect(verdicts.get("src/a.ts")).toEqual({ status: "no" });
		expect(verdicts.get("sub/inner.txt")).toEqual({ status: "no" });
	});

	it("treats a path two levels under a submodule the same as one, a nested submodule included", async () => {
		const innermost = await submoduleSource();
		const middle = await submoduleSource();
		await gitSubmoduleAdd(middle, innermost, "innersub");
		await gitAdd(middle, "-A");
		await gitCommit(middle, "add inner submodule");
		const root = await repo({ "src/a.ts": "" });
		await gitSubmoduleAdd(root, middle, "sub");

		// ls-files --stage never descends into a gitlink, so the outer repo's own index names only
		// "sub", whatever submodules "sub" itself nests further in.
		expect(await submoduleRoots(root)).toEqual(new Set(["sub"]));

		const ignored = await gitIgnored(root, ["sub/innersub/inner.txt", "src/a.ts"]);
		expect(ignored?.has("sub/innersub/inner.txt")).toBe(false);
		expect(ignored?.has("src/a.ts")).toBe(false);
	});

	it("does not mistake a path merely sharing a root's name for one inside it", async () => {
		const source = await submoduleSource();
		const root = await repo({ "subdir/x.ts": "" }, "subdir/\n");
		await gitSubmoduleAdd(root, source, "sub");

		// "subdir/x.ts" is genuinely ignored by its own pattern, never by sharing "sub" as a prefix.
		const ignored = await gitIgnored(root, ["subdir/x.ts", "sub/inner.txt"]);
		expect(ignored?.has("subdir/x.ts")).toBe(true);
		expect(ignored?.has("sub/inner.txt")).toBe(false);
	});

	it("answers a path under an uninitialized gitlink the same way, its directory empty on disk", async () => {
		const source = await submoduleSource();
		const origin = await repo({ "src/a.ts": "" });
		await gitSubmoduleAdd(origin, source, "sub");
		await gitAdd(origin, "-A");
		await gitCommit(origin, "add submodule");

		const clonedRoot = mkdtempSync(path.join(tmpdir(), "lexicon-clone-"));
		roots.push(clonedRoot);
		await gitClone(origin, clonedRoot);

		// The gitlink is in the clone's index, but nothing was checked out beneath it.
		expect(await submoduleRoots(clonedRoot)).toEqual(new Set(["sub"]));
		const ignored = await gitIgnored(clonedRoot, ["sub/inner.txt", "src/a.ts"]);
		expect(ignored).not.toBeNull();
		expect(ignored?.has("sub/inner.txt")).toBe(false);
		expect(ignored?.has("src/a.ts")).toBe(false);
	});

	it("recognizes a path under a submodule however its separators are spelled", async () => {
		const source = await submoduleSource();
		const root = await repo({}, "*.txt\n");
		await gitSubmoduleAdd(root, source, "sub");

		// Unnormalized, "sub\inner.txt" fails to match root "sub" and is sent to git as a literal
		// filename, which "*.txt" then matches; normalized, it is recognized as under "sub" and
		// never asked at all.
		const ignored = await gitIgnored(root, ["sub\\inner.txt"]);
		expect(ignored?.has("sub\\inner.txt")).toBe(false);
	});
});

describe("secret configuration fallback", () => {
	it("keeps the last valid policy until a new config parses", async () => {
		const root = await repo({});
		write(root, "lexicon.json", JSON.stringify({ secrets: { "**/private.json": "omit" } }));
		const policy = testPolicy(root);
		await policy.refresh({ kind: "startup" });
		const firstConfig = policy.config;
		write(root, "lexicon.json", JSON.stringify({ secrets: { "**/*.json": { "@unknown": "omit" } } }));
		await policy.refresh({ kind: "events", modules: ["lexicon.json"] });

		expect(policy.config.secrets).toEqual(firstConfig.secrets);
		expect(policy.notes[0]).toContain("last valid secret rules are active");
		expect(policy.current.access("private.json")).toBe("closed");

		write(root, "lexicon.json", JSON.stringify({ secrets: { "**/*.{yaml,}": "redact" } }));
		await policy.refresh({ kind: "events", modules: ["lexicon.json"] });
		expect(policy.config.secrets).toEqual(firstConfig.secrets);
		expect(policy.notes[0]).toContain('"**/*.{yaml,}"');

		const replacement = { secrets: { "**/credentials.json": "omit" } } as const;
		write(root, "lexicon.json", JSON.stringify(replacement));
		await policy.refresh({ kind: "events", modules: ["lexicon.json"] });
		expect(policy.config.secrets).toEqual(replacement.secrets);
	});

	it("adopts a new deny beside invalid secrets", async () => {
		const root = await repo({});
		write(root, "lexicon.json", JSON.stringify({ secrets: { "**/private.json": "omit" } }));
		const policy = testPolicy(root);
		const installed: { scope: FileScope | null } = { scope: null };
		policy.attach({
			index: { installScope: (scope) => (installed.scope = scope) },
			journal: { policyChanged: () => {} },
			providers: { policyChanged: () => {} },
		});
		await policy.refresh({ kind: "startup" });
		const secrets = policy.config.secrets;
		write(root, "lexicon.json", JSON.stringify({ deny: ["private/**"], secrets: { "**/*.{yaml,}": "redact" } }));
		await policy.refresh({ kind: "events", modules: ["lexicon.json"] });
		if (installed.scope === null) throw new Error("expected the policy to install a scope");

		expect(policy.notes[0]).toContain("last valid secret rules are active");
		expect({
			deny: policy.config.deny,
			secrets: policy.config.secrets,
			denied: installed.scope.denies("private/a.txt"),
			kept: installed.scope.denies("private.json"),
		}).toEqual({ deny: ["private/**"], secrets, denied: true, kept: false });
	});
});
