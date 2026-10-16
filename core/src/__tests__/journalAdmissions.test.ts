import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashBytes } from "@nyaa-lexicon/protocol";
import { installAdmissionTriggers, JOURNAL_TABLES, type JournalTable } from "../journalSchema.js";
import { IndexStore, SCHEMA_VERSION } from "../store.js";
import { TransactionManager } from "../transactions.js";
import { testPolicy } from "./testPolicy.js";

let root: string;
let file: string;
let store: IndexStore;

function image(module: string, text: string) {
	const result = testPolicy(root).admitBytes(module, Buffer.from(text));
	if (result.kind !== "admitted") throw new Error("test image was withheld");
	return result.value;
}

function addImageReference(module: string, hash: string): void {
	store.journalWrite((db) => {
		db.prepare(
			`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash)
			 VALUES ('txn', 'baseline', 0, ?, 1, ?)`,
		).run(module, hash);
	});
}

function missingAdmissionTriggers(): string[] {
	const triggers = new Set(
		store.journalRead((db) =>
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map(
				({ name }) => name,
			),
		),
	);
	return Object.entries(JOURNAL_TABLES).flatMap(([table, item]) => {
		const entry: JournalTable = item;
		const direct = (entry.hashes?.columns ?? []).flatMap((column) =>
			["insert", "update"].flatMap((operation) => {
				const trigger = `${table}_${column}_admission_${operation}`;
				return triggers.has(trigger) ? [] : [trigger];
			}),
		);
		const json = (entry.jsonHashes ?? []).flatMap(({ column }) =>
			["insert", "update"].flatMap((operation) => {
				const trigger = `${table}_${column}_json_admission_${operation}`;
				return triggers.has(trigger) ? [] : [trigger];
			}),
		);
		return [...direct, ...json];
	});
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-journal-admissions-"));
	file = path.join(root, "index.sqlite");
	store = IndexStore.open(file).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("journal admissions", () => {
	it("stores admitted bytes and their row atomically", () => {
		const admitted = image("src/a.ts", "export const a = 1;\n");
		store.putBlob(admitted);

		expect(store.heldImage(admitted.module, admitted.hash)).toEqual({
			module: admitted.module,
			hash: admitted.hash,
			stamp: null,
			bytes: Buffer.from("export const a = 1;\n"),
		});
		expect(store.admissions()).toEqual([{ module: admitted.module, hash: admitted.hash, stamp: null }]);
	});

	it("indexes admission rows by hash", () => {
		const indexes = store.journalRead((db) =>
			(db.prepare("PRAGMA index_list(refactor_admissions)").all() as Array<{ name: string }>).map(
				({ name }) => name,
			),
		);

		expect(indexes).toContain("refactor_admissions_hash");
	});

	it("rolls back an admission when its blob write fails", () => {
		const admitted = image("src/a.ts", "export const a = 1;\n");
		store.journalWrite((db) =>
			db.exec(
				`CREATE TRIGGER refuse_blob BEFORE INSERT ON refactor_blobs BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
			),
		);

		expect(() => store.putBlob(admitted)).toThrow();
		expect(store.heldImage(admitted.module, admitted.hash)).toBeNull();
	});

	it("returns no image without admission and returns null bytes for an admitted image without a blob", () => {
		const policy = testPolicy(root);
		const bytes = Buffer.from("export const a = 1;\n");
		const hash = hashBytes(bytes);
		const empty = policy.confirm({ module: "src/a.ts", hash, stamp: null }, () => {
			throw new Error("same stamp must not load");
		});
		if (empty.kind !== "admitted") throw new Error("plain admission was withheld");
		store.admit(empty.value);

		expect(store.heldImage("src/missing.ts", hash)).toBeNull();
		expect(store.heldImage("src/a.ts", hash)).toEqual({ module: "src/a.ts", hash, stamp: null, bytes: null });
	});

	it("restamps a row after a moved policy stamp", () => {
		const policy = testPolicy(root);
		const bytes = Buffer.from("kind: ConfigMap\ndata:\n  token: placeholder\n");
		const hash = hashBytes(bytes);
		const original = policy.admitBytes("deploy.yaml", bytes);
		if (original.kind !== "admitted") throw new Error("plain image was withheld");
		store.admit(original.value);

		const nextPolicy = testPolicy(root);
		const confirmed = nextPolicy.confirm(original.value, () => bytes);
		if (confirmed.kind !== "admitted") throw new Error("plain image was withheld");
		expect(confirmed.value.stamp).not.toBe(original.value.stamp);
		expect(store.restamp(confirmed.value)).toBe(true);
		expect(store.heldImage("deploy.yaml", hash)?.stamp).toBe(confirmed.value.stamp);
	});

	it("finds missing admissions and prunes rows outside retained references", () => {
		const kept = image("src/kept.ts", "export const kept = 1;\n");
		const stale = image("src/stale.ts", "export const stale = 1;\n");
		const retained = testPolicy(root).confirm({ module: "src/old.ts", hash: "old-opened", stamp: null }, () => {
			throw new Error("a plain admission must not load");
		});
		if (retained.kind !== "admitted") throw new Error("expected a retained journal admission");
		const settled = testPolicy(root).confirm({ module: "src/old.ts", hash: "old-settled", stamp: null }, () => {
			throw new Error("a plain admission must not load");
		});
		if (settled.kind !== "admitted") throw new Error("expected a settled journal admission");
		store.putBlob(kept);
		store.putBlob(stale);
		store.admit(retained.value);
		store.admit(settled.value);
		addImageReference(kept.module, kept.hash);
		store.journalWrite((db) => {
			db.exec("DROP TRIGGER refactor_images_beforeHash_admission_insert");
			db.prepare(
				`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash)
				 VALUES ('txn', 'baseline', 0, 'src/unadmitted.ts', 1, 'missing-hash')`,
			).run();
			installAdmissionTriggers(db);
		});
		store.journalWrite((db) =>
			db
				.prepare(
					"INSERT INTO refactor_settled_files (seq, module, opened, settled) VALUES (999, 'src/old.ts', 'old-opened', 'old-settled')",
				)
				.run(),
		);

		expect(store.unadmittedReferences()).toEqual([{ module: "src/unadmitted.ts", hash: "missing-hash" }]);
		store.journalWrite((db) => db.prepare("DELETE FROM refactor_images WHERE module = ?").run(stale.module));
		store.journalWrite((db) => store.pruneAdmissionsWithin(db));
		expect(store.admissions()).toEqual([
			{ module: kept.module, hash: kept.hash, stamp: null },
			{ module: retained.value.module, hash: retained.value.hash, stamp: null },
			{ module: settled.value.module, hash: settled.value.hash, stamp: null },
		]);
	});

	it("installs insert and update guards for every registered image hash", () => {
		expect(missingAdmissionTriggers()).toEqual([]);

		const hashes = JOURNAL_TABLES.refactor_images.hashes;
		if (hashes === undefined) throw new Error("image hash registry is missing");
		const columns = hashes.columns as unknown as string[];
		store.journalWrite((db) => db.exec("ALTER TABLE refactor_images ADD COLUMN plantedHash TEXT"));
		columns.push("plantedHash");
		try {
			expect(missingAdmissionTriggers()).toContain("refactor_images_plantedHash_admission_insert");
		} finally {
			columns.pop();
		}
	});

	it("aborts a raw insert without an admission", () => {
		expect(() =>
			store.journalWrite((db) =>
				db
					.prepare(
						`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash)
						 VALUES ('txn', 'baseline', 0, 'src/blocked.ts', 1, 'missing-admission')`,
					)
					.run(),
			),
		).toThrow();
		expect(() =>
			store.journalWrite((db) =>
				db.prepare("INSERT INTO refactor_blobs (hash, bytes) VALUES (?, ?)").run("raw", Buffer.from("raw")),
			),
		).toThrow();
	});

	it("finds and purges hashes copied into client step JSON", () => {
		const stepHash = "legacy-client-step-hash";
		const answer = JSON.stringify({ files: [{ module: "src/private.yaml", before: null, after: stepHash }] });
		store.journalWrite((db) => {
			db.exec("DROP TRIGGER refactor_client_steps_answer_json_admission_insert");
			db.exec("DROP TRIGGER refactor_client_steps_answer_json_admission_update");
			db.prepare(
				"INSERT INTO refactor_client_steps (stepId, kind, state, answer, recordedAt) VALUES (?, 'move', 'answered', ?, 1)",
			).run("legacy-step", answer);
		});

		expect(store.unadmittedReferences()).toEqual([{ module: "src/private.yaml", hash: stepHash }]);
		expect(store.purgeImages([{ module: "src/private.yaml", hash: stepHash }])).toBe(1);
		const purged = store.journalRead((db) =>
			db.prepare("SELECT answer FROM refactor_client_steps WHERE stepId = ?").get("legacy-step"),
		) as { answer: string };

		expect(JSON.parse(purged.answer)).toEqual({
			files: [{ module: "src/private.yaml", before: null, after: null }],
		});
		expect(store.unadmittedReferences()).toEqual([]);
	});

	it("rejects a client step with an unadmitted JSON hash", () => {
		expect(() =>
			store.journalWrite((db) =>
				db
					.prepare(
						"INSERT INTO refactor_client_steps (stepId, kind, state, answer, recordedAt) VALUES (?, 'move', 'answered', ?, 1)",
					)
					.run("unadmitted-step", JSON.stringify({ files: [{ module: "src/a.yaml", after: "missing" }] })),
			),
		).toThrow();
		expect(() =>
			store.journalWrite((db) =>
				db
					.prepare(
						"INSERT INTO refactor_recovery_intents (transactionId, operation, diskStates) VALUES (?, 'revert', ?)",
					)
					.run(
						"unadmitted-recovery",
						JSON.stringify([{ module: "src/a.yaml", kind: "file", hash: "missing" }]),
					),
			),
		).toThrow();
	});

	it("finds and removes hashes copied into recovery JSON", () => {
		const recoveryHash = "legacy-recovery-hash";
		store.journalWrite((db) => {
			db.exec("DROP TRIGGER refactor_recovery_intents_diskStates_json_admission_insert");
			db.exec("DROP TRIGGER refactor_recovery_intents_diskStates_json_admission_update");
			db.prepare(
				"INSERT INTO refactor_recovery_intents (transactionId, operation, diskStates) VALUES (?, 'revert', ?)",
			).run(
				"legacy-recovery",
				JSON.stringify([{ module: "src/private.yaml", kind: "file", hash: recoveryHash }]),
			);
		});

		expect(store.unadmittedReferences()).toEqual([{ module: "src/private.yaml", hash: recoveryHash }]);
		store.purgeImages([{ module: "src/private.yaml", hash: recoveryHash }]);
		const purged = store.journalRead((db) =>
			db
				.prepare("SELECT diskStates FROM refactor_recovery_intents WHERE transactionId = ?")
				.get("legacy-recovery"),
		) as { diskStates: string };

		expect(JSON.parse(purged.diskStates)).toEqual([]);
		expect(store.unadmittedReferences()).toEqual([]);
	});

	it("purges pre-admission rows after reopen without backfill admission", () => {
		const originalPolicy = testPolicy(root, undefined, store);
		const original = new TransactionManager(store, root, originalPolicy);
		const started = original.start();
		if (!started.started) throw new Error("test transaction did not start");
		const module = "src/legacy.ts";
		const bytes = Buffer.from("export const legacy = 1;\n");
		const hash = hashBytes(bytes);
		store.journalWrite((db) => {
			const triggers = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_admission_%'")
				.all() as Array<{ name: string }>;
			for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
			db.prepare("INSERT INTO refactor_blobs (hash, bytes) VALUES (?, ?)").run(hash, bytes);
			db.prepare(
				`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash)
				 VALUES (?, 'baseline', 0, ?, 1, ?)`,
			).run(started.id, module, hash);
		});

		store.close();
		store = IndexStore.open(file).store;
		const known = store.journalRead((db) =>
			db
				.prepare("SELECT contentHash FROM refactor_known_states WHERE transactionId = ? AND module = ?")
				.get(started.id, module),
		);
		const reopened = new TransactionManager(store, root, testPolicy(root, undefined, store));

		expect(known).toBeUndefined();
		expect(reopened.beforeImage(module)).toMatchObject({ tracked: false, reason: expect.any(String) });
		expect(store.unadmittedReferences()).toEqual([{ module, hash }]);
		expect(reopened.readmit()).toEqual({ purged: 1 });
		expect(store.unadmittedReferences()).toEqual([]);
		expect(reopened.beforeImage(module)).toEqual({ tracked: false });
	});

	it("salvages admission rows and blobs through a store rebuild", () => {
		const admitted = image("src/a.ts", "export const a = 1;\n");
		store.putBlob(admitted);
		store.journalWrite((db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
		store.close();

		const opened = IndexStore.open(file);
		store = opened.store;
		expect(opened.rebuilt).toBe(true);
		expect(store.heldImage(admitted.module, admitted.hash)).toEqual({
			module: admitted.module,
			hash: admitted.hash,
			stamp: null,
			bytes: Buffer.from("export const a = 1;\n"),
		});
	});
});
