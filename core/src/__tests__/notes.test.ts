import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NoteAuthor } from "@nyaa-lexicon/protocol";
import type { NoteWrite } from "../notes";
import * as refusal from "../refusals";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore, SCHEMA_VERSION } from "../store";
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

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 8 } });

/** One module's classes, each with the digest a full parse would mint. */
function plant(
	module: string,
	classes: Array<{ symbolId: string; name: string; digest: string; containerId?: string }>,
): void {
	store.replaceFile({
		module,
		contentHash: classes.map((entry) => entry.digest).join(""),
		declarations: classes.map((entry, line) => ({
			symbolId: entry.symbolId,
			kind: "class" as const,
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
		digests: classes.map((entry) => ({
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
	return {
		symbolId: BASKET,
		summary: "Holds a [Cart](ref://a.ref:Cart) per shopper.",
		description: "n/a",
		why: "n/a",
		gotchas: "n/a",
		expectedRevision: 0,
		author: PERSON,
		...fields,
	};
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
	it("requires every field, reads n/a as nothing said, and removes a note left with nothing", () => {
		expect(service.writeNote(note({ gotchas: "  " }))).toMatchObject({
			outcome: "refused",
			reason: refusal.noteFieldsEmpty(["gotchas"]),
		});
		expect(service.writeNote(note({ summary: "One.\nTwo." }))).toMatchObject({
			reason: refusal.noteSummaryOneLine(),
		});

		expect(saved(service.writeNote(note({ why: " N/A " })))).toMatchObject({ revision: 1, why: null });
		const cleared = { summary: "n/a", expectedRevision: 1 };
		expect(saved(service.writeNote(note(cleared)))).toBeNull();
		expect(service.readNote(BASKET)).toBeNull();
	});

	it("refuses a revision that moved, handing back the note as it stands", () => {
		saved(service.writeNote(note()));
		const stale = service.writeNote(note({ summary: "Holds items." }));
		expect(stale).toMatchObject({
			outcome: "refused",
			reason: refusal.noteRevisionMoved(0, 1),
			current: { revision: 1 },
		});
	});

	it("refuses a ref that names nothing, with candidates under where it stopped, and saves nothing", () => {
		plant("a.ref", [
			{ symbolId: CART, name: "Cart", digest: "c1" },
			{ symbolId: `${CART}Item#`, name: "Item", digest: "i1", containerId: CART },
		]);
		const outcome = service.writeNote(
			note({ summary: "Holds a [cart](ref://a.ref:Ghost).", description: "[i](ref://a.ref:Cart:Ghost)" }),
		);
		expect(outcome).toMatchObject({
			outcome: "refused",
			refs: [
				{
					field: "summary",
					ref: "ref://a.ref:Ghost",
					candidates: ["ref://a.ref:Cart", "ref://a.ref:Cart:Item"],
				},
				{ field: "description", ref: "ref://a.ref:Cart:Ghost", candidates: ["ref://a.ref:Cart:Item"] },
			],
		});
		expect(service.readNote(BASKET)).toBeNull();
	});
});

describe("a note's refs over time", () => {
	it("follow their target through a rename, reading at its new address in either link form", () => {
		saved(service.writeNote(note({ description: "Also [the cart](<ref://a.ref:Cart>)." })));
		plant("a.ref", [{ symbolId: TROLLEY, name: "Trolley", digest: "c1" }]);
		store.subjects.rebind([{ from: CART, to: TROLLEY }], "journalMove", 9);

		expect(service.readNote(BASKET)).toMatchObject({
			summary: "Holds a [Cart](ref://a.ref:Trolley) per shopper.",
			description: "Also [the cart](<ref://a.ref:Trolley>).",
			links: [
				{ written: "ref://a.ref:Cart", current: "ref://a.ref:Trolley", symbolId: TROLLEY, state: "ok" },
				{ field: "description", current: "ref://a.ref:Trolley" },
			],
		});
		expect(service.noteBacklinks(TROLLEY).notes.map((entry) => entry.symbolId)).toEqual([BASKET]);
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
			summary: "Holds a [Cart](ref://a.ref:Cart) per shopper.",
			links: [{ current: "ref://a.ref:Cart", state: "broken" }],
		});
	});

	it("name a whole file, found by its path", () => {
		saved(service.writeNote(note({ description: "See [the cart file](ref://a.ref)." })));
		expect(service.readNote(BASKET)?.links).toContainEqual(
			expect.objectContaining({ field: "description", written: "ref://a.ref", state: "ok" }),
		);
		expect(service.noteBacklinks("a.ref").notes.map((entry) => entry.symbolId)).toEqual([BASKET]);
	});
});

describe("whose words an agent may replace", () => {
	it("turns an agent's write over a person's note into a proposal, which the person's next save drops", () => {
		saved(service.writeNote(note()));
		const proposed = service.writeNote(note({ summary: "Holds items.", expectedRevision: 1, author: AGENT }));

		expect(proposed).toMatchObject({
			outcome: "proposed",
			note: { revision: 1, summary: "Holds a [Cart](ref://a.ref:Cart) per shopper.", proposal: { by: AGENT } },
		});
		expect(saved(service.writeNote(note({ summary: "Holds carts.", expectedRevision: 1 })))).toMatchObject({
			revision: 2,
			proposal: null,
		});
	});

	it("keeps a proposal's refs on their targets, so accepting after a rename links the same symbol", () => {
		saved(service.writeNote(note({ summary: "Holds items." })));
		service.writeNote(note({ summary: "Wraps a [Cart](ref://a.ref:Cart).", expectedRevision: 1, author: AGENT }));
		plant("a.ref", [
			{ symbolId: TROLLEY, name: "Trolley", digest: "c1" },
			{ symbolId: CART, name: "Cart", digest: "other" },
		]);
		store.subjects.rebind([{ from: CART, to: TROLLEY }], "journalMove", 9);

		expect(service.readNote(BASKET)?.proposal?.summary).toBe("Wraps a [Cart](ref://a.ref:Trolley).");
		expect(saved(service.resolveNoteProposal(BASKET, true, 1, PERSON))).toMatchObject({
			revision: 2,
			links: [{ symbolId: TROLLEY }],
		});
	});

	it("rejects a proposal without a new revision, and replaces an agent's note in place", () => {
		saved(service.writeNote(note()));
		service.writeNote(note({ summary: "Holds items.", expectedRevision: 1, author: AGENT }));
		expect(saved(service.resolveNoteProposal(BASKET, false, 1, PERSON))).toMatchObject({
			revision: 1,
			proposal: null,
		});

		const agents = note({ symbolId: CART, summary: "A cart.", author: AGENT });
		saved(service.writeNote(agents));
		expect(saved(service.writeNote({ ...agents, summary: "A trolley.", expectedRevision: 1 }))).toMatchObject({
			revision: 2,
			author: AGENT,
		});
	});
});

describe("seeding from describe answers", () => {
	it("seeds a note from each describe answer that says something, once, and clears answer authors", async () => {
		const cited = (symbolId: string) => [store.declaration(symbolId)?.factId as string];
		await service.recordAnswer(CART, "describe", "Holds the items of one checkout.", cited(CART), {
			model: "gpt-5",
		});
		await service.recordAnswer(BASKET, "describe", "A class Basket declared in b.ref.", cited(BASKET));
		store.close();
		const db = new DatabaseSync(file);
		db.exec("DELETE FROM meta WHERE key = 'notesSeeded'");
		db.close();

		reopen();
		expect(service.readNote(CART)).toMatchObject({
			summary: "Holds the items of one checkout.",
			description: null,
			author: null,
			sourceChanged: false,
		});
		expect(service.readNote(BASKET)).toBeNull();
		expect(store.answer(CART, "describe")?.model).toBeUndefined();

		const cleared = { summary: "n/a", description: "n/a", why: "n/a", gotchas: "n/a" };
		saved(service.writeNote({ symbolId: CART, ...cleared, expectedRevision: 1 }));
		store.close();
		reopen();
		expect(service.readNote(CART)).toBeNull();
	});
});

describe("a store rebuild", () => {
	it("carries notes, their links and proposals", () => {
		saved(service.writeNote(note({ description: "Pairs with [Cart](ref://a.ref:Cart)." })));
		service.writeNote(note({ summary: "Holds items.", expectedRevision: 1, author: AGENT }));
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
