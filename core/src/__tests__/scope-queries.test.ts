import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeSymbolId, type Declaration, type Reference } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttachedComment } from "../commentAttach.js";
import { IndexReadModel } from "../indexReads.js";
import { IndexStore } from "../store.js";

const POINT = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

let store: IndexStore;
let reads: IndexReadModel;
let directory: string;

function id(name: string, module: string, container?: string): string {
	return composeSymbolId({
		language: "ts",
		module,
		descriptors: [
			...(container === undefined ? [] : [{ kind: "namespace" as const, name: container }]),
			{ kind: "term", name },
		],
	});
}

function declaration(symbolId: string, name: string, kind: Declaration["kind"] = "function"): Declaration {
	return { symbolId, kind, name, range: POINT, selectionRange: POINT, visibility: "public", exported: true };
}

function reference(target: string | null, fromId?: string): Reference {
	return {
		name: "target",
		range: POINT,
		...(fromId === undefined ? {} : { fromId }),
		role: "call",
		binding:
			target === null
				? { status: "unbound", reason: "NotImplemented" }
				: { status: "bound", symbolId: target, provenance: "bound" },
	};
}

function comment(anchorId: string | null): AttachedComment {
	return { range: POINT, raw: "// warning", normalized: "warning", form: "leading", placement: "above", anchorId };
}

beforeEach(() => {
	directory = mkdtempSync(path.join(tmpdir(), "lexicon-scope-queries-"));
	store = IndexStore.open(path.join(directory, "index.sqlite")).store;
	reads = new IndexReadModel(store);
});

afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("scoped search reads", () => {
	it("scopes symbols, references, literals and comments, including null owners", () => {
		const child = id("inside", "a.ts", "routes");
		const outside = id("outside", "a.ts");
		const target = id("target", "a.ts");
		store.replaceFile(
			"a.ts",
			"a",
			[
				{
					...declaration(
						composeSymbolId({
							language: "ts",
							module: "a.ts",
							descriptors: [{ kind: "namespace", name: "routes" }],
						}),
						"routes",
						"namespace",
					),
					range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
				},
				declaration(child, "inside"),
				declaration(outside, "outside"),
				declaration(target, "target"),
			],
			[reference(target, child), reference(null)],
			[],
			[
				{ kind: "string", value: "warning", range: POINT, containerId: child },
				{ kind: "string", value: "warning", range: POINT },
			],
			"full",
			[comment(child), comment(null)],
		);

		const scopedSearch = reads.searchSymbols("in", { within: "routes" });
		expect(scopedSearch.symbols.map((symbol) => symbol.name)).toEqual(["inside"]);
		// A declaration is not inside itself.
		expect(reads.searchSymbols("routes", { within: "routes" }).symbols).toEqual([]);
		expect(scopedSearch.count).toEqual({ kind: "exact", count: 1 });
		expect(reads.searchSymbols("in", { within: "routes", module: "a.ts", kind: "function" }).symbols).toHaveLength(
			1,
		);
		expect(reads.searchSymbols(undefined, { within: "routes", regex: "/^in/" }).symbols).toHaveLength(1);
		expect(reads.findReferences(target, 10, child).total).toBe(1);
		expect(reads.findReferences(target, 10, "routes")).toMatchObject({ total: 1, truncated: false });
		expect(reads.findLiterals({ value: "warning", within: "routes" })).toMatchObject({
			count: { kind: "exact", count: 1 },
		});
		expect(reads.findLiterals({ value: "warning", key: "inside" }).literals[0]).toMatchObject({
			containerName: "inside",
			containerKind: "function",
		});
		expect(reads.findLiterals({ value: "warning", key: "inside" }).count.count).toBe(1);
		expect(reads.findLiterals({ value: "warning", key: "inside" }).literals).toHaveLength(1);
		expect(reads.findComments({ text: "warning", within: "routes" })).toMatchObject({
			count: { kind: "exact", count: 1 },
		});
		// Scoped or not, text matches the same way: case-insensitively.
		expect(reads.findComments({ text: "WARNING", within: "routes" }).count.count).toBe(1);
	});

	it("uses the immediate container for regex keys and excludes top-level literals", () => {
		const container = id("field", "a.ts");
		store.replaceFile(
			"a.ts",
			"a",
			[declaration(container, "field")],
			[],
			[],
			[
				{ kind: "string", value: "warning", range: POINT, containerId: container },
				{ kind: "string", value: "warning", range: POINT },
			],
		);

		expect(reads.findLiterals({ regex: "/warning/", key: "field" })).toMatchObject({ count: { count: 1 } });
		expect(reads.findLiterals({ regex: "/warning/", key: "field" }).literals).toHaveLength(1);
	});
});
