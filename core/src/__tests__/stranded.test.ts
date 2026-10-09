import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let dir: string;
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

function plant(module = "a.ref", symbolId = CART, name = "Cart"): void {
	store.replaceFile({
		module: module,
		contentHash: "h1",
		declarations: [declaration(symbolId, name)],
		references: [],
	});
}

function record(symbolId: string, text = "A shopping cart."): void {
	const outcome = service.writeNote({ symbolId, text, expectedRevision: 0 });
	if (outcome.outcome === "refused") throw new Error(outcome.reason);
}

/** A write at the address, which must be refused; its reason. */
function refusedAt(symbolId: string): string {
	const outcome = service.writeNote({ symbolId, text: "Again.", expectedRevision: 0 });
	if (outcome.outcome !== "refused") throw new Error("expected a refusal");
	return outcome.reason;
}

/** The declaration leaves the index; the subject and its rows stay. */
function strand(module = "a.ref"): void {
	store.replaceFile({
		module: module,
		contentHash: "h2",
		declarations: [],
		references: [],
	});
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-stranded-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(),
		fromText(() => null),
		dir,
	);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a subject whose address stopped resolving", () => {
	it("refuses a write naming the candidates elsewhere, and keeps its note readable where it was", () => {
		plant();
		record(CART);
		plant("b.ref", "lexicon reference b.ref Cart#");
		plant("c.ref", "lexicon reference c.ref Cart#");
		// Neither the same name as a term nor the same name in another language is a candidate.
		plant("d.ref", "lexicon reference d.ref Cart.");
		plant("e.ref", "lexicon other e.ref Cart#");
		strand();

		const reason = refusedAt(CART);
		expect(reason).toContain("no longer resolves");
		expect(reason).toContain("`lexicon reference b.ref Cart#`");
		expect(reason).toContain("`lexicon reference c.ref Cart#`");
		expect(reason).not.toContain("not in the index");
		// Candidates are for a reader: the note is still read where it was written, and nowhere else.
		expect(service.readNote(CART)?.text).toBe("A shopping cart.");
		expect(service.readNote("lexicon reference b.ref Cart#")).toBeNull();
	});

	it("waits on a parse failure instead of stranding, naming the failure's reason", () => {
		plant();
		record(CART);
		strand();
		store.recordFailure("a.ref", "unterminated string at line 3");

		expect(refusedAt(CART)).toContain("present and not parsing (unterminated string at line 3)");
		expect(service.readNote(CART)?.text).toBe("A shopping cart.");

		// An orphan under a failing module was judged before the module failed: it reads as stranded.
		const subject = store.subjects.forAddress(CART);
		store.noteWrite(() => store.subjects.orphan(subject?.subjectId as string, 20, "none"));
		expect(refusedAt(CART)).toContain("no longer resolves");
	});

	it("lists no candidates for a local and says why", () => {
		const local = "lexicon reference a.ref local0";
		plant("a.ref", local, "x");
		// A local takes no note, so its subject is claimed directly.
		store.noteWrite(() => store.subjects.claim(local, Date.now()));
		plant("b.ref", "lexicon reference b.ref local0", "x");
		strand();

		expect(refusedAt(local)).toContain("a local has no candidates");
	});
});

describe("an address a subject vacated", () => {
	it("says moved, with the new address and the evidence, once its declaration is gone", () => {
		plant();
		record(CART);
		const moved = "lexicon reference b.ref Cart#";
		plant("b.ref", moved);
		store.journalWrite(() => store.subjects.rebind([{ from: CART, to: moved }], "journalMove", 9));
		strand();

		const reason = refusedAt(CART);
		expect(reason).toContain(`was rebound to ${moved} (journalMove)`);
		expect(service.readNote(moved)?.text).toBe("A shopping cart.");

		const diagnosis = service.diagnoseSubject(CART);
		expect(diagnosis.kind === "moved" && diagnosis.forwardedTo).toBe(moved);
		expect<string>(diagnosis.reason).toBe(reason);
	});

	it("forwards only the last vacated address; two rebinds back reads as unminted", () => {
		plant();
		record(CART);
		const b = "lexicon reference b.ref Cart#";
		const c = "lexicon reference c.ref Cart#";
		plant("b.ref", b);
		store.journalWrite(() => store.subjects.rebind([{ from: CART, to: b }], "journalMove", 9));
		plant("c.ref", c);
		store.journalWrite(() => store.subjects.rebind([{ from: b, to: c }], "journalMove", 10));
		// The first module keeps another declaration, so its shortlist is what an unminted id shows.
		store.replaceFile({
			module: "a.ref",
			contentHash: "h2",
			declarations: [declaration("lexicon reference a.ref Other#", "Other")],
			references: [],
		});
		strand("b.ref");

		expect(refusedAt(b)).toContain(`was rebound to ${c}`);
		const first = refusedAt(CART);
		expect(first).toContain("a.ref holds");
		expect(first).toContain("lexicon reference a.ref Other#");
		expect(first).not.toContain("was rebound");
	});
});
