import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUSY_MS, Database } from "../database";
import { IndexStore, SCHEMA_VERSION } from "../store";
import { PURGE_RETRY_MS } from "../storePurge";
import { writePlain } from "./admissions";
import { type FakeClock, fakeClock } from "./fakeClock";
import { testPolicy } from "./testPolicy";

////////////////////////////////
//  Helpers

const VALUE = "SECRET-VALUE-9f3a71c2e5";

let root: string;
let file: string;
let clock: FakeClock;
let store: IndexStore;
let storeClosed: boolean;
/** Keeps the store open between holds. */
let reader: Database;
const opened: IndexStore[] = [];

const holds = (target: string) => existsSync(target) && readFileSync(target).includes(VALUE);

const openStore = () => IndexStore.open(file, undefined, undefined, clock);

/** Deletes a blob before truncation. */
const purge = () => store.purgeImages([]);

/** Reads the named file separately. */
function pending(): boolean {
	const probe = Database.open(file, { readOnly: true });
	try {
		return probe.prepare("SELECT value FROM meta WHERE key = 'securePurgePending'").get() !== undefined;
	} finally {
		probe.close();
	}
}

const hold = () => {
	reader.exec("BEGIN");
	reader.prepare("SELECT COUNT(*) FROM files").get();
};

const release = () => reader.exec("COMMIT");

const replaceA = () => writePlain(store, { module: "a.ts", contentHash: "a", declarations: [], references: [] });

const commitBatch = () => store.pass(async () => replaceA());

const residue = () => ({ walHolds: holds(`${file}-wal`), dbHolds: holds(file), pending: pending() });

const CLEAR = { walHolds: false, dbHolds: false, pending: false };

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-store-purge-"));
	file = path.join(root, "index.sqlite");
	clock = fakeClock();
	store = openStore().store;
	storeClosed = false;
	// Blocked checkpoints skip the busy timeout.
	store.journalWrite((db) => db.exec("PRAGMA busy_timeout = 0"));
	reader = Database.open(file, { readOnly: true });
	const admitted = testPolicy(root, undefined, store).admitBytes("value.json", Buffer.from(VALUE));
	if (admitted.kind !== "admitted") throw new Error("expected a plain image");
	store.putBlob(admitted.value);
});

afterEach(() => {
	for (const each of opened.splice(0)) each.close();
	reader.close();
	if (!storeClosed) store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a purge while a reader holds a snapshot", () => {
	it("leaves the WAL holding the value and the flag set", () => {
		hold();
		purge();
		const walHolds = holds(`${file}-wal`);
		release();

		expect({ walHolds, pending: pending() }).toEqual({ walHolds: true, pending: true });
	});

	it("stays set through a committed batch while the reader remains", async () => {
		hold();
		purge();
		await commitBatch();
		const walHolds = holds(`${file}-wal`);
		release();

		expect({ walHolds, pending: pending() }).toEqual({ walHolds: true, pending: true });
	});

	it("stays pending through the close, then ends with the old file when the open rebuilds", () => {
		hold();
		purge();
		store.journalWrite((db) => db.exec("PRAGMA user_version = 1"));
		store.close();
		storeClosed = true;
		release();
		const reopened = openStore();
		opened.push(reopened.store);

		expect({ rebuilt: reopened.rebuilt, ...residue() }).toEqual({ rebuilt: true, ...CLEAR });
	});

	const RETRIES: Array<[string, () => unknown]> = [
		[
			"the next purge",
			() => {
				const admitted = testPolicy(root, undefined, store).admitBytes("other.json", Buffer.from("other"));
				if (admitted.kind !== "admitted") throw new Error("expected a plain image");
				store.putBlob(admitted.value);
				purge();
			},
		],
		["a committed batch", commitBatch],
		["the store opening", () => void opened.push(openStore().store)],
		[
			"the store closing",
			() => {
				store.close();
				storeClosed = true;
			},
		],
		["the idle retry", () => clock.advance(PURGE_RETRY_MS)],
	];

	for (const [name, retry] of RETRIES) {
		it(`is cleared at ${name}`, async () => {
			hold();
			purge();
			release();
			await retry();

			expect(residue()).toEqual(CLEAR);
		});
	}

	it("clears once the reader leaves, with no further write", () => {
		hold();
		purge();
		const armed = store.purgeState();
		clock.advance(PURGE_RETRY_MS * 3);
		const blocked = store.purgeState();
		release();
		clock.advance(PURGE_RETRY_MS);

		expect({
			armed,
			stillBlocked: blocked.pending && blocked.attempts > armed.attempts,
			cleared: store.purgeState(),
			...residue(),
		}).toEqual({
			armed: { pending: true, since: clock.now() - PURGE_RETRY_MS * 4, attempts: 1 },
			stillBlocked: true,
			cleared: { pending: false, since: null, attempts: 0 },
			...CLEAR,
		});
		// No retry timer remains.
		expect(clock.pending()).toBe(0);
	});

	it("never tries inside an open write, and the batch's commit settles it", async () => {
		hold();
		purge();
		const triedBefore = store.purgeState().attempts;
		let finish = () => {};
		const writing = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pass = store.pass(async () => {
			replaceA();
			await writing;
		});
		release();
		clock.advance(PURGE_RETRY_MS);
		const triedWhileOpen = store.purgeState().attempts;
		finish();
		await pass;

		expect({ triedWhileOpen, ...residue() }).toEqual({ triedWhileOpen: triedBefore, ...CLEAR });
	});

	it("never waits on the reader at a batch commit", async () => {
		hold();
		purge();
		store.journalWrite((db) => db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`));
		const started = performance.now();
		await commitBatch();
		const waited = performance.now() - started;
		release();

		expect(waited).toBeLessThan(BUSY_MS / 2);
	});
});

describe("an index rebuild", () => {
	/** Reopens after rebuilding a populated row. */
	function reopenHoldingValue(schema: number): ReturnType<typeof openStore> {
		// Rebuild retains blobs while rebuilding facts.
		store.journalWrite((db) => db.exec("DELETE FROM refactor_blobs"));
		writePlain(store, {
			module: "a.ts",
			contentHash: "a",
			declarations: [],
			references: [],
			docs: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					text: VALUE,
					fenced: false,
				},
			],
		});
		store.journalWrite((db) => db.exec(`PRAGMA user_version = ${schema}`));
		store.close();
		storeClosed = true;
		const reopened = openStore();
		opened.push(reopened.store);
		return reopened;
	}

	it("leaves the value it dropped in neither the new file nor its log, and owes none", () => {
		const reopened = reopenHoldingValue(1);

		expect({ rebuilt: reopened.rebuilt, ...residue() }).toEqual({ rebuilt: true, ...CLEAR });
	});

	it("leaves the value where it was when no rebuild drops it (the control)", () => {
		const reopened = reopenHoldingValue(SCHEMA_VERSION);

		expect({ rebuilt: reopened.rebuilt, held: holds(file) || holds(`${file}-wal`) }).toEqual({
			rebuilt: false,
			held: true,
		});
	});
});
