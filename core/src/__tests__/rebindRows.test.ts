import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore, SCHEMA_VERSION } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

let dir: string;
let file: string;
let store: IndexStore;
let service: LexiconService;

const CART = "lexicon reference a.ref Cart#";
const TOTAL = "lexicon reference a.ref Total#";
const MOVED = "lexicon reference b.ref Cart#";
const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

function declaration(symbolId: string, name: string, line = 0) {
	return {
		symbolId,
		kind: "class" as const,
		name,
		range: at(line),
		selectionRange: at(line),
		visibility: "public" as const,
	};
}

function plant(module = "a.ref", symbolId = CART, name = "Cart"): void {
	store.replaceFile({
		module: module,
		contentHash: "h1",
		declarations: [declaration(symbolId, name)],
		references: [],
	});
}

async function record(symbolId: string, prose = "A shopping cart.") {
	const cited = store.declaration(symbolId)?.factId as string;
	const outcome = await service.recordAnswer(symbolId, "describe", prose, [cited]);
	if (!outcome.recorded) throw new Error(outcome.reason);
	return outcome.answer;
}

function reopen(): ReturnType<typeof IndexStore.open> {
	const opened = IndexStore.open(file);
	store = opened.store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(),
		fromText(() => null),
		dir,
	);
	return opened;
}

/** A move of a.ref into b.ref, written and rebound, left unfinished. */
function journalMove(entries: Array<{ from: string; to: string }>): TransactionManager {
	writeFileSync(path.join(dir, "a.ref"), "before\n");
	const transactions = new TransactionManager(store, dir);
	transactions.start();
	const begun = transactions.beginStep("move", ["a.ref", "b.ref"], { rebind: { entries, evidence: "journalMove" } });
	if (!begun.ok) throw new Error(begun.reason);
	writeFileSync(path.join(dir, "a.ref"), "after\n");
	writeFileSync(path.join(dir, "b.ref"), "moved\n");
	transactions.completeStep(begun.stepNo, "written");
	transactions.rebind(begun.stepNo, entries, "journalMove");
	return transactions;
}

function rows(): Array<Record<string, unknown>> {
	return store.journal((db) =>
		db.prepare("SELECT * FROM refactor_rebinds ORDER BY transactionId, stepNo, ordinal").all(),
	) as Array<Record<string, unknown>>;
}

/** Another subject claimed at the move's `from`, so the reversal has nowhere to put the moved one. */
async function holdOldAddress(): Promise<void> {
	plant();
	await record(CART, "A newer cart.");
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-rebinds-"));
	file = path.join(dir, "index.sqlite");
	reopen();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("what a step moved is rows, not JSON", () => {
	it("writes one row per applied move in the order applied, and the plan keeps only what was decided", async () => {
		store.replaceFile({
			module: "a.ref",
			contentHash: "h1",
			declarations: [declaration(CART, "Cart"), declaration(TOTAL, "Total", 1)],
			references: [],
		});
		await record(CART);
		await record(TOTAL, "The total.");
		const movedTotal = "lexicon reference b.ref Total#";

		journalMove([
			{ from: CART, to: MOVED },
			{ from: TOTAL, to: movedTotal },
		]);

		expect(
			rows().map((row) => [row["ordinal"], row["fromSymbolId"], row["toSymbolId"], row["priorState"]]),
		).toEqual([
			[0, CART, MOVED, "bound"],
			[1, TOTAL, movedTotal, "bound"],
		]);
		const plan = store.journal((db) => db.prepare("SELECT plan FROM refactor_steps").get()) as { plan: string };
		expect(JSON.parse(plan.plan).rebind).toEqual({
			entries: [
				{ from: CART, to: MOVED },
				{ from: TOTAL, to: movedTotal },
			],
			evidence: "journalMove",
		});
	});

	it("refuses a row the schema cannot vouch for", () => {
		const insert = (values: unknown[]) =>
			store.journal((db) =>
				db
					.prepare(
						`INSERT INTO refactor_rebinds (transactionId, stepNo, ordinal, subjectId, fromSymbolId, toSymbolId,
						 priorFrom, priorEvidence, priorBoundAt, priorState, priorOrphanedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(...(values as Array<string | number | null>)),
			);

		expect(() => insert(["t", 1, 0, null, CART, MOVED, null, "sameLocator", 1, "bound", null])).toThrow();
		expect(() => insert(["t", 1, 0, "s", CART, MOVED, null, "guess", 1, "bound", null])).toThrow();
		expect(() => insert(["t", 1, 0, "s", CART, MOVED, null, "sameLocator", 1, "orphaned", null])).toThrow();
		expect(() => insert(["t", 1, 0, "s", CART, MOVED, null, "sameLocator", 1, "unknown", 7])).toThrow();
		expect(() => insert(["t", 1, 0, "s", CART, MOVED, null, "sameLocator", "soon", "bound", null])).toThrow();
		expect(() => insert(["t", 1, 0, "s", CART, MOVED, null, "sameLocator", 1, "orphaned", "soon"])).toThrow();
		expect(() => insert(["t", 1, 0, "", CART, MOVED, null, "sameLocator", 1, "bound", null])).toThrow();
		expect(() => insert(["t", 1, 0, "s", CART, MOVED, "", "sameLocator", 1, "bound", null])).toThrow();
		expect(() => insert(["t", 1, 0, "s", CART, MOVED, null, "sameLocator", 1, "bound", null])).not.toThrow();
	});

	it("goes with the step on undo and with the transaction on commit", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		expect(rows()).toHaveLength(1);

		expect(transactions.undo().undone).toBe(true);
		expect(rows()).toHaveLength(0);

		journalMove([{ from: CART, to: MOVED }]);
		expect(rows()).toHaveLength(1);
		expect(new TransactionManager(store, dir).commit().committed).toBe(true);
		expect(rows()).toHaveLength(0);
	});

	it("retraces a subject moved twice in one step all the way back", async () => {
		plant();
		await record(CART);
		const onward = "lexicon reference c.ref Cart#";
		const transactions = journalMove([
			{ from: CART, to: MOVED },
			{ from: MOVED, to: onward },
		]);
		expect(store.answer(onward, "describe")?.prose).toBe("A shopping cart.");

		const outcome = transactions.undo();

		expect("unreversed" in outcome).toBe(false);
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(CART)).toMatchObject({ evidence: "sameLocator", fromSymbolId: null });
		expect(store.subjects.forAddress(MOVED)).toBeNull();
	});

	it("continues the ordinals when a step rebinds twice, and undo retraces both", async () => {
		plant();
		await record(CART);
		const onward = "lexicon reference c.ref Cart#";
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		const begun = transactions.beginStep("move", [], {});
		if (!begun.ok) throw new Error(begun.reason);
		transactions.rebind(begun.stepNo, [{ from: CART, to: MOVED }], "journalMove");
		transactions.rebind(begun.stepNo, [{ from: MOVED, to: onward }], "journalMove");
		transactions.completeStep(begun.stepNo, "finalized");
		expect(rows().map((row) => [row["ordinal"], row["toSymbolId"]])).toEqual([
			[0, MOVED],
			[1, onward],
		]);

		expect(transactions.undo()).toEqual({ undone: true, stepNo: begun.stepNo, modules: [] });
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(onward)).toBeNull();
	});
});

describe("a reversal that could not put a move back says so", () => {
	it("on undo, when another subject holds the old address, and the moved one stays", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		const moved = store.subjects.forAddress(MOVED)?.subjectId as string;
		await holdOldAddress();

		const outcome = transactions.undo();

		expect(outcome).toMatchObject({
			undone: true,
			unreversed: [{ subjectId: moved, from: CART, to: MOVED, reason: "fromHeld" }],
		});
		expect(store.answer(MOVED, "describe")?.prose).toBe("A shopping cart.");
		expect(store.answer(CART, "describe")?.prose).toBe("A newer cart.");
	});

	it("on revert, the same", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		await holdOldAddress();

		const outcome = transactions.revert();

		expect(outcome.reverted).toBe(true);
		expect(outcome.unreversed).toMatchObject([{ from: CART, to: MOVED, reason: "fromHeld" }]);
		expect(store.answer(MOVED, "describe")?.prose).toBe("A shopping cart.");
	});

	it("on recovery, beside the conflicts", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		await holdOldAddress();

		const outcome = transactions.recover();

		expect(outcome.restored).toEqual(["a.ref", "b.ref"]);
		expect(outcome.unreversed).toMatchObject([{ from: CART, to: MOVED, reason: "fromHeld" }]);
		expect(rows()).toHaveLength(0);
	});

	it("names a subject that moved on since the step, even when another took its old address, and leaves it where it went", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		const onward = "lexicon reference c.ref Cart#";
		store.subjects.rebind([{ from: MOVED, to: onward }], "batchExactMatch", 11);
		await holdOldAddress();

		const outcome = transactions.undo();

		expect(outcome.unreversed).toMatchObject([{ from: CART, to: MOVED, reason: "movedOn" }]);
		expect(store.answer(onward, "describe")?.prose).toBe("A shopping cart.");
		expect(store.answer(CART, "describe")?.prose).toBe("A newer cart.");
	});

	it("names a subject deleted since the step", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		store.subjects.delete(store.subjects.forAddress(MOVED)?.subjectId as string);

		const outcome = transactions.undo();

		expect(outcome.unreversed).toMatchObject([{ from: CART, to: MOVED, reason: "gone" }]);
		expect(store.answer(CART, "describe")).toBeNull();
	});

	it("says nothing when every move went back", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);

		const outcome = transactions.undo();

		expect(outcome.undone).toBe(true);
		expect("unreversed" in outcome).toBe(false);
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
	});
});

describe("a reversal commits with its journal, or not at all", () => {
	/** Refuses one kind of write on one journal table, the way a failing commit would. */
	function block(table: string, event: "INSERT" | "DELETE" | "UPDATE"): void {
		store.journal((db) =>
			db.exec(
				`CREATE TEMP TRIGGER blocked BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
			),
		);
	}

	function unblock(): void {
		store.journal((db) => db.exec("DROP TRIGGER temp.blocked"));
	}

	it("moves nothing when the rows cannot be written", async () => {
		plant();
		await record(CART);
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		const begun = transactions.beginStep("move", [], {});
		if (!begun.ok) throw new Error(begun.reason);
		block("refactor_rebinds", "INSERT");

		expect(() => transactions.rebind(begun.stepNo, [{ from: CART, to: MOVED }], "journalMove")).toThrow();

		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(MOVED)).toBeNull();
		unblock();
		expect(transactions.rebind(begun.stepNo, [{ from: CART, to: MOVED }], "journalMove").subjects).toBe(1);
	});

	it("keeps the move and its rows when undo cannot delete the step", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		block("refactor_steps", "DELETE");

		expect(() => transactions.undo()).toThrow();

		expect(store.answer(MOVED, "describe")?.prose).toBe("A shopping cart.");
		expect(rows()).toHaveLength(1);
		unblock();
		expect(transactions.undo().undone).toBe(true);
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
	});

	it("keeps the move and its rows when recovery cannot delete the step", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		block("refactor_steps", "DELETE");

		expect(() => transactions.recover()).toThrow();

		expect(store.answer(MOVED, "describe")?.prose).toBe("A shopping cart.");
		expect(rows()).toHaveLength(1);
	});

	it("keeps the move, its rows and the open transaction when revert cannot close", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		block("refactor_transactions", "UPDATE");

		expect(() => transactions.revert()).toThrow();

		expect(store.answer(MOVED, "describe")?.prose).toBe("A shopping cart.");
		expect(rows()).toHaveLength(1);
		expect(transactions.openTransaction()).not.toBeNull();
	});
});

describe("a recovery intent survives the filesystem gap", () => {
	it("lets recover finish an undo after restore throws", async () => {
		plant();
		await record(CART);
		const transactions = journalMove([{ from: CART, to: MOVED }]);
		const failing = new TransactionManager(store, dir, undefined, () => {
			throw new Error("injected after restore");
		});

		expect(() => failing.undo()).toThrow("injected after restore");
		const recovered = new TransactionManager(store, dir).recover();

		expect(recovered.unreversed).toEqual([]);
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(MOVED)).toBeNull();
		expect(rows()).toHaveLength(0);
	});

	it("lets revert finish after restore throws", async () => {
		plant();
		await record(CART);
		journalMove([{ from: CART, to: MOVED }]);
		const failing = new TransactionManager(store, dir, undefined, () => {
			throw new Error("injected after restore");
		});

		expect(() => failing.revert()).toThrow("injected after restore");
		expect(new TransactionManager(store, dir).revert().reverted).toBe(true);
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(MOVED)).toBeNull();
	});
});

describe("a store from before the table", () => {
	/** An open step journaled the way the JSON shape did, its subject already at the destination. */
	async function journalAsJson(applied: (subjectId: string) => unknown[]): Promise<void> {
		plant();
		await record(CART);
		const subjectId = store.subjects.forAddress(CART)?.subjectId as string;
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		const begun = transactions.beginStep("move", [], {
			rebind: { entries: [{ from: CART, to: MOVED }], evidence: "journalMove", applied: applied(subjectId) },
		});
		if (!begun.ok) throw new Error(begun.reason);
		store.subjects.rebind([{ from: CART, to: MOVED }], "journalMove", 9);
		transactions.completeStep(begun.stepNo, "reindexed");
		store.close();
		const raw = new DatabaseSync(file);
		raw.exec("DROP TABLE refactor_rebinds");
		raw.close();
	}

	it("lifts the JSON into rows once, drops what the schema refuses, and recovers from the rows", async () => {
		await journalAsJson((subjectId) => [
			{
				subjectId,
				from: CART,
				to: MOVED,
				priorFrom: null,
				priorEvidence: "sameLocator",
				priorBoundAt: 5,
				priorState: "bound",
				priorOrphanedAt: null,
			},
			{ subjectId: "ghost", from: CART, to: MOVED, priorEvidence: "guess", priorBoundAt: 5, priorState: "bound" },
			{
				subjectId,
				from: CART,
				to: MOVED,
				priorEvidence: "sameLocator",
				priorBoundAt: "soon",
				priorState: "bound",
			},
			"not a move",
			{
				subjectId,
				from: CART,
				to: MOVED,
				priorFrom: true,
				priorEvidence: "sameLocator",
				priorBoundAt: 5,
				priorState: "bound",
				priorOrphanedAt: null,
			},
			{
				subjectId,
				from: CART,
				to: MOVED,
				priorFrom: null,
				priorEvidence: "sameLocator",
				priorBoundAt: 5,
				priorState: "bound",
				priorOrphanedAt: null,
			},
			{
				subjectId: 7,
				from: 8,
				to: 9,
				priorFrom: null,
				priorEvidence: "sameLocator",
				priorBoundAt: 5,
				priorState: "bound",
				priorOrphanedAt: null,
			},
			{
				subjectId,
				from: CART,
				to: MOVED,
				priorFrom: null,
				priorEvidence: "journalMove",
				priorBoundAt: 5,
				priorState: "bound",
				priorOrphanedAt: null,
			},
		]);

		const opened = reopen();

		expect(opened.dropped).toBe(6);
		expect(rows().map((row) => row["ordinal"])).toEqual([0]);

		expect(reopen().dropped).toBeUndefined();
		expect(rows()).toHaveLength(1);

		new TransactionManager(store, dir).recover();
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(MOVED)).toBeNull();
	});

	it("lifts across a rebuild too, from the salvaged steps", async () => {
		await journalAsJson((subjectId) => [
			{
				subjectId,
				from: CART,
				to: MOVED,
				priorFrom: null,
				priorEvidence: "sameLocator",
				priorBoundAt: 5,
				priorState: "bound",
				priorOrphanedAt: null,
			},
		]);
		const raw = new DatabaseSync(file);
		raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		raw.close();

		const opened = reopen();

		expect(opened.rebuilt).toBe(true);
		expect(rows()).toHaveLength(1);
		new TransactionManager(store, dir).recover();
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
	});

	it("lifts nothing from a closed transaction", async () => {
		await journalAsJson(() => []);
		reopen();
		expect(new TransactionManager(store, dir).revert().reverted).toBe(true);
		store.close();
		const raw = new DatabaseSync(file);
		raw.exec("DROP TABLE refactor_rebinds");
		raw.close();

		const opened = reopen();

		expect(opened.dropped).toBeUndefined();
		expect(rows()).toHaveLength(0);
	});
});

describe("across a rebuild", () => {
	it("carries the rows and recovers from them", async () => {
		plant();
		await record(CART);
		journalMove([{ from: CART, to: MOVED }]);
		store.close();
		const raw = new DatabaseSync(file);
		raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		raw.close();

		const opened = reopen();

		expect(opened.rebuilt).toBe(true);
		expect(rows()).toHaveLength(1);
		const outcome = new TransactionManager(store, dir).recover();
		expect(outcome.unreversed).toEqual([]);
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
	});
});
