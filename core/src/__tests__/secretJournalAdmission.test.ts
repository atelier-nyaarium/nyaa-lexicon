import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SECRET_SYNTAX_VERSION } from "@nyaa-lexicon/formats/secret";
import { hashBytes, hashContent } from "@nyaa-lexicon/protocol";
import { runGit } from "../fileScope.js";
import { SETTLED_IMAGES_KEPT } from "../journalSchema.js";
import type { SecretPolicyConfig } from "../secretPolicy.js";
import { SecretPolicy } from "../secretPolicy.js";
import { sourceReadBytes } from "../sourceRead.js";
import { underClientStep } from "../stepRunners.js";
import { IndexStore } from "../store.js";
import { TransactionManager } from "../transactions.js";
import { gitAdd, gitInit, gitRmCached } from "./gitFixture.js";
import { testPolicy } from "./testPolicy.js";

const roots: string[] = [];
const stores: IndexStore[] = [];

function temporary(): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-secret-journal-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(config?: Partial<SecretPolicyConfig>, git = false) {
	const root = temporary();
	const store = IndexStore.open(path.join(root, "index.sqlite")).store;
	stores.push(store);
	if (config !== undefined && git)
		store.rememberSecretPolicy({ secrets: config.secrets ?? {}, deny: [...(config.deny ?? [])] });
	const policy = git ? testPolicy(root, undefined, store, runGit) : testPolicy(root, config);
	const journal = new TransactionManager(store, root, policy);
	policy.attach({
		index: { installScope: () => {} },
		journal,
		providers: { policyChanged: () => {} },
	});
	return { root, store, policy, journal };
}

function write(root: string, module: string, text: string): void {
	const file = path.join(root, module);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function configured(module: string): Partial<SecretPolicyConfig> {
	return { secrets: { [`**/${module}`]: { password: "redact" } } };
}

function viewHash(policy: SecretPolicy, module: string, bytes: Uint8Array): string {
	const view = policy.current.view(sourceReadBytes(module, bytes));
	if (!("hash" in view)) throw new Error("expected a text view hash");
	return view.hash;
}

describe("journal byte admission", () => {
	it("admits raw non-text bytes under a plain answer without decoding", () => {
		const policy = testPolicy(temporary());
		const bytes = new Uint8Array([0, 255, 1]);
		const result = policy.admitBytes("src/a.ts", bytes);

		expect(result.kind).toBe("admitted");
		if (result.kind !== "admitted") return;
		expect(result.value).toMatchObject({ module: "src/a.ts", hash: hashBytes(bytes), stamp: null, bytes });
	});

	it("withholds a Secret document and admits a Deployment under matcher rules", () => {
		const policy = testPolicy(temporary());
		const secret = Buffer.from("kind: Secret\ndata:\n  token: PRIVATE_FIXTURE_VALUE\n");
		const deployment = Buffer.from("kind: Deployment\nmetadata:\n  name: sample\n");
		const withheld = policy.admitBytes("secret.yaml", secret);
		const admitted = policy.admitBytes("deployment.yaml", deployment);

		expect(withheld).toMatchObject({ kind: "withheld" });
		expect(JSON.stringify(withheld)).not.toContain("PRIVATE_FIXTURE_VALUE");
		expect(admitted.kind).toBe("admitted");
	});

	it("withholds omitted and denied modules", () => {
		const policy = testPolicy(temporary(), {
			secrets: { "**/private.json": "omit" },
			deny: ["denied/**"],
		});
		const bytes = Buffer.from('{"name":"sample"}');

		expect(policy.admitBytes("private.json", bytes).kind).toBe("withheld");
		expect(policy.admitBytes("denied/a.ts", bytes).kind).toBe("withheld");
	});

	it("confirms an unchanged stamp without loading bytes", () => {
		const policy = testPolicy(temporary());
		const admitted = policy.admitBytes("deploy.yaml", Buffer.from("kind: Deployment\n"));
		if (admitted.kind !== "admitted") throw new Error("test image was withheld");
		let loads = 0;
		const confirmed = policy.confirm(admitted.value, () => {
			loads++;
			return null;
		});

		expect(confirmed.kind).toBe("admitted");
		expect(loads).toBe(0);
	});

	it("stamps guarded matches with the judge and syntax version", () => {
		const policy = SecretPolicy.initial({
			root: temporary(),
			judge: "judge-v1",
			store: {
				lastSecretPolicy: () => ({ secrets: { "**/manifest.yaml": { password: "redact" } }, deny: [] }),
				rememberSecretPolicy: () => {},
			},
		});
		const answer = policy.current.answer("manifest.yaml");
		const result = policy.admitBytes("manifest.yaml", Buffer.from("kind: Deployment\n"));

		expect(answer.stamp).not.toBeNull();
		expect(result.kind).toBe("admitted");
		if (result.kind !== "admitted") return;
		expect(result.value.stamp).toBe(hashContent(JSON.stringify(["judge-v1", SECRET_SYNTAX_VERSION, answer.stamp])));
	});

	it("withholds a moved stamp when its image is unavailable", () => {
		const policy = testPolicy(temporary());
		let loads = 0;
		const confirmed = policy.confirm({ module: "deploy.yaml", hash: "known-image", stamp: "old-stamp" }, () => {
			loads++;
			return null;
		});

		expect(confirmed.kind).toBe("withheld");
		expect(loads).toBe(1);
	});

	it("confirms held bytes only for the same hash and a plain verdict", () => {
		const policy = testPolicy(temporary());
		const bytes = Buffer.from("kind: Deployment\n");
		const stored = { module: "deploy.yaml", hash: hashBytes(bytes), stamp: "old-stamp" };
		const confirmed = policy.confirmHeld(stored, bytes);
		const otherPlain = Buffer.from("kind: ConfigMap\n");
		const secret = Buffer.from("kind: Secret\ndata:\n  token: PRIVATE_FIXTURE_VALUE\n");
		const mismatched = policy.confirmHeld(stored, otherPlain);
		const guarded = policy.confirmHeld(
			{ module: "secret.yaml", hash: hashBytes(secret), stamp: "old-stamp" },
			secret,
		);

		expect(confirmed.kind).toBe("admitted");
		expect(mismatched.kind).toBe("withheld");
		expect(guarded.kind).toBe("withheld");
	});
});

describe("journal views", () => {
	it("reports an indexed guarded edit with its masked-view hash", () => {
		const { root, store, policy, journal } = fixture(configured("settings.json"));
		const before = '{"public":"before"}\n';
		const secret = Buffer.from('{"password":"INDEXED_DRIFT_SECRET"}\n');
		write(root, "settings.json", before);
		journal.start();
		expect(journal.track("settings.json").tracked).toBe(true);
		store.replaceFile({
			module: "settings.json",
			contentHash: hashContent(before),
			admission: policy.current.admission(sourceReadBytes("settings.json", Buffer.from(before))),
			declarations: [],
			references: [],
		});
		writeFileSync(path.join(root, "settings.json"), secret);

		const drift = journal.status().drifted.find(({ module }) => module === "settings.json");
		const expected = viewHash(policy, "settings.json", secret);

		expect(drift?.contentHash).toBe(expected);
		expect(drift?.contentHash).not.toBe(hashBytes(secret));
		expect(drift?.contentHash).not.toBe(hashBytes(Buffer.from(before)));
		expect(JSON.stringify(journal.status())).not.toContain("INDEXED_DRIFT_SECRET");
	});

	it("reports an ignored journal-only guarded edit with its masked-view hash", async () => {
		const { root, store, policy, journal } = fixture(configured("journal-only.yaml"), true);
		await gitInit(root);
		write(root, ".gitignore", "journal-only.yaml\n");
		await gitAdd(root, ".gitignore");
		await policy.refresh({ kind: "startup" });
		const before = "public: before\n";
		const secret = Buffer.from("password: IGNORED_DRIFT_SECRET\n");
		write(root, "journal-only.yaml", before);
		journal.start();
		expect(journal.track("journal-only.yaml").tracked).toBe(true);
		expect(store.contentHashOf("journal-only.yaml")).toBeNull();
		const repository = policy.evidence.current()?.collected.repositories[0];
		expect(repository?.untracked.has("journal-only.yaml")).toBe(false);
		writeFileSync(path.join(root, "journal-only.yaml"), secret);

		const drift = journal.status().drifted.find(({ module }) => module === "journal-only.yaml");
		const expected = viewHash(policy, "journal-only.yaml", secret);

		expect(drift?.contentHash).toBe(expected);
		expect(drift?.contentHash).not.toBe(hashBytes(secret));
		expect(drift?.contentHash).not.toBe(hashBytes(Buffer.from(before)));
		expect(JSON.stringify(journal.status())).not.toContain("IGNORED_DRIFT_SECRET");
	});

	it("keeps tsconfig settlement rows after their blobs leave retention", () => {
		const { root, store, journal } = fixture(configured("tsconfig.json"));
		const text = '{"compilerOptions":{}}\n';
		write(root, "tsconfig.json", text);
		journal.start();
		expect(journal.track("tsconfig.json").tracked).toBe(true);
		expect(journal.commit().committed).toBe(true);
		const hash = hashBytes(Buffer.from(text));

		for (let sequence = 0; sequence < SETTLED_IMAGES_KEPT; sequence++) {
			const module = `plain-${sequence}.ts`;
			write(root, module, `export const value = ${sequence};\n`);
			journal.start();
			journal.track(module);
			expect(journal.commit().committed).toBe(true);
		}
		store.pruneBlobs();
		expect(journal.readmit().purged).toBe(0);

		expect(store.heldImage("tsconfig.json", hash)?.bytes).toBeNull();
		expect(journal.settlements(0, 64).settlements[0]?.files.map(({ module }) => module)).toEqual(["tsconfig.json"]);
	});

	it("purges an untracked env image and does not revive it after git add", async () => {
		const { root, store, policy, journal } = fixture(undefined, true);
		await gitInit(root);
		const text = "TOKEN=placeholder\n";
		write(root, ".env", text);
		await gitAdd(root, ".env");
		await policy.refresh({ kind: "startup" });
		expect(policy.current.answer(".env").kind).toBe("plain");
		journal.start();
		expect(journal.track(".env").tracked).toBe(true);
		expect(journal.commit().committed).toBe(true);
		const hash = hashBytes(Buffer.from(text));
		expect(store.heldImage(".env", hash)?.bytes).not.toBeNull();

		await gitRmCached(root, ".env");
		const removalChange = await policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });
		policy.policyChanged(removalChange);
		expect(journal.settlements(0).settlements[0]?.files).toEqual([]);
		expect(store.heldImage(".env", hash)).toBeNull();

		await gitAdd(root, ".env");
		const additionChange = await policy.refresh({ kind: "events", modules: [], evidence: ["listing:"] });
		policy.policyChanged(additionChange);
		expect(policy.current.answer(".env").kind).toBe("plain");
		expect(journal.settlements(0).settlements[0]?.files).toEqual([]);
	});

	it("refuses a stale image in memory and purges it on readmit", () => {
		const { root, store } = fixture();
		const module = "settings.json";
		const secret = '{"password":"STALE_IMAGE_SECRET"}\n';
		write(root, module, secret);
		const originalPolicy = testPolicy(root);
		const original = new TransactionManager(store, root, originalPolicy);
		originalPolicy.attach({
			index: { installScope: () => {} },
			journal: original,
			providers: { policyChanged: () => {} },
		});
		original.start();
		expect(original.track(module).tracked).toBe(true);
		const hash = hashBytes(Buffer.from(secret));
		const nextPolicy = testPolicy(root, configured(module));
		const next = new TransactionManager(store, root, nextPolicy);
		nextPolicy.attach({
			index: { installScope: () => {} },
			journal: next,
			providers: { policyChanged: () => {} },
		});

		expect(next.beforeImage(module)).toMatchObject({ tracked: false, reason: expect.any(String) });
		expect(store.heldImage(module, hash)?.bytes).toEqual(Buffer.from(secret));
		expect(next.readmit().purged).toBeGreaterThan(0);
		expect(store.heldImage(module, hash)).toBeNull();
	});

	it("completes a guarded after-image without storing its bytes", () => {
		const { root, store, policy, journal } = fixture(configured("settings.json"));
		const before = '{"public":"before"}\n';
		const secret = Buffer.from('{"password":"FIX_AFTER_IMAGE_SECRET"}\n');
		write(root, "settings.json", before);
		journal.start();
		journal.track("settings.json");
		const begun = journal.beginStep("replace", ["settings.json"]);
		if (!begun.ok) throw new Error(begun.reason);
		writeFileSync(path.join(root, "settings.json"), secret);

		expect(journal.restampAfter(begun.stepNo, "settings.json")).toBe("guarded");
		journal.completeStep(begun.stepNo, "written");
		journal.completeStep(begun.stepNo, "finalized");
		const masked = viewHash(policy, "settings.json", secret);

		expect(journal.status().steps).toContainEqual({
			stepNo: begun.stepNo,
			kind: "replace",
			phase: "finalized",
			modules: ["settings.json"],
		});
		expect(store.heldImage("settings.json", hashBytes(secret))).toBeNull();
		expect(store.heldImage("settings.json", masked)?.bytes).toBeNull();
		expect(JSON.stringify(journal.status())).not.toContain("FIX_AFTER_IMAGE_SECRET");
		expect(journal.commit().committed).toBe(true);
		expect(journal.settlements(0).settlements[0]?.files[0]).toMatchObject({
			module: "settings.json",
			settled: masked,
			drifted: { contentHash: masked },
		});
		expect(masked).not.toBe(hashBytes(Buffer.from(before)));
	});

	it("purges copied client-step hashes when a file becomes guarded", async () => {
		const { root, store, policy, journal } = fixture();
		await policy.refresh({ kind: "startup" });
		journal.readmit();
		const before = "kind: ConfigMap\nmetadata:\n  name: old\n";
		const bytes = Buffer.from("token: CLIENT_STEP_TRANSITION_SECRET\n");
		write(root, "private.yaml", before);
		journal.start();
		expect(journal.track("private.yaml").tracked).toBe(true);
		const begun = journal.beginStep("move", ["private.yaml"], undefined, [
			{ module: "private.yaml", text: bytes.toString("utf8") },
		]);
		if (!begun.ok) throw new Error("plain output was not journaled");
		writeFileSync(path.join(root, "private.yaml"), bytes);
		journal.completeStep(begun.stepNo, "written");
		journal.completeStep(begun.stepNo, "reindexed");
		journal.completeStep(begun.stepNo, "finalized");
		const files = journal.stepFiles(begun.stepNo);
		if (!journal.commit({ force: true }).committed) throw new Error("plain refactor did not settle");
		const rawHash = hashBytes(bytes);
		const answer = await underClientStep(journal, "client-step-transition", "move", async () => ({
			committed: true,
			kind: "move",
			symbolId: "fixture-symbol",
			files,
			forwarded: [],
			reverse: { kind: "move", symbolId: "fixture-symbol", toModule: "old.yaml" },
			issues: [],
		}));
		expect(answer.committed).toBe(true);
		expect(JSON.stringify(answer)).toContain(rawHash);

		write(root, "lexicon.json", JSON.stringify({ secrets: { "**/private.yaml": "redact" } }));
		const change = await policy.refresh({ kind: "events", modules: ["lexicon.json"], changed: ["lexicon.json"] });
		policy.policyChanged(change);

		const outcome = journal.stepOutcome("client-step-transition");
		const persisted = store.journalRead((db) =>
			db.prepare("SELECT answer FROM refactor_client_steps WHERE stepId = ?").get("client-step-transition"),
		) as { answer: string };
		expect(JSON.stringify(outcome)).not.toContain(rawHash);
		expect(persisted.answer).not.toContain(rawHash);
		expect(store.heldImage("private.yaml", rawHash)).toBeNull();
		expect(store.unadmittedReferences()).toEqual([]);
	});

	it("treats a guarded recovery path as a conflict", () => {
		const { root, journal } = fixture(configured("settings.json"));
		write(root, "settings.json", '{"public":"before"}\n');
		journal.start();
		journal.track("settings.json");
		const begun = journal.beginStep("replace", ["settings.json"]);
		if (!begun.ok) throw new Error(begun.reason);
		const secret = '{"password":"RECOVERY_CONFLICT_SECRET"}\n';
		write(root, "settings.json", secret);
		journal.completeStep(begun.stepNo, "written");

		const recovered = journal.recover();

		expect(recovered.conflicts).toEqual(["settings.json"]);
		expect(readFileSync(path.join(root, "settings.json"), "utf8")).toBe(secret);
		expect(JSON.stringify(recovered)).not.toContain("RECOVERY_CONFLICT_SECRET");
	});

	it("blocks restoring an image whose bytes are missing", () => {
		const { root, store, journal } = fixture();
		const module = "settings.json";
		const before = Buffer.from('{"public":"before"}\n');
		const after = '{"public":"after"}\n';
		writeFileSync(path.join(root, module), before);
		journal.start();
		journal.track(module);
		const begun = journal.beginStep("replace", [module], undefined, [{ module, text: after }]);
		if (!begun.ok) throw new Error(begun.reason);
		writeFileSync(path.join(root, module), after);
		journal.completeStep(begun.stepNo, "written");
		store.journalWrite((db) => db.prepare("DELETE FROM refactor_blobs WHERE hash = ?").run(hashBytes(before)));

		const undone = journal.undo();

		expect(undone.undone).toBe(false);
		expect(readFileSync(path.join(root, module), "utf8")).toBe(after);
		expect(journal.openTransaction()).not.toBeNull();
	});
});
