import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration } from "@nyaa-lexicon/protocol";
import type { AttachedComment } from "../commentAttach.js";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;

const POINT = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };

function idOf(name: string, module = "src/a.ts"): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

function declaration(name: string, module = "src/a.ts"): Declaration {
	return {
		symbolId: idOf(name, module),
		kind: "function",
		name,
		range: POINT,
		selectionRange: POINT,
		visibility: "public",
		exported: true,
	};
}

function comment(raw: string, anchorId: string | null, extra: Partial<AttachedComment> = {}): AttachedComment {
	return {
		range: POINT,
		raw,
		normalized: raw.replace(/^\/\/\s*/, ""),
		form: "leading",
		placement: "above",
		anchorId,
		...extra,
	};
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-comment-store-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("storing comments", () => {
	it("reads back what it stored, raw and normalized apart", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [declaration("add")],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [comment("// refuses rather than clamping", idOf("add"))],
		});

		const [found] = store.commentsAnchoredTo(idOf("add"));
		expect(found?.raw).toBe("// refuses rather than clamping");
		expect(found?.normalized).toBe("refuses rather than clamping");
		expect(found?.form).toBe("leading");
	});

	// This pins the COLUMN search reads. That the normalized value is right is the normalizer's
	// test, and that the whole path joins up is comment-indexing's.
	it("searches the normalized column rather than the raw one", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [declaration("add")],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [
				{
					...comment("// refuses rather than\n// clamping", idOf("add")),
					normalized: "refuses rather than clamping",
				},
			],
		});

		expect(store.commentsContaining("than clamping", 10)).toHaveLength(1);
		expect(store.commentsContaining("nothing here", 10)).toEqual([]);
	});

	it("treats a LIKE wildcard in the query as a literal character", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [
				{ ...comment("// one hundred percent", null), normalized: "one hundred percent" },
				{ ...comment("// 100% sure", null), normalized: "100% sure" },
			],
		});

		expect(store.commentsContaining("100%", 10).map((item) => item.normalized)).toEqual(["100% sure"]);
	});

	it("keeps a module-level comment anchored to nothing", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [{ ...comment("// Copyright someone", null), form: "standalone", placement: "inside" }],
		});

		const [found] = store.commentsToScan(10);
		expect(found?.anchorId).toBeNull();
		expect(found?.form).toBe("standalone");
	});

	it("filters a scan by form", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [declaration("add")],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [
				comment("// leads", idOf("add")),
				{ ...comment("// trails", idOf("add")), form: "trailing", placement: "after" },
			],
		});

		expect(store.commentsToScan(10, { form: "trailing" }).map((item) => item.raw)).toEqual(["// trails"]);
	});

	// The invariant: an anchor is rewritten by the next pass, never carried forward. A symbol that
	// moved cannot leave a comment pointing at where it used to be.
	it("rewrites anchors on reindex rather than migrating them", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [declaration("add")],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [comment("// docs", idOf("add"))],
		});
		expect(store.commentsAnchoredTo(idOf("add"))).toHaveLength(1);

		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h2",
			declarations: [declaration("renamed")],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [comment("// docs", idOf("renamed"))],
		});

		expect(store.commentsAnchoredTo(idOf("add"))).toEqual([]);
		expect(store.commentsAnchoredTo(idOf("renamed"))).toHaveLength(1);
	});

	it("drops a file's comments when the file is forgotten", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [declaration("add")],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [comment("// docs", idOf("add"))],
		});

		store.forgetFile("src/a.ts");

		expect(store.commentsToScan(10)).toEqual([]);
	});

	// Two identical comments in one file are two facts, exactly as two identical literals are.
	it("stores two identical comments as two rows", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [
				{
					...comment("// same", null),
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 7 } },
				},
				{
					...comment("// same", null),
					range: { start: { line: 5, character: 0 }, end: { line: 5, character: 7 } },
				},
			],
		});

		expect(store.commentsToScan(10)).toHaveLength(2);
	});

	it("gives every comment a parseable fact id", () => {
		store.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: [comment("// docs", null)],
		});

		const [found] = store.commentsToScan(10);
		expect(found?.factId).toMatch(/^lexfact comment /);
	});
});
