import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashBytes } from "@nyaa-lexicon/protocol";
import { JOURNAL_TABLE_NAMES, SETTLED_IMAGES_KEPT, SETTLEMENTS_KEPT } from "../journalSchema";
import { IndexStore } from "../store";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

let root: string;
let file: string;
let store: IndexStore;
let manager: TransactionManager;

function write(module: string, text: string): void {
	writeFileSync(path.join(root, module), text);
}

function hash(text: string): string {
	return hashBytes(Buffer.from(text));
}

/** Simulates a journaled write step. */
function step(edits: Record<string, string>): void {
	const begun = manager.beginStep("replace", Object.keys(edits));
	if (!begun.ok) throw new Error(begun.reason);
	for (const [module, text] of Object.entries(edits)) write(module, text);
	manager.completeStep(begun.stepNo, "written");
	manager.completeStep(begun.stepNo, "finalized");
}

/** Simulates a noted editor save. */
function noted(module: string, text: string): void {
	write(module, text);
	const answer = manager.noteWrite(module, { contentHash: hash(text) });
	if (!answer.noted) throw new Error(answer.reason);
}

function text(seq: number, module: string, side: "opened" | "settled"): string | null {
	const image = manager.settledImage(seq, module, side);
	return image.held && "text" in image ? image.text : null;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-settle-"));
	file = path.join(root, ".index.sqlite");
	store = IndexStore.open(file).store;
	manager = new TransactionManager(store, root);
	write("a.ts", "opened\n");
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a settlement written at close", () => {
	it("records a commit's opened and settled images for every tracked file, and serves their bytes", () => {
		const { id } = manager.start();
		manager.track("a.ts");
		manager.track("b.ts");
		step({ "a.ts": "stepped\n" });
		noted("b.ts", "saved\n");
		manager.commit({ force: true });

		const answer = manager.settlements(0);

		expect(answer).toEqual({
			ledger: manager.ledger(),
			oldest: 1,
			settlements: [
				{
					seq: 1,
					id,
					origin: "explicit",
					outcome: "committed",
					closedAt: expect.any(Number),
					files: [
						{ module: "a.ts", opened: hash("opened\n"), settled: hash("stepped\n") },
						{ module: "b.ts", opened: null, settled: hash("saved\n") },
					],
				},
			],
		});
		expect(manager.status().ledger).toEqual({ id: answer.ledger.id, latest: 1 });
		expect([text(1, "a.ts", "opened"), text(1, "a.ts", "settled"), text(1, "b.ts", "settled")]).toEqual([
			"opened\n",
			"stepped\n",
			"saved\n",
		]);
		expect(manager.settledImage(1, "b.ts", "opened")).toEqual({ held: true, absent: true });
		expect(manager.settledImage(1, "c.ts", "opened")).toEqual({ held: false });
	});

	it("records a revert as the opened images, whatever the steps wrote", () => {
		manager.start();
		step({ "a.ts": "stepped\n" });
		manager.revert(manager.status().drifted);

		expect(manager.settlements(0).settlements).toMatchObject([
			{ outcome: "reverted", files: [{ module: "a.ts", opened: hash("opened\n"), settled: hash("opened\n") }] },
		]);
	});

	it("records a revert that recovery finished after the daemon died", () => {
		manager.start();
		step({ "a.ts": "stepped\n" });
		const dying = new TransactionManager(store, root, undefined, () => {
			throw new Error("died after restoring");
		});
		expect(() => dying.revert(dying.status().drifted)).toThrow("died after restoring");
		expect(manager.settlements(0).settlements).toEqual([]);

		new TransactionManager(store, root).recover();

		expect(manager.settlements(0).settlements).toMatchObject([
			{ outcome: "reverted", files: [{ module: "a.ts", settled: hash("opened\n") }] },
		]);
	});

	it("records an own close by recovery, keeping hashes but not bytes", () => {
		manager.start("own");
		step({ "a.ts": "own step\n" });

		new TransactionManager(store, root).recover();

		expect(manager.settlements(0).settlements).toMatchObject([
			{ origin: "own", outcome: "committed", files: [{ module: "a.ts", settled: hash("own step\n") }] },
		]);
		expect(manager.settledImage(1, "a.ts", "settled")).toEqual({ held: false });
	});

	it("names a file disk no longer holds at close, and a file gone as a null hash", () => {
		manager.start();
		manager.track("a.ts");
		manager.track("b.ts");
		write("b.ts", "made\n");
		noted("b.ts", "made\n");
		write("a.ts", "typed, never noted\n");
		rmSync(path.join(root, "b.ts"));
		manager.commit();

		expect(manager.settlements(0).settlements[0]?.files).toEqual([
			{
				module: "a.ts",
				opened: hash("opened\n"),
				settled: hash("opened\n"),
				drifted: { contentHash: hash("typed, never noted\n") },
			},
			{ module: "b.ts", opened: null, settled: hash("made\n"), drifted: { contentHash: null } },
		]);
	});
});

describe("reading the ledger", () => {
	it("pages after a position, oldest first", () => {
		for (const round of [1, 2, 3]) {
			manager.start();
			manager.track("a.ts");
			noted("a.ts", `round ${round}\n`);
			manager.commit();
		}

		expect(manager.settlements(1, 1).settlements.map((settlement) => settlement.seq)).toEqual([2]);
		expect(manager.settlements(3)).toMatchObject({ oldest: 1, settlements: [], ledger: { latest: 3 } });
	});

	it("keeps images for the newest explicit settlements, and rows for more, with their transactions", () => {
		for (let round = 1; round <= SETTLEMENTS_KEPT + 1; round++) {
			manager.start();
			manager.track("a.ts");
			noted("a.ts", `round ${round}\n`);
			manager.commit();
		}
		const latest = SETTLEMENTS_KEPT + 1;
		const unheld = latest - SETTLED_IMAGES_KEPT;

		expect(manager.settlements(0, 1)).toMatchObject({ oldest: 2, ledger: { latest } });
		expect(text(latest, "a.ts", "settled")).toBe(`round ${latest}\n`);
		expect(text(unheld + 1, "a.ts", "opened")).toBe(`round ${unheld}\n`);
		expect(manager.settledImage(unheld, "a.ts", "opened")).toEqual({ held: false });
		const closed = store.journal((db) =>
			db.prepare("SELECT COUNT(*) AS n FROM refactor_transactions WHERE state != 'open'").get(),
		) as { n: number };
		expect(closed.n).toBe(SETTLEMENTS_KEPT);
	});
});

describe("the journal across a rebuild", () => {
	it("keeps an open refactor's noted edits, the settlements and the ledger id", () => {
		store.close();
		store = IndexStore.open(file, "9").store;
		manager = new TransactionManager(store, root);
		manager.start();
		manager.track("a.ts");
		noted("a.ts", "settled\n");
		manager.commit();
		manager.start();
		manager.track("a.ts");
		noted("a.ts", "open edit\n");
		const before = { status: manager.status(), settlements: manager.settlements(0) };
		store.close();

		const reopened = IndexStore.open(file, "10");
		store = reopened.store;
		manager = new TransactionManager(store, root);

		expect(reopened.rebuilt).toBe(true);
		expect(manager.status()).toEqual(before.status);
		expect(manager.status()).toMatchObject({ edited: ["a.ts"], drifted: [] });
		expect(manager.settlements(0)).toEqual(before.settlements);
		expect(text(1, "a.ts", "settled")).toBe("settled\n");
	});
});

describe("the journal table registry", () => {
	it("is exactly the store's refactor tables, and each revision table carries its triggers", () => {
		const names = (type: string) =>
			(
				store.journal((db) =>
					db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'refactor_%'").all(type),
				) as Array<{ name: string }>
			)
				.map((row) => row.name)
				.sort();

		expect(names("table")).toEqual([...JOURNAL_TABLE_NAMES].sort());
		expect(names("trigger").length).toBeGreaterThan(0);
		for (const trigger of names("trigger")) {
			expect(JOURNAL_TABLE_NAMES.some((table) => trigger.startsWith(`${table}_revision_`))).toBe(true);
		}
	});

	it("advances the open refactor's revision on a noted write", () => {
		manager.start();
		manager.track("a.ts");
		const before = manager.status().revision as number;
		noted("a.ts", "noted\n");

		expect(manager.status().revision).toBeGreaterThan(before);
	});
});
