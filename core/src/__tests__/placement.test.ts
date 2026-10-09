import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../database";
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

function bare(): { db: Database; subjects: KnowledgeSubjects } {
	const db = Database.open(":memory:");
	db.exec(KNOWLEDGE_SCHEMA);
	return { db, subjects: new KnowledgeSubjects(db) };
}

function hold(db: Database, subjectId: string, symbolId: string): void {
	db.prepare(
		"INSERT INTO knowledge_subjects (subjectId, currentSymbolId, state, boundAt, evidence) VALUES (?, ?, 'bound', 1, 'sameLocator')",
	).run(subjectId, symbolId);
}

const count = (db: Database) => (db.prepare("SELECT COUNT(*) AS n FROM knowledge_subjects").get() as { n: number }).n;

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
	it("drops a row it cannot place or read, and counts each; the recorded address wins over the older column", () => {
		const normalized = normalizeSalvaged(
			{
				knowledge_subjects: [{ subjectId: "s1" }, { subjectId: "s2", currentSymbolId: CART }],
				symbol_notes: [
					{ subjectId: "s2", recordedAs: CART, symbolId: SHOP, text: "p" },
					{ subjectId: "s2", text: "p" },
					{ subjectId: "s2", recordedAs: CART, text: "" },
				],
			},
			7,
		);

		expect(normalized.dropped).toBe(3);
		expect(normalized.subjects.map((row) => row.subjectId)).toEqual(["s2"]);
		expect(normalized.notes).toMatchObject([{ subjectId: "s2", recordedAs: CART, revision: 1, text: "p" }]);
	});

	it("reads numbers a text column stored as strings in whole numbers, treats an empty address as none, and keeps a doubt", () => {
		const normalized = normalizeSalvaged(
			{
				symbol_notes: [
					{
						recordedAs: "",
						symbolId: CART,
						text: "p",
						revision: "2.5",
						authoredAt: "1700",
						doubtReason: "r",
						doubtAt: "1800",
					},
				],
			},
			7,
		);

		expect(normalized.notes).toMatchObject([
			{ recordedAs: CART, revision: 2, authoredAt: 1700, doubtReason: "r", doubtAt: 1800 },
		]);
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

	/** Writes, or rewrites, the note at an address. */
	const note = (service: LexiconService, symbolId: string, text: string) => {
		const expectedRevision = store.notes.byAddress(symbolId)?.revision ?? 0;
		const outcome = service.writeNote({ symbolId, text, expectedRevision });
		if (outcome.outcome === "refused") throw new Error(outcome.reason);
	};

	it("keeps a surviving subject, refuses a lost one whose address another holds, and reads the rest", () => {
		const service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		store.replaceFile({
			module: "a.ref",
			contentHash: "h1",
			declarations: [declare(CART, "Cart", 0), declare(SHOP, "Shop", 1)],
			references: [],
		});
		note(service, CART, "The cart.");
		note(service, SHOP, "The shop.");
		const shop = store.subjects.forAddress(SHOP)?.subjectId as string;
		// The shop's subject moves on and a new one takes its old address, as a refactor then a write do.
		store.journalWrite(() => {
			store.subjects.rebind([{ from: SHOP, to: STORE }], "journalMove", 5);
			store.subjects.mint(SHOP, 6);
		});
		store.close();

		// Only the subject row is lost; the note it keyed still names the address another now holds.
		const db = Database.open(file);
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
		expect(again.readNote(CART)?.text).toBe("The cart.");
		expect(store.subjects.byId(shop)).toBeNull();
		expect(store.subjects.forAddress(SHOP)?.subjectId).not.toBe(shop);
	});

	it("revives a lost subject where its note was last saved", () => {
		const service = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		store.replaceFile({
			module: "a.ref",
			contentHash: "h1",
			declarations: [declare(SHOP, "Shop", 0), declare(STORE, "Store", 1)],
			references: [],
		});
		note(service, SHOP, "The shop.");
		const shop = store.subjects.forAddress(SHOP)?.subjectId as string;
		store.journalWrite(() => store.subjects.rebind([{ from: SHOP, to: STORE }], "journalMove", 5));
		note(service, STORE, "Because.");
		store.close();

		const db = Database.open(file);
		db.prepare("DELETE FROM knowledge_subjects WHERE subjectId = ?").run(shop);
		db.close();

		const reopened = IndexStore.open(file, "major-b");
		store = reopened.store;
		expect(reopened.unplaced).toBeUndefined();
		expect(store.subjects.byId(shop)).toMatchObject({ symbolId: STORE, state: "bound", evidence: "none" });
		const again = new LexiconService(
			store,
			new ProviderSupervisor(),
			fromText(() => null),
			dir,
		);
		expect(again.readNote(STORE)?.text).toBe("Because.");
	});

	it("carries an open refactor journal across the rebuild", () => {
		expect(new TransactionManager(store, dir).start().started).toBe(true);
		store.close();

		store = IndexStore.open(file, "major-b").store;
		expect(new TransactionManager(store, dir).status().open).toBe(true);
	});
});
