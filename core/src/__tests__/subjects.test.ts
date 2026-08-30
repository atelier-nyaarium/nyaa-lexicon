import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore, SCHEMA_VERSION } from "../store";
import { KNOWLEDGE_SCHEMA, KNOWLEDGE_VIEWS, restoreSubjects } from "../subjects";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

let dir: string;
let file: string;
let store: IndexStore;
let service: LexiconService;

const CART = "lexicon reference a.ref Cart#";
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

function plant(module = "a.ref", symbolId = CART, name = "Cart"): string {
	store.replaceFile(module, "h1", [declaration(symbolId, name)], []);
	return store.declarationsIn(module)[0]?.factId as string;
}

async function record(symbolId: string, prose = "A shopping cart.", question: "describe" | "why" = "describe") {
	const cited = store.declaration(symbolId)?.factId as string;
	const outcome = await service.recordAnswer(symbolId, question, prose, [cited]);
	if (!outcome.recorded) throw new Error(outcome.reason);
	return outcome.answer;
}

/** Address-keyed tables, for the upgrade path. */
const OLD_KNOWLEDGE = `
CREATE TABLE answers (
  symbolId TEXT NOT NULL, question TEXT NOT NULL, factId TEXT NOT NULL, prose TEXT NOT NULL,
  citations TEXT NOT NULL, thin INTEGER NOT NULL DEFAULT 0, model TEXT, createdAt INTEGER NOT NULL,
  doubtId TEXT, doubtReason TEXT, doubtAt INTEGER, doubtBy TEXT, PRIMARY KEY (symbolId, question));
CREATE TABLE gaps (
  symbolId TEXT NOT NULL, question TEXT NOT NULL, askCount INTEGER NOT NULL, lastAsked INTEGER NOT NULL,
  PRIMARY KEY (symbolId, question));`;

/** Rewinds an open store's knowledge tables to the address-keyed shape, at the version given. */
function rewindToAddresses(version: number): void {
	store.close();
	const db = new DatabaseSync(file);
	for (const view of KNOWLEDGE_VIEWS) db.exec(`DROP VIEW IF EXISTS ${view}`);
	for (const table of ["answers", "gaps", "knowledge_subjects"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
	db.exec(OLD_KNOWLEDGE);
	db.prepare(
		"INSERT INTO answers (symbolId, question, factId, prose, citations, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
	).run(CART, "describe", "lexfact answer a.ref 0000000000000001", "A shopping cart.", "[]", 5);
	db.prepare(
		"INSERT INTO answers (symbolId, question, factId, prose, citations, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
	).run("lexicon reference gone.ref Old#", "describe", "lexfact answer gone.ref 0000000000000002", "Gone.", "[]", 5);
	db.prepare("INSERT INTO gaps (symbolId, question, askCount, lastAsked) VALUES (?, ?, ?, ?)").run(CART, "why", 3, 7);
	db.exec(`PRAGMA user_version = ${version}`);
	db.close();
}

/** Opens the store file and binds a service to it, so recall goes through the ledger. */
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

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-subjects-"));
	file = path.join(dir, "index.sqlite");
	reopen();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a subject and its address", () => {
	it("mints one subject on the first write and reuses it after", async () => {
		plant();
		await record(CART);
		const first = store.subjects.forAddress(CART);
		await record(CART, "Retains checkout state.", "why");

		expect(first).toMatchObject({ symbolId: CART, state: "bound", evidence: "sameLocator" });
		expect(store.subjects.forAddress(CART)?.subjectId).toBe(first?.subjectId as string);
		expect(
			store
				.answersFor(CART)
				.map((answer) => answer.question)
				.sort(),
		).toEqual(["describe", "why"]);
	});

	it("refuses to merge: an address that holds a subject is not a rebind target", async () => {
		plant();
		plant("b.ref", "lexicon reference b.ref Basket#", "Basket");
		await record(CART);
		await record("lexicon reference b.ref Basket#", "A basket.");

		const rebound = store.subjects.rebind(
			[{ from: CART, to: "lexicon reference b.ref Basket#" }],
			"journalMove",
			9,
		);

		expect(rebound.subjects).toBe(0);
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
	});

	it("rebinds idempotently, forwards the vacated address, and keeps the recorded address on the row", async () => {
		plant();
		const recorded = await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		plant("b.ref", moved);

		const first = store.subjects.rebind([{ from: CART, to: moved }], "journalMove", 9);
		const again = store.subjects.rebind([{ from: CART, to: moved }], "journalMove", 10);

		expect(first).toMatchObject({ subjects: 1, answers: 1, gaps: 0 });
		expect(first.applied).toMatchObject([{ from: CART, to: moved, priorFrom: null, priorEvidence: "sameLocator" }]);
		expect(again).toMatchObject({ subjects: 0, applied: [] });
		expect(store.subjects.forwardedFrom(CART)?.symbolId).toBe(moved);
		const answer = store.answer(moved, "describe");
		expect(answer?.factId).toBe(recorded.factId);
		expect(answer?.recordedAs).toBe(CART);
		expect(store.answer(CART, "describe")).toBeNull();
	});

	it("gives two subjects at one address, in turn, two distinct answer ids for the same prose", async () => {
		plant();
		const before = await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		plant("b.ref", moved);
		store.subjects.rebind([{ from: CART, to: moved }], "journalMove", 9);
		plant("a.ref", CART);

		const after = await record(CART);

		expect(after.factId).not.toBe(before.factId);
		expect(store.subjects.forAddress(CART)?.subjectId).not.toBe(store.subjects.forAddress(moved)?.subjectId);
	});

	it("mints a distinct subject at a reused address in the same millisecond as the first", () => {
		plant();
		const first = store.subjects.mint(CART, 7);
		const moved = "lexicon reference b.ref Cart#";
		plant("b.ref", moved);
		store.subjects.rebind([{ from: CART, to: moved }], "journalMove", 7);

		const second = store.subjects.mint(CART, 7);

		expect(second.subjectId).not.toBe(first.subjectId);
		expect(store.subjects.forAddress(moved)?.subjectId).toBe(first.subjectId);
	});

	it("refuses a second subject's answer under an existing fact id rather than deleting the first", async () => {
		const basket = "lexicon reference b.ref Basket#";
		plant();
		plant("b.ref", basket, "Basket");
		const first = await record(CART);
		const other = store.subjects.claim(basket, 5);

		expect(() =>
			store.saveAnswer(other?.subjectId as string, { ...first, symbolId: basket, recordedAs: basket }),
		).toThrow();
		expect(store.answer(CART, "describe")?.factId).toBe(first.factId);
	});

	it("orphans without erasing the address, restores on a write there, and deletes with its rows", async () => {
		plant();
		await record(CART);
		const subject = store.subjects.forAddress(CART) as NonNullable<ReturnType<typeof store.subjects.forAddress>>;

		store.subjects.orphan(subject.subjectId, 20, "none");
		expect(store.subjects.forAddress(CART)).toMatchObject({ state: "orphaned", orphanedAt: 20 });
		expect(store.subjects.orphanedCount()).toBe(1);

		await record(CART, "Retains checkout state.", "why");
		expect(store.subjects.forAddress(CART)).toMatchObject({
			subjectId: subject.subjectId,
			state: "bound",
			orphanedAt: null,
		});
		expect(store.answersFor(CART)).toHaveLength(2);

		store.subjects.delete(subject.subjectId);
		expect(store.subjects.forAddress(CART)).toBeNull();
		expect(store.answer(CART, "describe")).toBeNull();
	});

	it("is bound again when a re-index puts the declaration back at its kept address", async () => {
		plant();
		await record(CART);
		const subject = store.subjects.forAddress(CART);
		store.subjects.orphan(subject?.subjectId as string, 20, "none");

		plant();

		expect(store.subjects.forAddress(CART)).toMatchObject({
			subjectId: subject?.subjectId as string,
			state: "bound",
			orphanedAt: null,
			evidence: "sameLocator",
		});
		expect(store.liveAnswers().map((answer) => answer.symbolId)).toEqual([CART]);
	});

	it("lists bound subjects whose address no longer resolves", async () => {
		plant();
		await record(CART);
		store.replaceFile("a.ref", "h2", [], []);

		expect(store.subjects.unresolved(10).map((subject) => subject.symbolId)).toEqual([CART]);
	});

	it("counts a gap only under an address the index holds", () => {
		store.recordGap("lexicon reference typo.ref Nope#", "describe", 5);
		plant();
		store.recordGap(CART, "describe", 5);

		expect(store.subjects.forAddress("lexicon reference typo.ref Nope#")).toBeNull();
		expect(store.gaps(10)).toEqual([
			{ symbolId: CART, question: "describe", recordedAs: CART, askCount: 1, lastAsked: 5 },
		]);
	});

	it("keeps twenty twins apart: one name, one digest, twenty subjects, and a rebind moves one", async () => {
		const twins = Array.from({ length: 20 }, (_, i) => `lexicon reference m${i}.ref Cart#`);
		for (const [i, symbolId] of twins.entries()) {
			store.replaceFile(
				`m${i}.ref`,
				"h1",
				[declaration(symbolId, "Cart")],
				[],
				[],
				[],
				"full",
				[],
				[],
				[],
				"code",
				[{ symbolId, patternDigest: "same", patternCoverage: "commentsStripped" }],
			);
			await record(symbolId, `Cart ${i}.`);
		}
		const moved = "lexicon reference moved.ref Cart#";
		plant("moved.ref", moved);

		const rebound = store.subjects.rebind([{ from: twins[0] as string, to: moved }], "journalMove", 9);

		expect(rebound.subjects).toBe(1);
		const ids = twins.map(
			(id) => store.subjects.forAddress(id)?.subjectId ?? store.subjects.forwardedFrom(id)?.subjectId,
		);
		expect(new Set(ids).size).toBe(20);
		expect(service.recallAnswers(moved).map((recalled) => recalled.answer.prose)).toEqual(["Cart 0."]);
		expect(service.recallAnswers(twins[1] as string).map((recalled) => recalled.answer.prose)).toEqual(["Cart 1."]);
		expect(service.recallAnswers(twins[0] as string)).toEqual([]);
	});
});

describe("the pattern digest", () => {
	it("is minted by a full parse and not by a shallow one", () => {
		store.replaceFile("a.ref", "h1", [declaration(CART, "Cart")], [], [], [], "outline");
		expect(store.patternDigestOf(CART)).toBeNull();

		store.replaceFile("a.ref", "h1", [declaration(CART, "Cart")], [], [], [], "full", [], [], [], "code", [
			{ symbolId: CART, patternDigest: "abc", patternCoverage: "commentsStripped" },
		]);
		expect(store.patternDigestOf(CART)).toEqual({ digest: "abc", coverage: "commentsStripped" });
	});

	it("follows the bound subject when the declaration is re-indexed", async () => {
		plant();
		await record(CART);
		store.replaceFile("a.ref", "h2", [declaration(CART, "Cart")], [], [], [], "full", [], [], [], "code", [
			{ symbolId: CART, patternDigest: "abc", patternCoverage: "commentsKept" },
		]);

		expect(store.subjects.forAddress(CART)).toMatchObject({ lastDigest: "abc", lastCoverage: "commentsKept" });
	});

	it("leaves two subjects apart when their declarations converge on one digest", async () => {
		const basket = "lexicon reference b.ref Basket#";
		plant();
		plant("b.ref", basket, "Basket");
		await record(CART);
		await record(basket, "A basket.");
		for (const [module, symbolId, name] of [
			["a.ref", CART, "Cart"],
			["b.ref", basket, "Basket"],
		] as const) {
			store.replaceFile(module, "h2", [declaration(symbolId, name)], [], [], [], "full", [], [], [], "code", [
				{ symbolId, patternDigest: "same", patternCoverage: "commentsStripped" },
			]);
		}

		const a = store.subjects.forAddress(CART);
		const b = store.subjects.forAddress(basket);
		expect([a?.lastDigest, b?.lastDigest]).toEqual(["same", "same"]);
		expect([a?.state, b?.state]).toEqual(["bound", "bound"]);
		expect(a?.subjectId).not.toBe(b?.subjectId as string);
		expect(service.recallAnswers(CART).map((recalled) => recalled.answer.prose)).toEqual(["A shopping cart."]);
		expect(service.recallAnswers(basket).map((recalled) => recalled.answer.prose)).toEqual(["A basket."]);
	});
});

describe("a store written before subjects", () => {
	it("is re-keyed in place on first open, bound where the symbol still exists", () => {
		plant();
		rewindToAddresses(SCHEMA_VERSION);

		const opened = reopen();

		expect(opened.rebuilt).toBe(false);
		expect(store.subjects.forAddress(CART)).toMatchObject({ state: "bound" });
		expect(store.subjects.forAddress("lexicon reference gone.ref Old#")).toMatchObject({ state: "orphaned" });
		expect(store.askCount(CART, "why")).toBe(3);
		const recalled = service.recallAnswers(CART);
		expect(recalled.map((entry) => entry.answer.factId)).toEqual(["lexfact answer a.ref 0000000000000001"]);
		expect(recalled[0]?.subject).toMatchObject({ recordedAs: CART, evidence: "none" });
	});

	it("carries its knowledge across a rebuild, minting subjects for every address", () => {
		plant();
		rewindToAddresses(SCHEMA_VERSION - 1);

		const opened = reopen();

		expect(opened.rebuilt).toBe(true);
		expect(service.recallAnswers(CART).map((recalled) => recalled.answer.prose)).toEqual(["A shopping cart."]);
		expect(
			service.recallAnswers("lexicon reference gone.ref Old#").map((recalled) => recalled.answer.prose),
		).toEqual(["Gone."]);
		expect(store.askCount(CART, "why")).toBe(3);
		expect(store.subjects.forAddress(CART)).toMatchObject({ state: "bound" });
		// Minted bound for the sweep to judge: nothing resolves until the scan re-mints the facts.
		expect(
			store.subjects
				.unresolved(10)
				.map((subject) => subject.symbolId)
				.sort(),
		).toEqual([CART, "lexicon reference gone.ref Old#"].sort());
	});

	it("carries subjects themselves across a rebuild, orphans included", async () => {
		plant();
		await record(CART);
		const subject = store.subjects.forAddress(CART);
		store.subjects.orphan(subject?.subjectId as string, 20, "none");
		store.close();
		const db = new DatabaseSync(file);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
		db.close();

		reopen();

		expect(store.subjects.forAddress(CART)).toMatchObject({
			subjectId: subject?.subjectId as string,
			state: "orphaned",
			orphanedAt: 20,
		});
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
	});

	it("revives a subject row a rebuild lost, at the recorded address, so its answer stays readable", async () => {
		plant();
		const recorded = await record(CART);
		store.close();
		const db = new DatabaseSync(file);
		db.exec("DELETE FROM knowledge_subjects");
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
		db.close();

		reopen();

		expect(store.answer(CART, "describe")?.factId).toBe(recorded.factId);
		expect(store.subjects.forAddress(CART)).toMatchObject({ state: "bound", evidence: "none" });
	});
});

describe("a rebind a step journaled", () => {
	// Recovery puts the files back to their before-images, so the addresses go back with them.
	it("is reversed when recovery undoes the unfinished step", async () => {
		plant();
		await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		const entries = [{ from: CART, to: moved }];
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		const begun = transactions.beginStep("move", [], { rebind: { entries, evidence: "journalMove" } });
		if (!begun.ok) throw new Error(begun.reason);
		transactions.rebind(begun.stepNo, entries, "journalMove");
		transactions.completeStep(begun.stepNo, "reindexed");
		expect(store.answer(moved, "describe")?.prose).toBe("A shopping cart.");

		transactions.recover();

		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(moved)).toBeNull();
	});

	/** A move of a.ref into b.ref, written and rebound, left unfinished. */
	function journalMove(entries: Array<{ from: string; to: string }>): TransactionManager {
		writeFileSync(path.join(dir, "a.ref"), "before\n");
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		const begun = transactions.beginStep("move", ["a.ref", "b.ref"], {
			rebind: { entries, evidence: "journalMove" },
		});
		if (!begun.ok) throw new Error(begun.reason);
		writeFileSync(path.join(dir, "a.ref"), "after\n");
		writeFileSync(path.join(dir, "b.ref"), "moved\n");
		transactions.completeStep(begun.stepNo, "written");
		transactions.rebind(begun.stepNo, entries, "journalMove");
		return transactions;
	}

	/** One journaled, applied and finalized move step. */
	function movedStep(transactions: TransactionManager, from: string, to: string): void {
		const begun = transactions.beginStep("move", [], {
			rebind: { entries: [{ from, to }], evidence: "journalMove" },
		});
		if (!begun.ok) throw new Error(begun.reason);
		transactions.rebind(begun.stepNo, [{ from, to }], "journalMove");
		transactions.completeStep(begun.stepNo, "finalized");
	}

	it("leaves a subject that already held the destination where it is when the lost step never rebound", async () => {
		plant();
		const moved = "lexicon reference b.ref Cart#";
		plant("b.ref", moved);
		await record(moved, "The other cart.");
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		const begun = transactions.beginStep("move", [], {
			rebind: { entries: [{ from: CART, to: moved }], evidence: "journalMove" },
		});
		if (!begun.ok) throw new Error(begun.reason);

		transactions.recover();

		expect(store.answer(moved, "describe")?.prose).toBe("The other cart.");
		expect(store.subjects.forAddress(CART)).toBeNull();
	});

	it("is reversed for an entry whose source recovery restored, though its destination conflicts", async () => {
		plant();
		await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		const transactions = journalMove([{ from: CART, to: moved }]);
		writeFileSync(path.join(dir, "b.ref"), "edited by someone else\n");

		const outcome = transactions.recover();

		expect(outcome).toMatchObject({ restored: ["a.ref"], conflicts: ["b.ref"] });
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(moved)).toBeNull();
	});

	it("stays where the step put it when both of an entry's files conflict, since nothing restored them", async () => {
		plant();
		await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		const transactions = journalMove([{ from: CART, to: moved }]);
		writeFileSync(path.join(dir, "a.ref"), "edited by someone else\n");
		writeFileSync(path.join(dir, "b.ref"), "edited by someone else\n");

		const outcome = transactions.recover();

		expect([...outcome.conflicts].sort()).toEqual(["a.ref", "b.ref"]);
		expect(store.answer(moved, "describe")?.prose).toBe("A shopping cart.");
		expect(store.answer(CART, "describe")).toBeNull();
	});

	it("is reversed by undo, since the files go back", async () => {
		plant();
		await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		const transactions = journalMove([{ from: CART, to: moved }]);

		expect(transactions.undo().undone).toBe(true);

		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(moved)).toBeNull();
	});

	it("is retraced by revert along with every tracked file", async () => {
		plant();
		await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		const transactions = journalMove([{ from: CART, to: moved }]);

		expect(transactions.revert().reverted).toBe(true);

		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(moved)).toBeNull();
	});

	it("reverses only what the step applied, so a journaled no-op leaves an earlier move alone", async () => {
		plant();
		await record(CART);
		const moved = "lexicon reference b.ref Cart#";
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		movedStep(transactions, CART, moved);
		const again = transactions.beginStep("move", [], {
			rebind: { entries: [{ from: CART, to: moved }], evidence: "journalMove" },
		});
		if (!again.ok) throw new Error(again.reason);
		expect(transactions.rebind(again.stepNo, [{ from: CART, to: moved }], "journalMove").subjects).toBe(0);

		expect(transactions.undo().undone).toBe(true);

		expect(store.answer(moved, "describe")?.prose).toBe("A shopping cart.");
		expect(store.answer(CART, "describe")).toBeNull();
	});

	it("retraces a subject two steps moved all the way back on revert, to the state it started in", async () => {
		plant();
		await record(CART);
		const b = "lexicon reference b.ref Cart#";
		const c = "lexicon reference c.ref Cart#";
		const transactions = new TransactionManager(store, dir);
		transactions.start();
		movedStep(transactions, CART, b);
		movedStep(transactions, b, c);
		expect(store.answer(c, "describe")?.prose).toBe("A shopping cart.");

		expect(transactions.revert().reverted).toBe(true);

		expect(store.subjects.forAddress(CART)).toMatchObject({ evidence: "sameLocator", fromSymbolId: null });
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(b)).toBeNull();
	});
});

describe("a knowledge row's key", () => {
	it("is refused an update on every table, so identity moves only by address", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(KNOWLEDGE_SCHEMA);
		db.prepare(
			"INSERT INTO knowledge_subjects (subjectId, currentSymbolId, state, boundAt, evidence) VALUES ('s1', ?, 'bound', 1, 'none')",
		).run(CART);
		db.prepare(
			"INSERT INTO answers (subjectId, question, recordedAs, factId, prose, citations, createdAt) VALUES ('s1', 'describe', ?, 'f1', 'p', '[]', 1)",
		).run(CART);
		db.prepare(
			"INSERT INTO gaps (subjectId, question, recordedAs, askCount, lastAsked) VALUES ('s1', 'why', ?, 1, 1)",
		).run(CART);

		for (const table of ["knowledge_subjects", "answers", "gaps"]) {
			expect(() => db.prepare(`UPDATE ${table} SET subjectId = 's2'`).run()).toThrow(/never changes/);
		}
		db.close();
	});
});

describe("a salvaged subject row", () => {
	it("restores with closed values only, so a row from another version cannot fail the rebuild", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(KNOWLEDGE_SCHEMA);
		restoreSubjects(
			db,
			{
				knowledge_subjects: [
					{
						subjectId: "s1",
						currentSymbolId: CART,
						state: "bound",
						boundAt: 1,
						evidence: "teleport",
						lastDigest: "abc",
						lastCoverage: "partial",
					},
				],
			},
			[],
			5,
		);

		expect(db.prepare("SELECT evidence, lastDigest, lastCoverage FROM knowledge_subjects").get()).toEqual({
			evidence: "none",
			lastDigest: "abc",
			lastCoverage: null,
		});
		db.close();
	});
});
