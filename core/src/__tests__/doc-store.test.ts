import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration, type DocRegion } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexReadModel, REGEX_SCAN_LIMIT } from "../indexReads.js";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let reads: IndexReadModel;

const MODULE = "docs/guide.md";

function headingId(...names: string[]): string {
	return composeSymbolId({
		language: "markdown",
		module: MODULE,
		descriptors: names.map((name) => ({ kind: "namespace" as const, name })),
	});
}

function at(line: number): DocRegion["range"] {
	return { start: { line, character: 0 }, end: { line, character: 4 } };
}

function heading(name: string): Declaration {
	return {
		symbolId: headingId(name),
		kind: "heading",
		name,
		range: at(0),
		selectionRange: at(0),
		visibility: "public",
	};
}

function region(text: string, line: number, anchorId?: string, fenced = false): DocRegion {
	return { range: at(line), text, fenced, ...(anchorId === undefined ? {} : { anchorId }) };
}

function write(declarations: Declaration[], docs: DocRegion[], module = MODULE): void {
	store.replaceFile(module, "h1", declarations, [], [], [], "full", [], docs);
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-doc-store-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	reads = new IndexReadModel(store);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("storing document prose", () => {
	it("reads back what it stored, raw and normalized apart", () => {
		write([heading("Principles")], [region("No\nband-aids here", 3, headingId("Principles"))]);

		const [found] = store.docsAnchoredTo(headingId("Principles"));
		expect(found?.raw).toBe("No\nband-aids here");
		expect(found?.normalized).toBe("No band-aids here");
		expect(found?.fenced).toBe(false);
	});

	it("finds a phrase the source wrapped across lines", () => {
		write(
			[heading("Principles")],
			[region("weigh the long-run\ncost of a workaround", 3, headingId("Principles"))],
		);

		expect(reads.findDocs({ text: "long-run cost" }).total).toBe(1);
		expect(reads.findDocs({ text: "long-run\ncost" }).total).toBe(0);
	});

	it("keeps a fenced region apart from prose, both ways", () => {
		write(
			[heading("Development")],
			[
				region("Run the build.", 3, headingId("Development")),
				region("bun run build", 5, headingId("Development"), true),
			],
		);

		expect(reads.findDocs({ fenced: true }).docs.map((d) => d.raw)).toEqual(["bun run build"]);
		expect(reads.findDocs({ fenced: false }).docs.map((d) => d.raw)).toEqual(["Run the build."]);
		expect(reads.findDocs({ module: MODULE }).total).toBe(2);
	});

	// Refused rather than nulled: null already means the region sits under no heading, so reusing it
	// would hide a provider's contract violation behind a legitimate answer.
	it("refuses an anchor that is not a heading declared in this file, and keeps what was there", () => {
		write([heading("Principles")], [region("survivor", 3, headingId("Principles"))]);
		const foreign = composeSymbolId({
			language: "markdown",
			module: "docs/other.md",
			descriptors: [{ kind: "namespace", name: "Foreign" }],
		});

		expect(() => write([heading("Principles")], [region("bad anchor", 3, foreign)])).toThrow();
		expect(() =>
			write(
				[{ ...heading("helper"), kind: "function", symbolId: headingId("helper") }],
				[region("bad kind", 3, headingId("helper"))],
			),
		).toThrow();
		// A declaration carrying a FOREIGN id would otherwise vouch for an anchor in another module.
		expect(() =>
			write([{ ...heading("Foreign"), symbolId: foreign }], [region("foreign vouch", 3, foreign)]),
		).toThrow();
		// The store keeps the LAST declaration for an id, so a duplicate must not smuggle a kind past.
		expect(() =>
			write(
				[heading("Principles"), { ...heading("Principles"), kind: "property" }],
				[region("smuggled", 3, headingId("Principles"))],
			),
		).toThrow();
		expect(reads.findDocs({ module: MODULE }).docs.map((d) => d.raw)).toEqual(["survivor"]);
	});

	it("forgets a file's regions along with its other facts", () => {
		write([heading("Principles")], [region("gone soon", 3, headingId("Principles"))]);
		store.forgetFile(MODULE);

		expect(reads.findDocs({ module: MODULE }).total).toBe(0);
	});

	it("replaces rather than accumulates, so a re-index cannot double a region", () => {
		write([heading("Principles")], [region("first pass", 3, headingId("Principles"))]);
		write([heading("Principles")], [region("second pass", 3, headingId("Principles"))]);

		expect(reads.findDocs({ module: MODULE }).docs.map((d) => d.raw)).toEqual(["second pass"]);
	});

	it("resolves a region by its fact id, so a citation can quote one", () => {
		write([heading("Principles")], [region("citable prose", 3, headingId("Principles"))]);
		const [found] = reads.findDocs({ module: MODULE }).docs;

		const fact = store.factById(found?.factId ?? "");
		expect(fact?.fact).toBe("doc");
		expect(fact !== null && "raw" in fact && fact.raw).toBe("citable prose");
	});
});

describe("the heading path", () => {
	it("walks containers outermost first, which is the answer shape a docs hit needs", () => {
		const top = headingId("CLAUDE");
		const middle = headingId("CLAUDE", "Principles");
		write(
			[
				{ ...heading("CLAUDE"), symbolId: top },
				{ ...heading("Principles"), symbolId: middle, containerId: top },
			],
			[region("No band-aids", 3, middle)],
		);

		expect(reads.findDocs({ text: "band-aid" }).docs[0]?.headingPath).toEqual(["CLAUDE", "Principles"]);
	});

	it("is empty for prose that sits under no heading", () => {
		write([], [region("preamble prose", 0)]);

		expect(reads.findDocs({ text: "preamble" }).docs[0]?.headingPath).toEqual([]);
	});

	// A containerId is not validated on write, so the chain can still leave the headings.
	it("stops at the first non-heading in the chain, keeping the headings above it", () => {
		const outer = headingId("Outer");
		const middle = headingId("Outer", "helper");
		const inner = headingId("Outer", "helper", "Inner");
		write(
			[
				{ ...heading("Outer"), symbolId: outer },
				{ ...heading("helper"), kind: "function", symbolId: middle, containerId: outer },
				{ ...heading("Inner"), symbolId: inner, containerId: middle },
			],
			[region("under a nested heading", 3, inner)],
		);

		expect(reads.headingPath(inner)).toEqual(["Inner"]);
		expect(reads.findDocs({ text: "under a nested" }).docs[0]?.headingPath).toEqual(["Inner"]);
	});

	it("stays inside one module, so a path never mixes two files", () => {
		const local = headingId("Local");
		const foreign = composeSymbolId({
			language: "markdown",
			module: "docs/other.md",
			descriptors: [{ kind: "namespace", name: "Foreign" }],
		});
		write([{ ...heading("Foreign"), symbolId: foreign }], [], "docs/other.md");
		write([{ ...heading("Local"), symbolId: local, containerId: foreign }], []);

		expect(reads.headingPath(local)).toEqual(["Local"]);
	});

	it("terminates on a container cycle rather than hanging", () => {
		const first = headingId("A");
		const second = headingId("B");
		write(
			[
				{ ...heading("A"), symbolId: first, containerId: second },
				{ ...heading("B"), symbolId: second, containerId: first },
			],
			[],
		);

		expect(reads.headingPath(first)).toEqual(["B", "A"]);
	});
});

describe("searching document prose", () => {
	it("refuses a text and a regex together rather than picking one", () => {
		expect(() => reads.findDocs({ text: "a", regex: "/b/" })).toThrow();
		expect(() => reads.findDocs({})).toThrow();
	});

	it("matches by regex over the normalized text", () => {
		write([heading("Notes")], [region("TODO: revisit this", 3, headingId("Notes"))]);

		expect(reads.findDocs({ regex: "/TODO|FIXME/" }).total).toBe(1);
		expect(reads.findDocs({ regex: "/nothing/" }).total).toBe(0);
	});

	it("reports the true total rather than its own page cap", () => {
		const regions = Array.from({ length: 5 }, (_, index) => region(`shared phrase ${index}`, index));
		write([], regions);

		const result = reads.findDocs({ text: "shared phrase" }, 2);
		expect(result.docs).toHaveLength(2);
		expect(result.total).toBe(5);
		expect(result.truncated).toBe(true);
	});

	// A search term is text, not a pattern. Unescaped, `%` would match everything and report it.
	it("treats a LIKE metacharacter in the search text as itself", () => {
		write([], [region("100% covered", 0), region("snake_case name", 1), region("nothing alike", 2)]);

		expect(reads.findDocs({ text: "100%" }).docs.map((d) => d.raw)).toEqual(["100% covered"]);
		expect(reads.findDocs({ text: "%" }).total).toBe(1);
		expect(reads.findDocs({ text: "snake_case" }).total).toBe(1);
		expect(reads.findDocs({ text: "snakeXcase" }).total).toBe(0);
	});

	it("filters to one module rather than searching the workspace", () => {
		write([], [region("shared word here", 0)], "docs/one.md");
		write([], [region("shared word there", 0)], "docs/two.md");

		expect(reads.findDocs({ text: "shared word" }).total).toBe(2);
		expect(reads.findDocs({ text: "shared word", module: "docs/one.md" }).docs.map((d) => d.raw)).toEqual([
			"shared word here",
		]);
	});

	it("carries every stored field back, not only the text", () => {
		const anchor = headingId("Principles");
		write([heading("Principles")], [region("fenced sample", 7, anchor, true)]);

		expect(reads.docsFor(anchor)).toEqual([
			{
				factId: expect.any(String),
				module: MODULE,
				raw: "fenced sample",
				normalized: "fenced sample",
				fenced: true,
				anchorId: anchor,
				range: at(7),
			},
		]);
	});

	// A truncated scan and a truncated page are different truncations, and a caller that cannot
	// tell them apart reads a page as the whole answer.
	it("says when a regex scan stopped before the end of the table", () => {
		const many = Array.from({ length: REGEX_SCAN_LIMIT + 1 }, (_, index) => region(`region ${index}`, index));
		write([], many);

		expect(reads.findDocs({ regex: "/region/" }).scanIncomplete).toBe(true);
		expect(reads.findDocs({ text: "region" }).scanIncomplete).toBeUndefined();
	});
});

describe("the symbol count", () => {
	it("splits headings out, so one total cannot stand for callable code and sections at once", () => {
		write([heading("Principles"), { ...heading("helper"), kind: "function", symbolId: headingId("helper") }], []);

		expect(store.symbolsByKind()).toEqual({ heading: 1, function: 1 });
	});
});
