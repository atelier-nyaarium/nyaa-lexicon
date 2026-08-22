import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { composeSymbolId, type Declaration, doubtFactId, type Reference } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachedComment } from "../commentAttach";
import { IndexStore, SCHEMA_VERSION } from "../store";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;

function idOf(name: string, module = "src/a.ts"): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

const POINT = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };

function declaration(name: string, module = "src/a.ts", extra: Partial<Declaration> = {}): Declaration {
	return {
		symbolId: idOf(name, module),
		kind: "function",
		name,
		range: POINT,
		selectionRange: POINT,
		visibility: "public",
		exported: true,
		...extra,
	};
}

function reference(name: string, targetId: string | null): Reference {
	return {
		name,
		range: POINT,
		role: "call",
		binding: targetId
			? { status: "bound", symbolId: targetId, provenance: "bound" }
			: { status: "unbound", reason: "NotImplemented" },
	};
}

function comment(anchorId: string): AttachedComment {
	return {
		range: POINT,
		raw: "// why this exists",
		normalized: "why this exists",
		form: "leading",
		placement: "above",
		anchorId,
	};
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-store-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("keeping what a provider said below error", () => {
	const warning = { severity: "warning" as const, message: "duplicate key", range: POINT };
	const info = { severity: "info" as const, message: "comment in strict JSON" };

	it("keeps a file's notes with its facts, replaces them with the file, and forgets them with it", () => {
		store.replaceFile(
			"src/a.json",
			"h1",
			[declaration("a", "src/a.json")],
			[],
			[],
			[],
			"full",
			[],
			[],
			[warning, info],
		);
		expect(store.fileNotes("src/a.json")).toEqual({ module: "src/a.json", known: true, notes: [warning, info] });
		expect(store.noteTotals()).toEqual({ noted: 1, unknown: 0 });

		store.replaceFile("src/a.json", "h2", [declaration("a", "src/a.json")], []);
		expect(store.fileNotes("src/a.json")).toEqual({ module: "src/a.json", known: true, notes: [] });

		store.replaceFile("src/a.json", "h3", [], [], [], [], "full", [], [], [info]);
		store.forgetFile("src/a.json");
		expect(store.fileNotes("src/a.json")).toEqual({ module: "src/a.json", known: false, reason: "notIndexed" });
		expect(store.noteTotals()).toEqual({ noted: 0, unknown: 0 });
	});

	// Added in place; silence would read as clean.
	it("calls notes unknown for a file read before the table existed, until its next read", () => {
		const file = path.join(dir, "index.sqlite");
		store.replaceFile("src/old.ts", "h1", [declaration("old", "src/old.ts")], []);
		store.close();
		const raw = new DatabaseSync(file);
		raw.exec("DROP TABLE notes; DELETE FROM meta WHERE key = 'notesSince'");
		raw.close();

		const now = Date.now();
		vi.useFakeTimers({ now: now + 1000 });
		try {
			store = IndexStore.open(file).store;
			expect(store.fileNotes("src/old.ts")).toEqual({
				module: "src/old.ts",
				known: false,
				reason: "indexedBeforeNotes",
			});
			expect(store.noteTotals()).toEqual({ noted: 0, unknown: 1 });

			vi.setSystemTime(now + 2000);
			store.replaceFile("src/old.ts", "h2", [declaration("old", "src/old.ts")], []);
			expect(store.fileNotes("src/old.ts")).toEqual({ module: "src/old.ts", known: true, notes: [] });
			expect(store.noteTotals()).toEqual({ noted: 0, unknown: 0 });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("writing a file's facts", () => {
	it("reads back what it stored", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);

		expect(store.contentHashOf("src/a.ts")).toBe("h1");
		expect(store.declarationsIn("src/a.ts").map((d) => d.name)).toEqual(["add"]);
		expect(store.declaration(idOf("add"))?.name).toBe("add");
	});

	it("returns the newest file index time", () => {
		vi.useFakeTimers();
		try {
			const first = new Date("2026-01-01T00:00:00Z").getTime();
			const second = new Date("2026-01-02T00:00:00Z").getTime();
			vi.setSystemTime(first);
			store.replaceFile("src/a.ts", "h1", [declaration("a")], []);
			vi.setSystemTime(second);
			store.replaceFile("src/b.ts", "h1", [declaration("b", "src/b.ts")], []);

			expect(store.newestIndexedAt()).toBe(second);
		} finally {
			vi.useRealTimers();
		}
	});

	it("filters declarations by a regular expression", () => {
		store.replaceFile(
			"src/a.ts",
			"h1",
			[declaration("FooBar"), declaration("fooBaz", "src/a.ts"), declaration("other", "src/a.ts")],
			[],
		);

		const found = store.searchSymbols(undefined, { regex: "/foo\\w*bar/i", limit: 50 });

		expect(found.map((entry) => entry.name)).toEqual(["FooBar"]);
	});

	it("preserves optional fields, and omits them rather than storing null", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add", "src/a.ts", { signature: "add(): void" })], []);

		const stored = store.declaration(idOf("add"));
		expect(stored?.signature).toBe("add(): void");
		expect(stored).not.toHaveProperty("docComment");
	});

	it("keeps a declaration's whole span and its name span apart, which is what a rewrite needs", () => {
		const whole = { start: { line: 3, character: 0 }, end: { line: 9, character: 1 } };
		const justTheName = { start: { line: 3, character: 15 }, end: { line: 3, character: 19 } };
		store.replaceFile(
			"src/a.ts",
			"h1",
			[declaration("Cart", "src/a.ts", { range: whole, selectionRange: justTheName })],
			[],
		);

		const stored = store.declaration(idOf("Cart"));
		expect(stored?.range).toEqual(whole);
		expect(stored?.selectionRange).toEqual(justTheName);
	});

	it("keeps a reference's end, so a caller knows what text the reference occupies", () => {
		const span = { start: { line: 2, character: 8 }, end: { line: 2, character: 12 } };
		store.replaceFile(
			"src/a.ts",
			"h1",
			[declaration("Cart")],
			[{ ...reference("Cart", idOf("Cart")), range: span }],
		);

		const [stored] = store.referencesTo(idOf("Cart"));
		expect(stored).toMatchObject({ startLine: 2, startCharacter: 8, endLine: 2, endCharacter: 12 });
	});

	it("keeps 'cannot say' about exported distinct from 'no' across the round trip", () => {
		const cannotSay = declaration("mystery");
		delete (cannotSay as { exported?: boolean }).exported;
		store.replaceFile("src/a.ts", "h1", [cannotSay, declaration("known", "src/a.ts", { exported: false })], []);

		// A NOT NULL column storing 0 would make these two identical, which is the interface
		// compelling a claim the provider could not support.
		expect(store.declaration(idOf("mystery"))).not.toHaveProperty("exported");
		expect(store.declaration(idOf("known"))?.exported).toBe(false);
	});

	it("drops what a file no longer contains, which an upsert alone would leave behind forever", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add"), declaration("remove")], []);
		store.replaceFile("src/a.ts", "h2", [declaration("add")], []);

		expect(store.declarationsIn("src/a.ts").map((d) => d.name)).toEqual(["add"]);
		expect(store.declaration(idOf("remove"))).toBeNull();
	});

	it("touches only the file being replaced", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("a", "src/a.ts")], []);
		store.replaceFile("src/b.ts", "h1", [declaration("b", "src/b.ts")], []);
		store.replaceFile("src/a.ts", "h2", [], []);

		expect(store.declarationsIn("src/a.ts")).toEqual([]);
		expect(store.declarationsIn("src/b.ts").map((d) => d.name)).toEqual(["b"]);
	});

	it("forgets a deleted file entirely", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("a")], [reference("a", idOf("a"))]);
		store.forgetFile("src/a.ts");

		expect(store.contentHashOf("src/a.ts")).toBeNull();
		expect(store.declarationsIn("src/a.ts")).toEqual([]);
		expect(store.referencesIn("src/a.ts")).toEqual([]);
	});
});

describe("reverse lookup", () => {
	it("finds every use of a symbol across files", () => {
		const target = idOf("add");
		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		store.replaceFile("src/b.ts", "h1", [], [reference("add", target)]);
		store.replaceFile("src/c.ts", "h1", [], [reference("add", target)]);

		expect(store.referencesTo(target).map((r) => r.module)).toEqual(["src/b.ts", "src/c.ts"]);
	});

	it("excludes an unbound reference, since a name match is not a use of this symbol", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		store.replaceFile("src/b.ts", "h1", [], [reference("add", null)]);

		expect(store.referencesTo(idOf("add"))).toEqual([]);
		// Kept in the file's own rows though: that it did not bind is itself a fact.
		expect(store.referencesIn("src/b.ts")).toHaveLength(1);
	});

	it("keeps an unbound reference's reason rather than discarding why it failed", () => {
		store.replaceFile("src/b.ts", "h1", [], [reference("add", null)]);
		expect(store.referencesIn("src/b.ts")[0]?.provenance).toBe("NotImplemented");
	});

	it("stops finding a use once the using file is re-indexed without it", () => {
		const target = idOf("add");
		store.replaceFile("src/b.ts", "h1", [], [reference("add", target)]);
		store.replaceFile("src/b.ts", "h2", [], []);

		expect(store.referencesTo(target)).toEqual([]);
	});

	it("reports a symbol nothing references", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("used"), declaration("unused")], []);
		store.replaceFile("src/b.ts", "h1", [], [reference("used", idOf("used"))]);

		expect(store.unreferencedSymbols().map((d) => d.name)).toEqual(["unused"]);
	});
});

describe("opening the index", () => {
	it("reports a fresh index as not rebuilt", () => {
		const file = path.join(dir, "fresh.sqlite");
		const opened = IndexStore.open(file);
		expect(opened.rebuilt).toBe(false);
		opened.store.close();
	});

	it("reopens an existing index without losing what it holds", () => {
		const file = path.join(dir, "reopen.sqlite");
		const first = IndexStore.open(file);
		first.store.replaceFile("src/a.ts", "h1", [declaration("a")], []);
		first.store.close();

		const second = IndexStore.open(file);
		expect(second.rebuilt).toBe(false);
		expect(second.store.declarationsIn("src/a.ts").map((d) => d.name)).toEqual(["a"]);
		second.store.close();
	});

	it("rebuilds rather than failing when the schema version does not match", async () => {
		const file = path.join(dir, "stale.sqlite");
		const first = IndexStore.open(file);
		first.store.replaceFile("src/a.ts", "h1", [declaration("a")], []);
		first.store.close();

		// Simulate an index written by a build with a different schema.
		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(file);
		raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		raw.close();

		const second = IndexStore.open(file);
		expect(second.rebuilt).toBe(true);
		// Rebuilt from empty, not migrated: the index is always derivable from source.
		expect(second.store.declarationsIn("src/a.ts")).toEqual([]);
		second.store.close();
	});

	// Facts are derivable from source and a blob is not. A rebuild that dropped the journal would
	// strand a half-applied refactor with nothing left that knows how to undo it.
	it("carries an unfinished refactor across a rebuild", async () => {
		const file = path.join(dir, "journal.sqlite");
		const before = new TextEncoder().encode("export function add() {}\n");

		const first = IndexStore.open(file);
		first.store.journal((db) => {
			db.prepare("INSERT INTO refactor_transactions (id, state, startedAt) VALUES (?, ?, ?)").run(
				"t1",
				"open",
				1,
			);
			db.prepare(
				"INSERT INTO refactor_steps (transactionId, stepNo, kind, phase, createdAt) VALUES (?, ?, ?, ?, ?)",
			).run("t1", 1, "replace", "written", 1);
			db.prepare(
				`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("t1", "step", 1, "src/a.ts", 1, "blob-a");
		});
		first.store.putBlob("blob-a", before);
		first.store.close();

		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(file);
		raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		raw.close();

		const second = IndexStore.open(file);
		expect(second.rebuilt).toBe(true);

		const open = second.store.journal((db) => db.prepare("SELECT * FROM refactor_transactions").all());
		expect(open).toEqual([{ id: "t1", state: "open", startedAt: 1 }]);
		expect(second.store.blob("blob-a")).toEqual(before);
		second.store.close();
	});

	it("drops a blob once no image still points at it", () => {
		const file = path.join(dir, "prune.sqlite");
		const opened = IndexStore.open(file);

		opened.store.putBlob("orphan", new TextEncoder().encode("gone"));
		opened.store.putBlob("kept", new TextEncoder().encode("held"));
		opened.store.journal((db) => {
			db.prepare(
				`INSERT INTO refactor_images (transactionId, scope, stepNo, module, existedBefore, beforeHash)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("t1", "baseline", 0, "src/a.ts", 1, "kept");
		});

		expect(opened.store.pruneBlobs()).toBe(1);
		expect(opened.store.blob("orphan")).toBeNull();
		expect(opened.store.blob("kept")).not.toBeNull();
		opened.store.close();
	});
});

/**
 * The knowledge layer's prerequisite: a fact an answer can name and later resolve.
 *
 * The declaration already had a symbolId, which is a different thing. That id names the SYMBOL and
 * survives edits by design, so a citation built on it could never notice the signature changing
 * underneath it.
 */
describe("citable facts", () => {
	const literal = { kind: "string" as const, value: "hello", range: POINT };

	it("gives every kind of fact an id, not just the declaration", () => {
		store.replaceFile(
			"src/a.ts",
			"h1",
			[declaration("add")],
			[reference("add", idOf("add"))],
			[{ specifier: "./b.js", imported: [], reExport: false }],
			[literal],
		);

		expect(store.declarationsIn("src/a.ts")[0]?.factId).toMatch(/^lexfact declaration /);
		expect(store.referencesIn("src/a.ts")[0]?.factId).toMatch(/^lexfact reference /);
		expect(store.importsIn("src/a.ts")[0]?.factId).toMatch(/^lexfact import /);
		expect(store.literalsWithValue("hello", 10)[0]?.factId).toMatch(/^lexfact literal /);
	});

	it("resolves an id back to the fact it names, whichever kind that is", () => {
		store.replaceFile(
			"src/a.ts",
			"h1",
			[declaration("add")],
			[reference("add", idOf("add"))],
			[],
			[literal],
			"full",
			[comment(idOf("add"))],
		);

		const declarationId = store.declarationsIn("src/a.ts")[0]?.factId as string;
		const literalId = store.literalsWithValue("hello", 10)[0]?.factId as string;
		const commentId = store.commentsAnchoredTo(idOf("add"))[0]?.factId as string;

		expect(store.factById(declarationId)).toMatchObject({ fact: "declaration", name: "add" });
		expect(store.factById(literalId)).toMatchObject({ fact: "literal", value: "hello" });
		expect(store.factById(commentId)).toMatchObject({ fact: "comment", normalized: "why this exists" });
	});

	it("does not resolve a doubt id", () => {
		const doubt = doubtFactId(idOf("add"), "describe", "needs review", 1);

		expect(store.factById(doubt)).toBeNull();
	});

	// Null IS the staleness signal, which is why the id is a digest of the fact rather than a rowid.
	it("stops resolving a citation once the fact it named has changed", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		const cited = store.declarationsIn("src/a.ts")[0]?.factId as string;

		store.replaceFile("src/a.ts", "h2", [declaration("add", "src/a.ts", { signature: "(a: number) => void" })], []);

		expect(store.factById(cited)).toBeNull();
		expect(store.declarationsIn("src/a.ts")[0]?.factId).not.toBe(cited);
	});

	it("keeps resolving a citation when the file was re-indexed without changing", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		const cited = store.declarationsIn("src/a.ts")[0]?.factId as string;

		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);

		expect(store.factById(cited)).not.toBeNull();
	});

	it("refuses a symbol id where a fact id belongs, rather than searching for it", () => {
		expect(store.factById(idOf("add"))).toBeNull();
	});
});

/**
 * The half of invalidation a per-file hash cannot cover.
 *
 * Extraction is a function of the file AND the code that reads it. A provider that changes how it
 * classifies leaves every stored fact stale while no file has moved, so a rescan correctly skips
 * all of them and the index keeps serving answers from a provider version that no longer exists.
 */
describe("noticing that the indexer itself changed", () => {
	it("keeps an index written under the same major", () => {
		const file = path.join(dir, "same.sqlite");
		const first = IndexStore.open(file, "1");
		first.store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		first.store.close();

		const second = IndexStore.open(file, "1");

		expect(second.rebuilt).toBe(false);
		expect(second.store.declarationsIn("src/a.ts").map((d) => d.name)).toEqual(["add"]);
		second.store.close();
	});

	it("rebuilds when a major has shipped, and says that is why", () => {
		const file = path.join(dir, "moved.sqlite");
		const first = IndexStore.open(file, "1");
		first.store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		first.store.close();

		const second = IndexStore.open(file, "2");

		expect(second.rebuilt).toBe(true);
		expect(second.reason).toMatch(/major version has shipped/);
		expect(second.store.declarationsIn("src/a.ts")).toEqual([]);
		second.store.close();
	});

	// Null means no comparison.
	it("skips the check when the caller offers no compatibility key", () => {
		const file = path.join(dir, "none.sqlite");
		const first = IndexStore.open(file, "1");
		first.store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		first.store.close();

		const second = IndexStore.open(file);

		expect(second.rebuilt).toBe(false);
		expect(second.store.declarationsIn("src/a.ts")).toHaveLength(1);
		second.store.close();
	});

	// Missing keys adopt the current major.
	it("adopts a key rather than rebuilding when none was stored", () => {
		const file = path.join(dir, "adopt.sqlite");
		const first = IndexStore.open(file);
		first.store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		first.store.close();

		const second = IndexStore.open(file, "1");
		expect(second.rebuilt).toBe(false);
		second.store.close();

		const third = IndexStore.open(file, "1");
		expect(third.rebuilt).toBe(false);
		third.store.close();
	});
});

describe("admitting a provider's ids before writing", () => {
	it("refuses a dangling container before the transaction, so the file's previous facts stand", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);

		expect(() =>
			store.replaceFile("src/a.ts", "h2", [declaration("next", "src/a.ts", { containerId: idOf("Ghost") })], []),
		).toThrow(/container .* is not declared in this file/);

		expect(store.declarationsNamed("add")).toHaveLength(1);
		expect(store.declarationsNamed("next")).toEqual([]);
		expect(store.contentHashOf("src/a.ts")).toBe("h1");
	});
});

describe("recording what a file is", () => {
	it("keeps the owning provider's content class per file and counts by it", () => {
		store.replaceFile("src/a.ts", "h1", [declaration("add")], []);
		store.replaceFile(
			"fixtures/a.json",
			"h2",
			[declaration("one", "fixtures/a.json"), declaration("two", "fixtures/a.json")],
			[],
			[],
			[],
			"full",
			[],
			[],
			[],
			"data",
		);
		store.replaceFile("README.md", "h3", [], [], [], [], "full", [], [], [], "document");

		expect(store.moduleSummary()).toEqual([
			{ module: "fixtures/a.json", symbols: 2, content: "data" },
			{ module: "src/a.ts", symbols: 1, content: "code" },
		]);
		expect(store.contentTotals(() => true)).toEqual({
			files: { code: 1, data: 1, document: 1, unknown: 0 },
			symbols: { code: 1, data: 2, document: 0, unknown: 0 },
		});
		expect(store.contentTotals((module) => module !== "fixtures/a.json").files.data).toBe(0);
	});

	// Added in place; a row from before reads as unrecorded, never as code.
	it("adds the column to a store from before it existed, and fills a row only while it is unrecorded", () => {
		const file = path.join(dir, "index.sqlite");
		store.replaceFile("src/old.json", "h1", [declaration("old", "src/old.json")], []);
		store.close();
		const raw = new DatabaseSync(file);
		raw.exec("ALTER TABLE files DROP COLUMN content");
		raw.close();

		store = IndexStore.open(file).store;
		expect(store.moduleSummary()).toEqual([{ module: "src/old.json", symbols: 1, content: null }]);
		expect(store.contentTotals(() => true).files).toEqual({ code: 0, data: 0, document: 0, unknown: 1 });

		store.recordContent("src/old.json", "data");
		store.recordContent("src/old.json", "code");
		expect(store.moduleSummary()[0]?.content).toBe("data");
	});
});

describe("forgetting a file", () => {
	it("removes every kind of fact the file contributed", () => {
		store.replaceFile(
			"src/a.ts",
			"h1",
			[declaration("add")],
			[reference("add", idOf("add"))],
			[{ specifier: "./b.js", imported: [], reExport: false }],
			[{ kind: "string", value: "gone", range: POINT }],
		);

		store.forgetFile("src/a.ts");

		expect(store.totals()).toMatchObject({ files: 0, symbols: 0, references: 0, imports: 0, literals: 0 });
		expect(store.literalsWithValue("gone", 10)).toEqual([]);
	});
});
