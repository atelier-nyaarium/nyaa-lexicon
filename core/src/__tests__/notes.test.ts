import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { workspaceKey } from "@nyaa-lexicon/client";
import { formatRef, NOTE_MAX, type NoteAuthor, type SymbolKind } from "@nyaa-lexicon/protocol";
import type { NoteWrite } from "../notes";
import * as refusal from "../refusals";
import { fromText, sourceReader } from "../sourceRead";
import { IndexStore, SCHEMA_VERSION } from "../store";
import { KNOWLEDGE_VIEWS } from "../subjects";
import { forgetPlain, writePlain } from "./admissions";
import {
	TestLexiconService as LexiconService,
	TestProviderSupervisor as ProviderSupervisor,
	testPolicy,
} from "./testPolicy";

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
const ref = (module: string, ...segments: string[]) => formatRef(workspaceKey(dir), module, segments);
const HOLDS = () => `Holds a [Cart](${ref("a.ref", "Cart")}) per shopper.`;

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

/** One module's declarations, classes by default, each with the digest a full parse would mint. */
function plant(
	module: string,
	entries: Array<{ symbolId: string; name: string; digest: string; containerId?: string; kind?: SymbolKind }>,
): void {
	writePlain(store, {
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

function note(fields: Partial<NoteWrite> = {}): NoteWrite {
	return { symbolId: BASKET, text: HOLDS(), expectedRevision: 0, author: PERSON, ...fields };
}

function saved(outcome: ReturnType<LexiconService["writeNote"]>) {
	if (outcome.outcome === "refused") throw new Error(outcome.reason);
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

async function denyModule(module: string, reconcile = true): Promise<void> {
	service = new LexiconService(
		store,
		new ProviderSupervisor(),
		fromText(() => null),
		dir,
		undefined,
		testPolicy(dir, { deny: [module] }),
	);
	await service.currentScope();
	if (reconcile) await service.reconcileSecretPolicy();
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
	it("refuses a ref from another project with a recovery action", () => {
		const outcome = service.writeNote(note({ text: "Holds a [Cart](project-ref://foreign-project/a.ref:Cart)." }));
		expect(outcome).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("edit or remove each broken link"),
			refs: [{ problem: expect.stringContaining("Use a ref for") }],
		});
	});

	it("rejects old ref links while leaving code literals alone", () => {
		for (const text of [
			"Holds a [Cart](ref://a.ref:Cart).",
			'Holds carts.\n\n```mermaid\ngraph LR\nA --> B\nclick A "ref://a.ref:Cart"\n```',
		]) {
			const outcome = service.writeNote(note({ text }));
			expect(outcome).toMatchObject({
				outcome: "refused",
				refs: [{ ref: "ref://a.ref:Cart", problem: expect.stringContaining("Correct the ref syntax") }],
			});
		}

		const literal = service.writeNote(note({ text: "The old URI is `ref://a.ref:Cart`." }));
		expect(literal.outcome).toBe("saved");
	});

	it("asks to index or correct a link to an unindexed module", () => {
		const outcome = service.writeNote(note({ text: `Holds carts. See [the cart](${ref("missing.ref")}).` }));
		expect(outcome).toMatchObject({
			outcome: "refused",
			refs: [{ problem: expect.stringContaining("Index it, or correct the module path") }],
		});
	});

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
		const text = `  \r\nHolds a [cart](${ref("a.ref", "Ghost")}).\n\nEach [item](${ref("a.ref", "Cart", "Ghost")}).`;
		expect(service.writeNote(note({ text }))).toMatchObject({
			outcome: "refused",
			reason: expect.stringContaining("Choose a listed candidate"),
			refs: [
				{
					ref: ref("a.ref", "Ghost"),
					at: text.indexOf(ref("a.ref", "Ghost")),
					problem: expect.stringContaining("edit or remove the broken link"),
					candidates: [ref("a.ref", "Cart"), ref("a.ref", "Cart", "Item")],
				},
				{
					ref: ref("a.ref", "Cart", "Ghost"),
					at: text.indexOf(ref("a.ref", "Cart", "Ghost")),
					candidates: [ref("a.ref", "Cart", "Item")],
				},
			],
		});
		expect(service.readNote(BASKET)).toBeNull();
	});

	it("measures the note limit on stored text", () => {
		const text = `Holds carts.${" ".repeat(NOTE_MAX)}`;
		expect(saved(service.writeNote(note({ text })))).toMatchObject({ text: "Holds carts." });
	});
});

describe("a note's refs over time", () => {
	it("follow their target through a rename, reading at its new address in either link form", () => {
		saved(service.writeNote(note({ text: `${HOLDS()}\n\nAlso [the cart](<${ref("a.ref", "Cart")}>).` })));
		plant("a.ref", [{ symbolId: TROLLEY, name: "Trolley", digest: "c1" }]);
		store.journalWrite(() => store.subjects.rebind([{ from: CART, to: TROLLEY }], "journalMove", 9));

		expect(service.readNote(BASKET)).toMatchObject({
			text: `Holds a [Cart](${ref("a.ref", "Trolley")}) per shopper.\n\nAlso [the cart](<${ref("a.ref", "Trolley")}>).`,
			links: [
				{ written: ref("a.ref", "Cart"), current: ref("a.ref", "Trolley"), symbolId: TROLLEY, state: "ok" },
			],
		});
		expect(service.noteBacklinks(TROLLEY).notes).toEqual([
			{ symbolId: BASKET, summary: `Holds a [Cart](${ref("a.ref", "Trolley")}) per shopper.` },
		]);
	});

	it("clears changed-source and broken-link advisories on the next write", () => {
		saved(service.writeNote(note()));
		plantBoth("c2", "b2");
		expect(service.readNote(BASKET)).toMatchObject({
			sourceChanged: true,
			links: [{ state: "changed" }],
		});
		expect(
			saved(service.writeNote(note({ text: "Holds items.", expectedRevision: 1, author: AGENT }))),
		).toMatchObject({
			revision: 2,
			text: "Holds items.",
			sourceChanged: false,
			links: [],
		});

		saved(service.writeNote(note({ text: HOLDS(), expectedRevision: 2, author: AGENT })));
		plant("a.ref", []);
		expect(service.readNote(BASKET)?.links).toMatchObject([{ state: "broken" }]);
		expect(
			saved(service.writeNote(note({ text: "Holds carts.", expectedRevision: 3, author: AGENT }))),
		).toMatchObject({
			revision: 4,
			links: [],
		});
	});

	it("read broken once the target is gone, keeping the text as written", () => {
		saved(service.writeNote(note()));
		plant("a.ref", []);

		expect(service.readNote(BASKET)).toMatchObject({
			text: HOLDS(),
			links: [{ current: ref("a.ref", "Cart"), state: "broken" }],
		});
	});

	it("name a whole file, found by its path", () => {
		saved(service.writeNote(note({ text: `Holds carts. See [the cart file](${ref("a.ref")}).` })));
		expect(service.readNote(BASKET)?.links).toEqual([
			expect.objectContaining({ written: ref("a.ref"), state: "ok" }),
		]);
		expect(service.noteBacklinks("a.ref").notes.map((entry) => entry.symbolId)).toEqual([BASKET]);
	});

	it("reads a denied module ref as withheld", async () => {
		writeFileSync(path.join(dir, "a.ref"), "Cart");
		const text = `Holds carts. See [the file](${ref("a.ref")}).`;
		plant("a.ref", []);
		saved(service.writeNote(note({ text })));
		await denyModule("a.ref");

		expect(service.readNote(BASKET)).toMatchObject({ links: [{ written: ref("a.ref"), state: "withheld" }] });
	});

	it("reads a symbol ref in a denied module as withheld", async () => {
		writeFileSync(path.join(dir, "a.ref"), "Cart");
		saved(service.writeNote(note()));
		await denyModule("a.ref");

		expect(service.readNote(BASKET)).toMatchObject({
			links: [{ written: ref("a.ref", "Cart"), state: "withheld" }],
		});
	});

	it("keeps a denied module ref through an unchanged save and an edit", async () => {
		writeFileSync(path.join(dir, "a.ref"), "Cart");
		const text = `Holds carts. See [the file](${ref("a.ref")}).`;
		plant("a.ref", []);
		saved(service.writeNote(note({ text })));
		await denyModule("a.ref");

		expect(service.writeNote(note({ text, expectedRevision: 1 }))).toMatchObject({
			outcome: "saved",
			note: {
				revision: 2,
				links: [{ written: ref("a.ref"), state: "withheld" }],
			},
		});

		const edited = `Keeps the file ref.\n\n${text}`;
		expect(saved(service.writeNote(note({ text: edited, expectedRevision: 2 })))).toMatchObject({
			revision: 3,
			text: edited,
			links: [{ written: ref("a.ref"), state: "withheld" }],
		});
	});

	it("keeps backlinks to a denied module", async () => {
		writeFileSync(path.join(dir, "a.ref"), "Cart");
		const text = `Holds carts. See [the file](${ref("a.ref")}).`;
		plant("a.ref", []);
		saved(service.writeNote(note({ text })));
		await denyModule("a.ref");

		expect(service.noteBacklinks("a.ref").notes).toEqual([{ symbolId: BASKET, summary: text }]);
	});

	it("keeps a ref after its file leaves the index", () => {
		plant("a.ref", []);
		const text = `Holds carts. See [the file](${ref("a.ref")}).`;
		saved(service.writeNote(note({ text })));
		forgetPlain(store, "a.ref");

		expect(service.readNote(BASKET)).toMatchObject({ links: [{ written: ref("a.ref"), state: "broken" }] });
		expect(saved(service.writeNote(note({ text, expectedRevision: 1 })))).toMatchObject({
			revision: 2,
			links: [{ written: ref("a.ref"), state: "broken" }],
		});
	});

	it("refuses a new link to a denied file with its reason", async () => {
		writeFileSync(path.join(dir, "a.ref"), "Cart");
		plant("a.ref", []);
		await denyModule("a.ref", false);
		expect(store.depthOf("a.ref")).not.toBeNull();

		const outcome = service.writeNote(note({ text: `Holds carts. See [the file](${ref("a.ref")}).` }));
		expect(outcome).toMatchObject({
			outcome: "refused",
			reason: refusal.noteRefsWithheld(1),
			refs: [{ problem: refusal.refModuleWithheld("a.ref") }],
		});
	});

	it("reads unreadable guarded files as withheld and refuses new refs", () => {
		service = new LexiconService(store, new ProviderSupervisor(), sourceReader(dir), dir);
		writeFileSync(path.join(dir, "credentials.json"), '{"token":"value"}');
		plant("credentials.json", []);
		const text = `Holds carts. See [the file](${ref("credentials.json")}).`;
		saved(service.writeNote(note({ text })));
		writeFileSync(path.join(dir, "credentials.json"), new Uint8Array([0]));

		expect(service.readNote(BASKET)).toMatchObject({
			links: [{ written: ref("credentials.json"), state: "withheld" }],
		});
		const outcome = service.writeNote(
			note({ symbolId: CART, text: `Holds carts. See [the file](${ref("credentials.json")}).` }),
		);
		expect(outcome).toMatchObject({
			outcome: "refused",
			reason: refusal.noteRefsWithheld(1),
			refs: [{ problem: refusal.refModuleWithheld("credentials.json") }],
		});
	});

	it("links an omitted file by its module path", () => {
		writeFileSync(path.join(dir, "server.key"), "hidden");
		plant("server.key", []);
		saved(service.writeNote(note({ text: `Holds carts. See [the file](${ref("server.key")}).` })));

		expect(service.readNote(BASKET)?.links).toEqual([
			expect.objectContaining({ written: ref("server.key"), kind: "file", state: "ok" }),
		]);
	});
});

describe("note revisions", () => {
	it("lets every author replace the standing note with an expected revision", () => {
		saved(service.writeNote(note()));
		const replaced = saved(service.writeNote(note({ text: "Holds items.", expectedRevision: 1, author: AGENT })));
		expect(replaced).toMatchObject({
			revision: 2,
			text: "Holds items.",
			author: PERSON,
			editedBy: AGENT,
		});

		const agents = note({ symbolId: CART, text: "A cart.", author: AGENT });
		saved(service.writeNote(agents));
		expect(saved(service.writeNote({ ...agents, text: "A trolley.", expectedRevision: 1 }))).toMatchObject({
			revision: 2,
			author: AGENT,
		});

		expect(service.writeNote(note({ text: "Stale text.", expectedRevision: 1 }))).toMatchObject({
			outcome: "refused",
			current: { revision: 2 },
		});
	});
});

describe("searching for a ref", () => {
	it("lists own code before dependencies, top-level before members, source before tests, and files after declarations", () => {
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
			{
				symbolId: "lexicon reference src/shop.ref ShopCart#cart.",
				name: "cart",
				digest: "p3",
				kind: "property",
				containerId: "lexicon reference src/shop.ref ShopCart#",
			},
		]);
		plant("node_modules/zod/cart.ref", [
			{ symbolId: "lexicon reference node_modules/zod/cart.ref Carton#", name: "Carton", digest: "v1" },
			{ symbolId: "lexicon reference node_modules/zod/cart.ref Cart#", name: "Cart", digest: "v2" },
		]);

		expect(service.searchRefs("Cart").results.map((entry) => [entry.kind, entry.ref])).toEqual([
			["class", ref("a.ref", "Cart")],
			["class", ref("src/cart.ref", "Cart")],
			["class", ref("src/__tests__/cart.test.ref", "Cart")],
			["function", ref("src/shop.ref", "cartTotal")],
			["class", ref("src/shop.ref", "ShopCart")],
			["property", ref("src/shop.ref", "ShopCart", "cart")],
			["class", ref("node_modules/zod/cart.ref", "Cart")],
			["class", ref("node_modules/zod/cart.ref", "Carton")],
			["file", ref("src/cart.ref")],
			["file", ref("src/__tests__/cart.test.ref")],
			["file", ref("node_modules/zod/cart.ref")],
		]);

		const refs = (kinds: SymbolKind[]) =>
			service.searchRefs("Cart", undefined, kinds).results.map((entry) => entry.ref);
		expect({ functions: refs(["function"]), files: refs(["file"]), none: refs([]) }).toEqual({
			functions: [ref("src/shop.ref", "cartTotal")],
			files: [ref("src/cart.ref"), ref("src/__tests__/cart.test.ref"), ref("node_modules/zod/cart.ref")],
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

	// Legacy note fixtures.
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
		db.exec("DROP TABLE symbol_notes; DROP TABLE symbol_note_links;");
		db.exec(OLD_TABLES);
		const row = db.prepare(
			`INSERT INTO symbol_notes (subjectId, recordedAs, revision, summary, description, why, gotchas, author,
			 authoredAt, editedBy, editedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		row.run(cart, CART, 1, "Seeded from a sweep.", null, null, null, null, 5, null, 5);
		row.run(null, TROLLEY, 1, "Seeded from a sweep.", null, null, null, null, 5, null, 5);
		const person = JSON.stringify(PERSON);
		db.prepare("UPDATE symbol_notes SET confirmedBy = ?, confirmedAt = 25 WHERE subjectId = ?").run(person, cart);
		row.run(
			basket,
			BASKET,
			1,
			"Holds a [Cart](ref://a.ref:Cart) per shopper.",
			null,
			"One per shopper.",
			null,
			person,
			20,
			person,
			20,
		);
		db.prepare(
			"UPDATE symbol_notes SET confirmedBy = ?, confirmedAt = 25, doubtBy = ?, doubtReason = 'old', doubtAt = 26 WHERE subjectId = ?",
		).run(person, person, basket);
		db.prepare(
			`INSERT INTO symbol_note_proposals (subjectId, baseRevision, summary, description, proposedBy, proposedAt)
			 VALUES (?, 1, ?, ?, ?, 30)`,
		).run(basket, "Holds items.", `Pairs with [Cart](${ref("a.ref", "Cart")}).`, JSON.stringify(AGENT));
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

		expect(service.readNote(CART)).toMatchObject({ text: "Seeded from a sweep." });
		expect(service.readNote(TROLLEY)).toBeNull();
		expect(service.readNote(BASKET)).toMatchObject({
			text: `${HOLDS()}\n\nOne per shopper.`,
			links: [{ symbolId: CART, state: "ok" }],
		});
		expect(service.readNote(BASKET)).not.toHaveProperty("proposal");
		expect(service.readNote(BASKET)).not.toHaveProperty("doubt");
		expect(service.readNote(BASKET)).not.toHaveProperty("confirmedBy");
		expect(service.noteBacklinks(CART).notes).toEqual([{ symbolId: BASKET, summary: HOLDS() }]);
		const migrated = new DatabaseSync(file);
		const noteColumns = (migrated.prepare("PRAGMA table_info(symbol_notes)").all() as Array<{ name: string }>).map(
			(column) => column.name,
		);
		const linkColumns = (
			migrated.prepare("PRAGMA table_info(symbol_note_links)").all() as Array<{ name: string }>
		).map((column) => column.name);
		expect(noteColumns).not.toContain("confirmedBy");
		expect(noteColumns).not.toContain("doubtReason");
		expect(linkColumns).not.toContain("proposed");
		expect(
			migrated
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'symbol_note_proposals'")
				.get(),
		).toBe(undefined);
		migrated.close();
	});

	it("opens a store missing a four-field table, reading it as empty", () => {
		writeFourFields();
		const db = new DatabaseSync(file);
		db.exec("DROP TABLE symbol_note_links;");
		db.close();
		reopen();

		expect(service.readNote(BASKET)).toMatchObject({ text: `${HOLDS()}\n\nOne per shopper.` });
		expect(service.readNote(BASKET)).not.toHaveProperty("proposal");
	});
});

describe("a store rebuild", () => {
	it("carries notes and their standing links", () => {
		saved(service.writeNote(note({ text: `${HOLDS()}\n\nPairs with [Cart](${ref("a.ref", "Cart")}).` })));
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
