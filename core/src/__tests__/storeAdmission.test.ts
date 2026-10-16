import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../database";
import type { AdmittedAs, SecretAdmission } from "../secretPolicy";
import { IndexStore } from "../store";
import { owesTruncate, PURGE_RETRY_MS } from "../storePurge";
import { admit, failed, failPlain, writePlain } from "./admissions";
import { type FakeClock, fakeClock } from "./fakeClock";
import { testPolicy } from "./testPolicy";

/** Admission changes can owe WAL truncation. Readers defer blocked truncates. */

////////////////////////////////
//  Helpers

type Held = "plain" | "plainStamped" | "keys" | "masked" | "withheld";

type Next = "plain" | "plainStamped" | "plainMoved" | "keys" | "masked" | "withheld" | "omit";

const STAMP = "stamp-1";
const MOVED = "stamp-2";
const WITHHELD = failed("secret file; details withheld");

let root: string;
let file: string;
let clock: FakeClock;
let store: IndexStore;
let reader: Database;

/** Module state's held admission. */
const NEXT: Record<Next, (module: string) => SecretAdmission> = {
	plain: (module) => admit(module),
	plainStamped: (module) => admit(module, "plain", STAMP),
	plainMoved: (module) => admit(module, "plain", MOVED),
	keys: (module) => admit(module, "keys", STAMP),
	masked: (module) => admit(module, "masked", STAMP),
	withheld: (module) => admit(module, "withheld", STAMP),
	omit: (module) => admit(module, "omit", "omit"),
};

/** State rows: facts or withheld failure. */
const HOLD: Record<Held, (module: string) => void> = {
	plain: (module) => writePlain(store, { module, contentHash: "h", declarations: [], references: [] }),
	plainStamped: (module) => replace(module, "plain", STAMP),
	keys: (module) => replace(module, "keys", STAMP),
	masked: (module) => replace(module, "masked", STAMP),
	withheld: (module) => store.recordFailure(module, WITHHELD, admit(module, "withheld", STAMP)),
};

/** Checks whether state changes require truncation. */
const ARMS: Record<Held, Record<Next, boolean>> = {
	plain: {
		plain: false,
		plainStamped: true,
		plainMoved: true,
		keys: true,
		masked: true,
		withheld: true,
		omit: true,
	},
	plainStamped: {
		plain: true,
		plainStamped: false,
		plainMoved: true,
		keys: true,
		masked: true,
		withheld: true,
		omit: true,
	},
	keys: {
		plain: false,
		plainStamped: false,
		plainMoved: false,
		keys: false,
		masked: false,
		withheld: false,
		omit: false,
	},
	masked: {
		plain: false,
		plainStamped: false,
		plainMoved: false,
		keys: false,
		masked: false,
		withheld: false,
		omit: false,
	},
	withheld: {
		plain: false,
		plainStamped: false,
		plainMoved: false,
		keys: false,
		masked: false,
		withheld: false,
		omit: false,
	},
};

const HELD = Object.keys(ARMS) as Held[];

const NEXTS = Object.keys(NEXT) as Next[];

function replace(module: string, as: AdmittedAs, stamp: string): void {
	store.replaceFile({
		module,
		contentHash: "h",
		declarations: [],
		references: [],
		admission: admit(module, as, stamp),
	});
}

function hold(): void {
	reader.exec("BEGIN");
	reader.prepare("SELECT COUNT(*) FROM files").get();
}

/** Releases the reader, then checks retry. */
function settle(): void {
	reader.exec("COMMIT");
	clock.advance(PURGE_RETRY_MS);
}

const owed = () => store.purgeState().pending;

/** Counts commits. */
function countCommits(target: IndexStore): { count: () => number } {
	const db = (target as unknown as { db: Database }).db;
	const exec = db.exec.bind(db);
	let commits = 0;
	db.exec = (sql: string) => {
		if (sql === "COMMIT") commits++;
		exec(sql);
	};
	return { count: () => commits };
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-store-admission-"));
	file = path.join(root, "index.sqlite");
	clock = fakeClock();
	store = IndexStore.open(file, undefined, undefined, clock).store;
	// Blocked checkpoints skip the busy timeout.
	store.journalWrite((db) => db.exec("PRAGMA busy_timeout = 0"));
	reader = Database.open(file, { readOnly: true });
});

afterEach(() => {
	reader.close();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("when removing a held row owes the log a truncate", () => {
	it("follows the table for the rule itself", () => {
		const rows = HELD.flatMap((held) =>
			NEXTS.map((next) => {
				const stamp = held === "plain" ? null : STAMP;
				const as = held === "plain" || held === "plainStamped" ? null : held;
				return [held, next, owesTruncate({ stamp, admittedAs: as }, NEXT[next]("m"))] as const;
			}),
		);

		expect(rows.filter(([held, next, owes]) => owes !== ARMS[held][next])).toEqual([]);
	});

	it("reads a row with no recorded admission as plain", () => {
		expect(owesTruncate({ stamp: null, admittedAs: null }, admit("m", "keys", STAMP))).toBe(true);
		expect(owesTruncate({ stamp: null, admittedAs: null }, admit("m"))).toBe(false);
	});

	for (const held of HELD) {
		it(`arms a forget of a ${held} module exactly as the table says`, () => {
			const armed: Partial<Record<Next, boolean>> = {};
			for (const next of NEXTS) {
				const module = `data/${held}-${next}.json`;
				HOLD[held](module);
				hold();
				store.forgetFile(module, NEXT[next](module));
				armed[next] = owed();
				settle();
				expect(owed(), `${next} left a debt behind once the reader left`).toBe(false);
			}

			expect(armed).toEqual(ARMS[held]);
		});
	}

	it("arms a replace of plain rows by a guarded admission, and not by a plain one", () => {
		HOLD.plain("a.env");
		HOLD.plain("b.env");
		hold();
		writePlain(store, { module: "a.env", contentHash: "h2", declarations: [], references: [] });
		const plainReplace = owed();
		replace("b.env", "keys", STAMP);

		expect({ plainReplace, guardedReplace: owed() }).toEqual({ plainReplace: false, guardedReplace: true });
		settle();
	});

	it("arms a replace of a plain failure by facts under a moved stamp", () => {
		failPlain(store, "a.json", "broke near the value");
		hold();
		replace("a.json", "plain", MOVED);

		expect(owed()).toBe(true);
		settle();
	});

	it("arms a failure record over a plain failure that turns guarded, and not over a guarded one", () => {
		failPlain(store, "a.json", "broke near the value");
		failPlain(store, "b.json", "broke too");
		store.recordFailure("c.json", WITHHELD, admit("c.json", "withheld", STAMP));
		hold();
		failPlain(store, "a.json", "broke again");
		const plainOverPlain = owed();
		store.recordFailure("c.json", WITHHELD, admit("c.json", "withheld", STAMP));
		const guardedOverGuarded = owed();
		store.recordFailure("b.json", WITHHELD, admit("b.json", "withheld", STAMP));

		expect({ plainOverPlain, guardedOverGuarded, plainOverGuarded: owed() }).toEqual({
			plainOverPlain: false,
			guardedOverGuarded: false,
			plainOverGuarded: true,
		});
		settle();
	});

	it("arms clearing a plain failure under a guarded admission, and not under the same plain one", () => {
		failPlain(store, "a.json", "broke near the value");
		failPlain(store, "b.json", "broke too");
		hold();
		store.clearFailure("a.json", admit("a.json"));
		const same = owed();
		store.clearFailure("b.json", admit("b.json", "keys", STAMP));

		expect({ same, guarded: owed() }).toEqual({ same: false, guarded: true });
		settle();
	});

	it("treats a store written before the column existed as holding plain rows", () => {
		HOLD.plain("a.json");
		failPlain(store, "b.json", "broke near the value");
		store.close();
		const old = Database.open(file);
		old.exec("ALTER TABLE files DROP COLUMN admittedAs");
		old.exec("ALTER TABLE parse_failures DROP COLUMN admittedAs");
		old.close();
		store = IndexStore.open(file, undefined, undefined, clock).store;
		hold();
		store.forgetFile("a.json", admit("a.json", "keys", STAMP));

		expect(owed()).toBe(true);
		settle();
	});

	it("refuses an admission given for another module", () => {
		HOLD.plain("a.json");

		expect(() => store.forgetFile("a.json", admit("b.json"))).toThrow();
		expect(() => store.recordFailure("a.json", failed("reason"), admit("b.json"))).toThrow();
		expect(() => store.clearFailure("a.json", admit("b.json"))).toThrow();
		expect(() =>
			store.replaceFile({
				module: "a.json",
				contentHash: "h",
				declarations: [],
				references: [],
				admission: admit("b.json"),
			}),
		).toThrow();
		expect(store.contentHashOf("a.json")).toBe("h");
	});
});

describe("deleting many plain files", () => {
	const MODULES = Array.from({ length: 100 }, (_, index) => `data/${index}.json`);

	it("arms nothing and commits once when each was written under the stamp it leaves", async () => {
		for (const module of MODULES) replace(module, "plain", STAMP);
		hold();
		const commits = countCommits(store);

		await store.pass(async () => {
			for (const module of MODULES) store.forgetFile(module, admit(module, "plain", STAMP));
		});

		expect({ commits: commits.count(), owed: owed(), left: store.indexedFiles().length }).toEqual({
			commits: 1,
			owed: false,
			left: 0,
		});
		settle();
	});

	it("arms once, in the same commit, when each leaves for a guarded admission", async () => {
		for (const module of MODULES) replace(module, "plain", STAMP);
		hold();
		const commits = countCommits(store);

		await store.pass(async () => {
			for (const module of MODULES) store.forgetFile(module, admit(module, "keys", STAMP));
		});

		expect({ commits: commits.count(), owed: owed() }).toEqual({ commits: 1, owed: true });
		settle();
		expect(owed()).toBe(false);
	});
});

describe("the journal's images", () => {
	function journal(module: string): { module: string; hash: string } {
		const policy = testPolicy(root);
		const kept = policy.admitBytes(module, Buffer.from("SECRET-IMAGE"));
		const orphan = policy.admitBytes("orphan.json", Buffer.from("SECRET-ORPHAN"));
		if (kept.kind !== "admitted" || orphan.kind !== "admitted") throw new Error("expected plain journal images");
		store.putBlob(kept.value);
		store.putBlob(orphan.value);
		store.journalWrite((db) => {
			db.exec("INSERT INTO refactor_transactions (id, state, startedAt) VALUES ('t', 'open', 1)");
			db.prepare(
				`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash, beforeEdited)
				 VALUES ('t', 'baseline', 0, ?, 1, ?, 0)`,
			).run(module, kept.value.hash);
		});
		return { module, hash: kept.value.hash };
	}

	const state = () =>
		store.journalRead((db) => ({
			images: (db.prepare("SELECT COUNT(*) AS n FROM refactor_images").get() as { n: number }).n,
			blobs: (db.prepare("SELECT COUNT(*) AS n FROM refactor_blobs").get() as { n: number }).n,
		}));

	it("go with the unreferenced blobs in one commit, which owes the log a truncate", () => {
		const pair = journal("secret.json");
		hold();

		const removed = store.purgeImages([pair]);

		expect({ removed, ...state(), owed: owed() }).toEqual({ removed: 1, images: 0, blobs: 0, owed: true });
		settle();
	});

	it("are never separated from their blobs when the prune fails", () => {
		const pair = journal("secret.json");
		store.journalWrite((db) =>
			db.exec(
				"CREATE TEMP TRIGGER blobs_stay BEFORE DELETE ON main.refactor_blobs BEGIN SELECT RAISE(ABORT, 'blocked'); END",
			),
		);

		expect(() => store.purgeImages([pair])).toThrow();
		expect(state()).toEqual({ images: 1, blobs: 2 });

		store.journalWrite((db) => db.exec("DROP TRIGGER blobs_stay"));
		expect(store.purgeImages([pair])).toBe(1);
		expect(state()).toEqual({ images: 0, blobs: 0 });
	});

	it("owe nothing when only the unreferenced blobs are pruned", () => {
		journal("kept.json");
		hold();

		const pruned = store.pruneBlobs();

		expect({ pruned, ...state(), owed: owed() }).toEqual({ pruned: 1, images: 1, blobs: 1, owed: false });
		settle();
	});
});

describe("what the compiler refuses", () => {
	it("takes no write without an admission the policy minted", () => {
		const never = () => {
			// @ts-expect-error forget requires admission
			store.forgetFile("a.json");
			// @ts-expect-error failure recording requires admission
			store.recordFailure("a.json", failed("reason"));
			// @ts-expect-error failure text requires verdict wording
			store.recordFailure("a.json", "reason", admit("a.json"));
			// @ts-expect-error clearing failures requires admission
			store.clearFailure("a.json");
			// @ts-expect-error fact writes require admission
			store.replaceFile({ module: "a.json", contentHash: "h", declarations: [], references: [] });
			// @ts-expect-error admissions require policy minting
			const forged: SecretAdmission = { module: "a.json", stamp: null, as: "plain" };
			return forged;
		};

		expect(never).toBeInstanceOf(Function);
	});
});
