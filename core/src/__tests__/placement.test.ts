import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { KNOWLEDGE_SCHEMA, KnowledgeSubjects, mintSubjectId, normalizeSalvaged } from "../subjects";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

const CART = "lexicon reference a.ref Cart#";
const SHOP = "lexicon reference a.ref Shop#";
const STORE = "lexicon reference a.ref Store#";
const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

function bare(): { db: DatabaseSync; subjects: KnowledgeSubjects } {
	const db = new DatabaseSync(":memory:");
	db.exec(KNOWLEDGE_SCHEMA);
	return { db, subjects: new KnowledgeSubjects(db) };
}

function hold(db: DatabaseSync, subjectId: string, symbolId: string): void {
	db.prepare(
		"INSERT INTO knowledge_subjects (subjectId, currentSymbolId, state, boundAt, evidence) VALUES (?, ?, 'bound', 1, 'sameLocator')",
	).run(subjectId, symbolId);
}

const count = (db: DatabaseSync) =>
	(db.prepare("SELECT COUNT(*) AS n FROM knowledge_subjects").get() as { n: number }).n;

////////////////////////////////
//  Tests

describe("placing a salvaged row", () => {
	it("keeps the subject a row names when it survived, wherever that subject now stands", () => {
		const { db, subjects } = bare();
		hold(db, "s1", SHOP);

		expect(subjects.placeRow({ subjectId: "s1", recordedAs: CART, at: 5 })).toEqual({
			placed: true,
			subjectId: "s1",
		});
		expect(count(db)).toBe(1);
		db.close();
	});

	it("revives a lost subject at its recorded address with the same id, bound and undated", () => {
		const { db, subjects } = bare();

		expect(subjects.placeRow({ subjectId: "s2", recordedAs: CART, at: 5 })).toEqual({
			placed: true,
			subjectId: "s2",
		});
		expect(subjects.forAddress(CART)).toMatchObject({
			subjectId: "s2",
			state: "bound",
			boundAt: 5,
			orphanedAt: null,
			evidence: "none",
		});
		db.close();
	});

	it("refuses a lost subject whose address another holds, and leaves the holder alone", () => {
		const { db, subjects } = bare();
		hold(db, "s1", CART);

		expect(subjects.placeRow({ subjectId: "s9", recordedAs: CART, at: 5 })).toEqual({
			placed: false,
			reason: "held",
		});
		expect(subjects.forAddress(CART)?.subjectId).toBe("s1");
		expect(subjects.byId("s9")).toBeNull();
		db.close();
	});

	it("gives a row naming no subject the holder of its address, or mints one there, once", () => {
		const { db, subjects } = bare();
		hold(db, "s1", CART);

		expect(subjects.placeRow({ subjectId: null, recordedAs: CART, at: 5 })).toEqual({
			placed: true,
			subjectId: "s1",
		});

		const first = subjects.placeRow({ subjectId: null, recordedAs: SHOP, at: 5 });
		const again = subjects.placeRow({ subjectId: null, recordedAs: SHOP, at: 9 });
		expect(first.placed && again.placed && first.subjectId === again.subjectId).toBe(true);
		expect(subjects.forAddress(SHOP)).toMatchObject({ state: "bound", boundAt: 5, evidence: "none" });
		expect(count(db)).toBe(2);
		db.close();
	});

	it("mints past an id already taken, so two addresses placed in one millisecond stay apart", () => {
		const { db, subjects } = bare();
		hold(db, mintSubjectId(SHOP, 5), STORE);

		const placed = subjects.placeRow({ subjectId: null, recordedAs: SHOP, at: 5 });
		expect(placed).toEqual({ placed: true, subjectId: mintSubjectId(SHOP, 5, 1) });
		expect(subjects.forAddress(STORE)?.subjectId).toBe(mintSubjectId(SHOP, 5));
		db.close();
	});
});

describe("normalizing the salvage", () => {
	it("drops a row it cannot place or read, and counts each", () => {
		const normalized = normalizeSalvaged(
			{
				knowledge_subjects: [{ subjectId: "s1" }, { subjectId: "s2", currentSymbolId: CART }],
				answers: [
					{ subjectId: "s2", recordedAs: CART, symbolId: SHOP, prose: "p", factId: "f1" },
					{ recordedAs: CART, factId: "f2" },
					{ subjectId: "s2", recordedAs: CART, prose: "p" },
					{ prose: "p", factId: "f3" },
				],
				gaps: [{ symbolId: CART, askCount: 2 }, { askCount: 1 }],
			},
			7,
		);

		// The address recorded wins over the older address column when a row carries both.
		expect(normalized.dropped).toBe(5);
		expect(normalized.subjects.map((row) => row.subjectId)).toEqual(["s2"]);
		expect(normalized.answers).toEqual([
			{
				subjectId: "s2",
				recordedAs: CART,
				question: "describe",
				factId: "f1",
				prose: "p",
				citations: "[]",
				thin: 0,
				model: null,
				createdAt: 0,
				doubtId: null,
				doubtReason: null,
				doubtAt: null,
				doubtBy: null,
			},
		]);
		expect(normalized.gaps).toEqual([
			{ subjectId: null, recordedAs: CART, question: "describe", askCount: 2, lastAsked: 0 },
		]);
	});

	it("reads numbers a text column stored as strings, drops citations that do not read back, and treats an empty address as none", () => {
		const normalized = normalizeSalvaged(
			{
				answers: [
					{ recordedAs: "", symbolId: CART, prose: "p", factId: "f1", thin: true, createdAt: "1700" },
					{ symbolId: CART, question: "why", prose: "p", factId: "f2", citations: "not json" },
					{ symbolId: CART, question: "relate", prose: "p", factId: "f3", citations: '["x", 1]' },
				],
				gaps: [
					{ symbolId: CART, askCount: "2", lastAsked: "4" },
					{ recordedAs: "", askCount: 1 },
				],
			},
			7,
		);

		expect(normalized.dropped).toBe(3);
		expect(normalized.answers.map((row) => [row.recordedAs, row.thin, row.createdAt])).toEqual([[CART, 1, 1700]]);
		expect(normalized.gaps).toEqual([
			{ subjectId: null, recordedAs: CART, question: "describe", askCount: 2, lastAsked: 4 },
		]);
	});

	it("keeps a doubt whose stamp a text column stored, and counts in whole numbers", () => {
		const normalized = normalizeSalvaged(
			{
				answers: [
					{ symbolId: CART, prose: "p", factId: "f1", doubtId: "d", doubtReason: "r", doubtAt: "1700" },
				],
				gaps: [{ symbolId: CART, askCount: 1.5, lastAsked: 4.9 }],
			},
			7,
		);

		expect(normalized.answers[0]).toMatchObject({ doubtId: "d", doubtReason: "r", doubtAt: 1700 });
		expect(normalized.gaps[0]).toMatchObject({ askCount: 1, lastAsked: 4 });
	});
});

describe("a rebuild across a compatibility key", () => {
	let dir: string;
	let file: string;
	let store: IndexStore;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lexicon-placement-"));
		file = path.join(dir, "index.sqlite");
		store = IndexStore.open(file, "major-a").store;
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const declare = (symbolId: string, name: string, line: number) => ({
		symbolId,
		kind: "class" as const,
		name,
		range: at(line),
		selectionRange: at(line),
		visibility: "public" as const,
	});

	it("keeps a surviving subject, refuses a lost one whose address another holds, and recalls the rest", async () => {
		const service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		store.replaceFile("a.ref", "h1", [declare(CART, "Cart", 0), declare(SHOP, "Shop", 1)], []);
		const cited = (symbolId: string) => store.declaration(symbolId)?.factId as string;
		await service.recordAnswer(CART, "describe", "The cart.", [cited(CART)]);
		await service.recordAnswer(SHOP, "describe", "The shop.", [cited(SHOP)]);
		const shop = store.subjects.forAddress(SHOP)?.subjectId as string;
		// The shop's subject moves on and a new one takes its old address, as a refactor then a write do.
		store.subjects.rebind([{ from: SHOP, to: STORE }], "journalMove", 5);
		store.subjects.mint(SHOP, 6);
		store.close();

		// Only the subject row is lost; the answer it keyed still names the address another now holds.
		const db = new DatabaseSync(file);
		db.prepare("DELETE FROM knowledge_subjects WHERE subjectId = ?").run(shop);
		db.close();

		const reopened = IndexStore.open(file, "major-b");
		store = reopened.store;
		expect(reopened).toMatchObject({ rebuilt: true, unplaced: 1 });
		expect(reopened.dropped).toBeUndefined();

		const again = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		store.replaceFile("a.ref", "h1", [declare(CART, "Cart", 0)], []);
		expect(again.recallAnswer(CART, "describe")?.answer.prose).toBe("The cart.");
		expect(store.subjects.byId(shop)).toBeNull();
		expect(store.subjects.forAddress(SHOP)?.subjectId).not.toBe(shop);
	});

	it("revives a lost subject where it was last written about, whatever order the rows come back in", async () => {
		const service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		store.replaceFile("a.ref", "h1", [declare(SHOP, "Shop", 0), declare(STORE, "Store", 1)], []);
		const cited = (symbolId: string) => store.declaration(symbolId)?.factId as string;
		await service.recordAnswer(SHOP, "describe", "The shop.", [cited(SHOP)]);
		const shop = store.subjects.forAddress(SHOP)?.subjectId as string;
		store.subjects.rebind([{ from: SHOP, to: STORE }], "journalMove", 5);
		await service.recordAnswer(STORE, "why", "Because.", [cited(STORE)]);
		store.close();

		const db = new DatabaseSync(file);
		db.prepare("DELETE FROM knowledge_subjects WHERE subjectId = ?").run(shop);
		db.close();

		const reopened = IndexStore.open(file, "major-b");
		store = reopened.store;
		expect(reopened.unplaced).toBeUndefined();
		expect(store.subjects.byId(shop)).toMatchObject({ symbolId: STORE, state: "bound", evidence: "none" });
		store.replaceFile("a.ref", "h1", [declare(STORE, "Store", 1)], []);
		const again = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		expect(again.recallAnswer(STORE, "describe")?.answer.prose).toBe("The shop.");
		expect(again.recallAnswer(STORE, "why")?.answer.prose).toBe("Because.");
	});

	it("places rows that name a subject before rows that only name an address, so the address joins the subject", () => {
		store.close();
		const db = new DatabaseSync(file);
		db.exec("DROP TABLE answers; DROP TABLE gaps;");
		db.exec(`CREATE TABLE answers (symbolId TEXT, question TEXT, factId TEXT, prose TEXT, citations TEXT, createdAt INTEGER);
			CREATE TABLE gaps (subjectId TEXT, recordedAs TEXT, question TEXT, askCount INTEGER, lastAsked INTEGER);`);
		db.prepare(
			"INSERT INTO answers VALUES (?, 'describe', 'lexfact answer a.ref 0000000000000001', 'The cart.', '[]', 9)",
		).run(CART);
		db.prepare("INSERT INTO gaps VALUES ('lost-subject', ?, 'why', 3, 1)").run(CART);
		db.exec("PRAGMA user_version = 12");
		db.close();

		const reopened = IndexStore.open(file, "major-a");
		store = reopened.store;
		expect(reopened.unplaced).toBeUndefined();
		expect(store.subjects.forAddress(CART)?.subjectId).toBe("lost-subject");
		expect(store.subjects.stateOf(CART, () => null)).toMatchObject({
			subject: "lost-subject",
			answers: 1,
			gaps: 1,
		});
	});

	it("refuses a lost subject whole when its newest address is held, never reviving it from an older row", () => {
		store.close();
		const db = new DatabaseSync(file);
		db.prepare(
			"INSERT INTO knowledge_subjects (subjectId, currentSymbolId, state, boundAt, evidence) VALUES ('holder', ?, 'bound', 1, 'sameLocator')",
		).run(CART);
		const answer = db.prepare(
			"INSERT INTO answers (subjectId, question, recordedAs, factId, prose, citations, createdAt) VALUES (?, ?, ?, ?, 'p', '[]', ?)",
		);
		answer.run("holder", "describe", CART, "lexfact answer a.ref 0000000000000001", 5);
		answer.run("lost", "describe", CART, "lexfact answer a.ref 0000000000000002", 20);
		answer.run("lost", "why", SHOP, "lexfact answer a.ref 0000000000000003", 10);
		db.exec("PRAGMA user_version = 12");
		db.close();

		const reopened = IndexStore.open(file, "major-a");
		store = reopened.store;
		expect(reopened).toMatchObject({ rebuilt: true, unplaced: 2 });
		expect(store.subjects.byId("lost")).toBeNull();
		expect(store.subjects.forAddress(SHOP)).toBeNull();
		expect(store.subjects.stateOf(CART, () => null)).toMatchObject({ subject: "holder", answers: 1 });
	});

	it("carries an open refactor journal across the rebuild", () => {
		expect(new TransactionManager(store, dir).start().started).toBe(true);
		store.close();

		store = IndexStore.open(file, "major-b").store;
		expect(new TransactionManager(store, dir).status().open).toBe(true);
	});

	it("mints for rows written by address under an old schema, and counts the unreadable ones", () => {
		store.close();
		const db = new DatabaseSync(file);
		db.exec("DROP TABLE answers; DROP TABLE gaps;");
		db.exec(`CREATE TABLE answers (symbolId TEXT, question TEXT, factId TEXT, prose TEXT, citations TEXT, createdAt INTEGER);
			CREATE TABLE gaps (symbolId TEXT, question TEXT, askCount INTEGER, lastAsked INTEGER);`);
		db.prepare(
			"INSERT INTO answers VALUES (?, 'describe', 'lexfact answer a.ref 0000000000000001', 'The cart.', '[]', 3)",
		).run(CART);
		db.prepare("INSERT INTO answers VALUES (?, 'why', 'lexfact answer a.ref 0000000000000002', NULL, '[]', 3)").run(
			CART,
		);
		db.prepare("INSERT INTO gaps VALUES (?, 'why', 2, 4)").run(CART);
		db.exec("PRAGMA user_version = 12");
		db.close();

		const reopened = IndexStore.open(file, "major-a");
		store = reopened.store;
		expect(reopened).toMatchObject({ rebuilt: true, dropped: 1 });
		expect(reopened.unplaced).toBeUndefined();

		// One subject for the address, shared by the answer and the demand, minted with no evidence.
		const subject = store.subjects.forAddress(CART);
		expect(subject).toMatchObject({ state: "bound", evidence: "none" });
		const service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		store.replaceFile("a.ref", "h1", [declare(CART, "Cart", 0)], []);
		expect(service.recallAnswer(CART, "describe")?.answer.prose).toBe("The cart.");
		expect(store.liveGaps(10).map((gap) => [gap.question, gap.askCount])).toEqual([["why", 2]]);
	});
});
