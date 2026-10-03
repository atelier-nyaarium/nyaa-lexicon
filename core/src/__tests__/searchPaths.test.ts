import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration, type Range } from "@nyaa-lexicon/protocol";
import { IndexReadModel } from "../indexReads";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

let dir: string;
let store: IndexStore;
let reads: IndexReadModel;

function at(line: number): Range {
	return { start: { line, character: 0 }, end: { line, character: 5 } };
}

function idOf(module: string, name: string): string {
	return composeSymbolId({ language: "ts", module, descriptors: [{ kind: "term", name }] });
}

function declared(module: string, name: string): Declaration {
	return {
		symbolId: idOf(module, name),
		kind: "function",
		name,
		range: at(0),
		selectionRange: at(0),
		visibility: "public",
		exported: true,
	};
}

const SHARED = idOf("lib/shared.ts", "shared");

/**
 * A folder, a module nested below it, a sibling whose name it prefixes, a deeper path holding it and
 * one differing in case: each declares `ready`, says "ready" and uses `shared`.
 */
const MODULES = ["src/web/a.ts", "src/web/deep/e.ts", "src/webview/b.ts", "lib/src/web/c.ts", "Src/web/d.ts"];

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-search-paths-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	reads = new IndexReadModel(store);
	store.replaceFile({
		module: "lib/shared.ts",
		contentHash: "s",
		declarations: [declared("lib/shared.ts", "shared")],
		references: [],
	});
	for (const module of MODULES) {
		store.replaceFile({
			module,
			contentHash: module,
			declarations: [declared(module, "ready")],
			references: [
				{
					name: "shared",
					range: at(2),
					role: "call",
					binding: { status: "bound", symbolId: SHARED, provenance: "bound" },
				},
			],
			imports: [],
			literals: [{ kind: "string", value: "ready", range: at(1), containerId: idOf(module, "ready") }],
			comments: [
				{
					range: at(3),
					raw: "// ready",
					normalized: "ready",
					form: "leading",
					placement: "above",
					anchorId: idOf(module, "ready"),
				},
			],
			docs: [{ range: at(4), text: "ready", fenced: false }],
		});
	}
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a module path in a search", () => {
	it("names that file or every module in that folder, never a name that only contains it or differs in case", () => {
		const modules = (rows: ReadonlyArray<{ module: string }>) => rows.map((row) => row.module);

		expect({
			symbols: modules(reads.searchSymbols(undefined, { module: "src/web" }).symbols),
			file: modules(reads.searchSymbols(undefined, { module: "src/webview/b.ts" }).symbols),
			literals: modules(reads.findLiterals({ value: "ready", module: "src/web" }).literals),
			references: modules(reads.findReferences(SHARED, 50, undefined, "src/web").references),
			comments: modules(reads.findComments({ text: "ready", module: "src/web" }).comments),
			docs: modules(reads.findDocs({ text: "ready", module: "src/web" }).docs),
		}).toEqual({
			symbols: ["src/web/a.ts", "src/web/deep/e.ts"],
			file: ["src/webview/b.ts"],
			literals: ["src/web/a.ts", "src/web/deep/e.ts"],
			references: ["src/web/a.ts", "src/web/deep/e.ts"],
			comments: ["src/web/a.ts", "src/web/deep/e.ts"],
			docs: ["src/web/a.ts", "src/web/deep/e.ts"],
		});
	});

	it("lists by kind or module with no pattern, and refuses a search that names nothing or two patterns", () => {
		expect(reads.searchSymbols(undefined, { kind: "function" }).symbols).toHaveLength(6);
		expect(() => reads.searchSymbols(undefined, {})).toThrow();
		expect(() => reads.findLiterals({ value: "ready", regex: "/rea/" })).toThrow();
	});
});
