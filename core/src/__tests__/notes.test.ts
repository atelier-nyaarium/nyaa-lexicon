import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NoteAuthor, SymbolKind } from "@nyaa-lexicon/protocol";
import type { NoteWrite } from "../notes";
import * as refusal from "../refusals";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore, SCHEMA_VERSION } from "../store";
import { KNOWLEDGE_VIEWS } from "../subjects";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let dir: string;
let file: string;
let store: IndexStore;
let service: LexiconService;

const CART = "lexicon reference a.ref Cart#";
const TROLLEY = "lexicon reference a.ref Trolley#";
const BASKET = "lexicon reference b.ref Basket#";
const PERSON: NoteAuthor = { kind: "person" };
const AGENT: NoteAuthor = { kind: "agent", model: "gpt-6-luna", via: "test", run: null };
const HOLDS = "Holds a [Cart](ref://a.ref:Cart) per shopper.";

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

/** One module's declarations, classes by default, each with the digest a full parse would mint. */
function plant(
	module: string,
	entries: Array<{ symbolId: string; name: string; digest: string; containerId?: string; kind?: SymbolKind }>,
): void {
	store.replaceFile({
		module,
		contentHash: entries.map((entry) => entry.digest).join(""),
		declarations: entries.map((entry, line) => ({
			symbolId: entry.symbolId,
			kind: entry.kind ?? "class",
			name: entry.name,
			range: at(line),
			selectionRange: at(line),
			visibility: "public" as const,
			...(entry.containerId === undefined ? {} : { containerId: entry.containerId }),
		})),
		references: [],
		imports: [],
		literals: [],
		depth: "full",
		comments: [],
		docs: [],
		notes: [],
		content: "code",
		digests: entries.map((entry) => ({
			symbolId: entry.symbolId,
			patternDigest: entry.digest,
			patternCoverage: "commentsStripped" as const,
		})),
	});
}

function plantBoth(cartDigest = "c1", basketDigest = "b1"): void {
	plant("a.ref", [{ symbolId: CART, name: "Cart", digest: cartDigest }]);
	plant("b.ref", [{ symbolId: BASKET, name: "Basket", digest: basketDigest }]);
}

/** The pending proposal's `at`, as a person would be shown it. */
function shownAt(symbolId = BASKET): number {
	return service.readNote(symbolId)?.proposal?.at ?? -1;
}

function note(fields: Partial<NoteWrite> = {}): NoteWrite {
	return { symbolId: BASKET, text: HOLDS, expectedRevision: 0, author: PERSON, ...fields };
}

function saved(outcome: ReturnType<LexiconService["writeNote"]>) {
	if (outcome.outcome !== "saved") throw new Error(outcome.outcome === "refused" ? outcome.reason : "proposed");
	return outcome.note;
}

function reopen(): void {
	store = IndexStore.open(file).store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(),
		fromText(() => null),
		dir,
	);
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-notes-"));
	file = path.join(dir, "index.sqlite");
	reopen();
	plantBoth();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("writing a note", () => {
	it("opens with a plain sentence, and empty text removes the note", () => {
		const openings: Array<[string, string]> = [
			["# Basket", "heading"],
			["Basket\n===\n\nHolds carts.", "heading"],
			["- one cart\n- another", "list"],
			["> quoted", "quote"],
			["```mermaid\ngraph LR\n```", "code block"],
			["\n    const cart = new Cart();", "code block"],
			["<details>\nMore\n</details>", "HTML block"],
			// A paragraph as sent, a heading as stored once trimmed.
			[`${String.fromCharCode(0xa0)}# Basket`, "heading"],
		];
		for (const [text, block] of openings) {
			expect(service.writeNote(note({ text }))).toMatchObject({
				outcome: "refused",
				reason: refusal.noteOpensWith(block),
			});
		}

		const text = "Holds carts.\n\n## Why\n\nOne per shopper.";
		expect(saved(service.writeNote(note({ text: `  ${text}  ` })))).toMatchObject({
			revision: 1,
			text,
			summary: "Holds carts.",
			restAt: "Holds carts.".length,
		});
		expect(saved(service.writeNote(note({ text: " \n ", expectedRevision: 1 })))).toBeNull();
		expect(service.readNote(BASKET)).toBeNull();
	});

	it("refuses a revision that moved, handing back the note as it stands", () => {
		saved(service.writeNote(note()));
		const stale = service.writeNote(note({ text: "Holds items." }));
		expect(stale).toMatchObject({
			outcome: "refused",
			reason: refusal.noteRevisionMoved(0, 1),
			current: { revision: 1 },
		});
	});

	it("refuses a ref that names nothing, where it was written, with candidates, and saves nothing", () => {
		plant("a.ref", [
			{ symbolId: CART, name: "Cart", digest: "c1" },
			{ symbolId: `${CART}Item#`, name: "Item", digest: "i1", containerId: CART },
		]);
		const text = "  \r\nHolds a [cart](ref://a.ref:Ghost).\n\nEach [item](ref://a.ref:Cart:Ghost).";
		expect(service.writeNote(note({ text }))).toMatchObject({
			outcome: "refused",
			refs: [
				{
					ref: "ref://a.ref:Ghost",
					at: text.indexOf("ref://a.ref:Ghost"),
					candidates: ["ref://a.ref:Cart", "ref://a.ref:Cart:Item"],
				},
				{
					ref: "ref://a.ref:Cart:Ghost",
					at: text.indexOf("ref://a.ref:Cart:Ghost"),
					candidates: ["ref://a.ref:Cart:Item"],
				},
			],
		});
		expect(service.readNote(BASKET)).toBeNull();
	});
});

describe("a note's refs over time", () => {
	it("follow their target through a rename, reading at its new address in either link form", () => {
		saved(service.writeNote(note({ text: `${HOLDS}\n\nAlso [the cart](<ref://a.ref:Cart>).` })));
		plant("a.ref", [{ symbolId: TROLLEY, name: "Trolley", digest: "c1" }]);
		store.subjects.rebind([{ from: CART, to: TROLLEY }], "journalMove", 9);

		expect(service.readNote(BASKET)).toMatchObject({
			text: "Holds a [Cart](ref://a.ref:Trolley) per shopper.\n\nAlso [the cart](<ref://a.ref:Trolley>).",
			links: [{ written: "ref://a.ref:Cart", current: "ref://a.ref:Trolley", symbolId: TROLLEY, state: "ok" }],
		});
		expect(service.noteBacklinks(TROLLEY).notes).toEqual([
			{ symbolId: BASKET, summary: "Holds a [Cart](ref://a.ref:Trolley) per shopper." },
		]);
	});

	it("mark a changed target and changed source until confirmed, and a doubt until then too", () => {
		saved(service.writeNote(note()));
		plantBoth("c2", "b2");
		expect(service.doubtNote(BASKET, "it held one once", 7, AGENT)).toMatchObject({ outcome: "refused" });
		service.doubtNote(BASKET, "it holds several", 1, AGENT);

		expect(service.readNote(BASKET)).toMatchObject({
			sourceChanged: true,
			links: [{ state: "changed" }],
			doubt: { reason: "it holds several", by: AGENT },
		});
		expect(saved(service.confirmNote(BASKET, 1, PERSON))).toMatchObject({
			sourceChanged: false,
			links: [{ state: "ok" }],
			doubt: null,
			confirmedBy: PERSON,
		});
	});

	it("read broken once the target is gone, keeping the text as written", () => {
		saved(service.writeNote(note()));
		plant("a.ref", []);

		expect(service.readNote(BASKET)).toMatchObject({
			text: HOLDS,
			links: [{ current: "ref://a.ref:Cart", state: "broken" }],
		});
	});

	it("name a whole file, found by its path", () => {
		saved(service.writeNote(note({ text: "Holds carts. See [the cart file](ref://a.ref)." })));
		expect(service.readNote(BASKET)?.links).toEqual([
			expect.objectContaining({ written: "ref://a.ref", state: "ok" }),
		]);
		expect(service.noteBacklinks("a.ref").notes.map((entry) => entry.symbolId)).toEqual([BASKET]);
	});
});

describe("whose words an agent may replace", () => {
	it("turns an agent's write over a person's note into a proposal, which the person's next save drops", () => {
		saved(service.writeNote(note()));
		const proposed = service.writeNote(note({ text: "Holds items.", expectedRevision: 1, author: AGENT }));

		expect(proposed).toMatchObject({
			outcome: "proposed",
			note: { revision: 1, text: HOLDS, proposal: { text: "Holds items.", by: AGENT } },
		});
		expect(saved(service.writeNote(note({ text: "Holds carts.", expectedRevision: 1 })))).toMatchObject({
			revision: 2,
			proposal: null,
		});
	});

	it("keeps a proposal's refs on their targets, so accepting after a rename links the same symbol", () => {
		saved(service.writeNote(note({ text: "Holds items." })));
		service.writeNote(note({ text: "Wraps a [Cart](ref://a.ref:Cart).", expectedRevision: 1, author: AGENT }));
		plant("a.ref", [
			{ symbolId: TROLLEY, name: "Trolley", digest: "c1" },
			{ symbolId: CART, name: "Cart", digest: "other" },
		]);
		store.subjects.rebind([{ from: CART, to: TROLLEY }], "journalMove", 9);

		expect(service.readNote(BASKET)?.proposal?.text).toBe("Wraps a [Cart](ref://a.ref:Trolley).");
		expect(saved(service.resolveNoteProposal(BASKET, true, 1, shownAt(), PERSON))).toMatchObject({
			revision: 2,
			links: [{ symbolId: TROLLEY }],
		});
	});

	it("refuses to resolve a proposal replaced since it was shown, and removes the note on an empty one", () => {
		saved(service.writeNote(note()));
		service.writeNote(note({ text: "Holds items.", expectedRevision: 1, author: AGENT }));
		const shown = shownAt();
		service.writeNote(note({ text: "", expectedRevision: 1, author: AGENT }));

		expect(service.resolveNoteProposal(BASKET, true, 1, shown, PERSON).outcome).toBe("refused");
		expect(saved(service.resolveNoteProposal(BASKET, true, 1, shownAt(), PERSON))).toBeNull();
		expect(service.readNote(BASKET)).toBeNull();
	});

	it("rejects a proposal without a new revision, and replaces an agent's note in place", () => {
		saved(service.writeNote(note()));
		service.writeNote(note({ text: "Holds items.", expectedRevision: 1, author: AGENT }));
		expect(saved(service.resolveNoteProposal(BASKET, false, 1, shownAt(), PERSON))).toMatchObject({
			revision: 1,
			proposal: null,
		});

		const agents = note({ symbolId: CART, text: "A cart.", author: AGENT });
		saved(service.writeNote(agents));
		expect(saved(service.writeNote({ ...agents, text: "A trolley.", expectedRevision: 1 }))).toMatchObject({
			revision: 2,
			author: AGENT,
		});
	});
});

describe("searching for a ref", () => {
	it("lists source before tests, own code before dependencies, and files after declarations", () => {
		plant("src/__tests__/cart.test.ref", [
			{ symbolId: "lexicon reference src/__tests__/cart.test.ref Cart#", name: "Cart", digest: "t1" },
		]);
		plant("src/cart.ref", [{ symbolId: "lexicon reference src/cart.ref Cart#", name: "Cart", digest: "s1" }]);
		plant("src/shop.ref", [
			{ symbolId: "lexicon reference src/shop.ref ShopCart#", name: "ShopCart", digest: "p1" },
			{
				symbolId: "lexicon reference src/shop.ref cartTotal().",
				name: "cartTotal",
				digest: "p2",
				kind: "function",
			},
		]);
		plant("node_modules/zod/cart.ref", [
			{ symbolId: "lexicon reference node_modules/zod/cart.ref Carton#", name: "Carton", digest: "v1" },
		]);

		expect(service.searchRefs("Cart").results.map((entry) => [entry.kind, entry.ref])).toEqual([
			["class", "ref://a.ref:Cart"],
			["class", "ref://src/cart.ref:Cart"],
			["class", "ref://src/__tests__/cart.test.ref:Cart"],
			["function", "ref://src/shop.ref:cartTotal"],
			["class", "ref://src/shop.ref:ShopCart"],
			["class", "ref://node_modules/zod/cart.ref:Carton"],
			["file", "ref://src/cart.ref"],
			["file", "ref://src/__tests__/cart.test.ref"],
			["file", "ref://node_modules/zod/cart.ref"],
		]);

		const refs = (kinds: SymbolKind[]) =>
			service.searchRefs("Cart", undefined, kinds).results.map((entry) => entry.ref);
		expect({ functions: refs(["function"]), files: refs(["file"]), none: refs([]) }).toEqual({
			functions: ["ref://src/shop.ref:cartTotal"],
			files: ["ref://src/cart.ref", "ref://src/__tests__/cart.test.ref", "ref://node_modules/zod/cart.ref"],
			none: [],
		});
	});
});

describe("a store with four-field notes", () => {
	const OLD_TABLES = `
		CREATE TABLE symbol_notes (subjectId TEXT PRIMARY KEY, recordedAs TEXT NOT NULL, revision INTEGER NOT NULL,
			summary TEXT, description TEXT, why TEXT, gotchas TEXT, author TEXT, authoredAt INTEGER NOT NULL,
			editedBy TEXT, editedAt INTEGER NOT NULL, confirmedBy TEXT, confirmedAt INTEGER, sourceDigest TEXT,
			doubtBy TEXT, doubtReason TEXT, doubtAt INTEGER);
		CREATE TABLE symbol_note_links (subjectId TEXT NOT NULL, field TEXT NOT NULL, written TEXT NOT NULL,
			target TEXT NOT NULL, targetDigest TEXT, PRIMARY KEY (subjectId, field, written));
		CREATE TABLE symbol_note_proposals (subjectId TEXT PRIMARY KEY, baseRevision INTEGER NOT NULL, summary TEXT,
			description TEXT, why TEXT, gotchas TEXT, proposedBy TEXT, proposedAt INTEGER NOT NULL);
	`;

	/** Four-field notes: a seed on Cart, a person's on Basket. */
	function writeFourFields(): void {
		saved(service.writeNote(note({ symbolId: CART, text: "A cart.", author: undefined })));
		saved(service.writeNote(note()));
		store.close();
		const db = new DatabaseSync(file);
		const subject = (symbolId: string) =>
			(
				db.prepare("SELECT subjectId FROM subjects_addressed WHERE symbolId = ?").get(symbolId) as {
					subjectId: string;
				}
			).subjectId;
		const cart = subject(CART);
		const basket = subject(BASKET);
		for (const view of KNOWLEDGE_VIEWS) db.exec(`DROP VIEW IF EXISTS "${view}"`);
		db.exec("DROP TABLE symbol_notes; DROP TABLE symbol_note_links; DROP TABLE symbol_note_proposals;");
		db.exec(OLD_TABLES);
		const row = db.prepare(
			`INSERT INTO symbol_notes (subjectId, recordedAs, revision, summary, description, why, gotchas, author,
			 authoredAt, editedBy, editedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		row.run(cart, CART, 1, "Seeded from a sweep.", null, null, null, null, 5, null, 5);
		const person = JSON.stringify(PERSON);
		row.run(basket, BASKET, 1, HOLDS, null, "One per shopper.", null, person, 20, person, 20);
		db.prepare(
			`INSERT INTO symbol_note_proposals (subjectId, baseRevision, summary, description, proposedBy, proposedAt)
			 VALUES (?, 1, ?, ?, ?, 30)`,
		).run(basket, "Holds items.", "Pairs with [Cart](ref://a.ref:Cart).", JSON.stringify(AGENT));
		const link = db.prepare("INSERT INTO symbol_note_links VALUES (?, ?, 'ref://a.ref:Cart', ?, 'c1')");
		link.run(basket, "summary", cart);
		link.run(basket, "proposal:description", cart);
		db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('notesSeeded', '10')").run();
		db.close();
	}

	it.each([
		["opened in place", false],
		["rebuilt", true],
	])("drops untouched seeds and joins the rest into one text when %s", (_how, rebuild) => {
		writeFourFields();
		if (rebuild) {
			const db = new DatabaseSync(file);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
			db.close();
		}
		reopen();
		if (rebuild) plantBoth();

		expect(service.readNote(CART)).toBeNull();
		expect(service.readNote(BASKET)).toMatchObject({
			text: `${HOLDS}\n\nOne per shopper.`,
			links: [{ symbolId: CART, state: "ok" }],
			proposal: {
				text: "Holds items.\n\nPairs with [Cart](ref://a.ref:Cart).",
				by: AGENT,
				links: [{ symbolId: CART }],
			},
		});
		expect(service.noteBacklinks(CART).notes).toEqual([{ symbolId: BASKET, summary: HOLDS }]);
	});

	it("checks a carried proposal's text again when a person accepts it", () => {
		writeFourFields();
		const db = new DatabaseSync(file);
		db.exec("UPDATE symbol_note_proposals SET summary = NULL, description = '## Items\n\nHolds items.'");
		db.close();
		reopen();

		expect(service.resolveNoteProposal(BASKET, true, 1, shownAt(), PERSON)).toMatchObject({
			outcome: "refused",
			reason: refusal.noteOpensWith("heading"),
		});
	});

	it("opens a store missing a four-field table, reading it as empty", () => {
		writeFourFields();
		const db = new DatabaseSync(file);
		db.exec("DROP TABLE symbol_note_links; DROP TABLE symbol_note_proposals;");
		db.close();
		reopen();

		expect(service.readNote(BASKET)).toMatchObject({ text: `${HOLDS}\n\nOne per shopper.`, proposal: null });
	});
});

describe("a store rebuild", () => {
	it("carries notes, their links and proposals", () => {
		saved(service.writeNote(note({ text: `${HOLDS}\n\nPairs with [Cart](ref://a.ref:Cart).` })));
		service.writeNote(note({ text: "Holds items.", expectedRevision: 1, author: AGENT }));
		const before = service.readNote(BASKET);
		store.close();
		const db = new DatabaseSync(file);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
		db.close();

		reopen();
		plantBoth();

		expect(service.readNote(BASKET)).toEqual(before);
	});
});
