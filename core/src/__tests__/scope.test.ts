import { describe, expect, it } from "bun:test";
import { ANONYMOUS_NAMESPACE, composeSymbolId } from "@nyaa-lexicon/protocol";
import { resolveScope, successor } from "../scope.js";
import type { IndexStore, StoredDeclaration } from "../store.js";

function declaration(module: string, name: string, kind = "function", visibility = "public"): StoredDeclaration {
	return {
		symbolId: composeSymbolId({
			language: "cpp",
			module,
			descriptors: [{ kind: kind === "namespace" ? "namespace" : "method", name }],
		}),
		module,
		name,
		kind,
		visibility,
	} as StoredDeclaration;
}

function store(rows: StoredDeclaration[]): IndexStore {
	return {
		declaration: (id: string) => rows.find((row) => row.symbolId === id) ?? null,
		declarationsNamed: (name: string) => rows.filter((row) => row.name === name),
	} as unknown as IndexStore;
}

describe("scope resolution", () => {
	it("resolves ids and names", () => {
		const row = declaration("a.cpp", "run");
		expect(resolveScope(store([row]), row.symbolId).id).toBe(row.symbolId);
		expect(resolveScope(store([row]), "run").id).toBe(row.symbolId);
	});

	it("refuses unknown ids and locals", () => {
		const local = { ...declaration("a.cpp", "run"), symbolId: "lexicon cpp a.cpp local1" } as StoredDeclaration;
		expect(() => resolveScope(store([]), local.symbolId)).toThrow("no declaration has this id");
		expect(() => resolveScope(store([local]), local.symbolId)).toThrow("a local names no scope");
	});

	it("refuses ambiguous names with candidates", () => {
		const rows = [declaration("a.cpp", "run"), declaration("b.cpp", "run")];
		expect(() => resolveScope(store(rows), "run")).toThrow(/ambiguous.*lexicon cpp a\.cpp/);
	});

	it("merges public named namespaces across modules", () => {
		const rows = [declaration("a.cpp", "api", "namespace"), declaration("b.cpp", "api", "namespace")];
		const first = rows[0];
		if (first === undefined) throw new Error("namespace declaration missing");
		expect(resolveScope(store(rows), "api").id).toBe(first.symbolId);
	});

	it("merges a namespace-qualified type reopened across modules", () => {
		const part = (module: string): StoredDeclaration =>
			({
				symbolId: composeSymbolId({
					language: "csharp",
					module,
					descriptors: [
						{ kind: "namespace", name: "Api" },
						{ kind: "type", name: "Writer" },
					],
				}),
				module,
				name: "Writer",
				kind: "class",
				visibility: "public",
			}) as StoredDeclaration;
		const rows = [part("Writer.cs"), part("Writer.Async.cs")];
		const first = rows[0];
		if (first === undefined) throw new Error("type declaration missing");
		expect(resolveScope(store(rows), "Writer").id).toBe(first.symbolId);
	});

	it("does not merge a bare type name across modules", () => {
		const rows = [declaration("a.cpp", "Writer", "type"), declaration("b.cpp", "Writer", "type")];
		expect(() => resolveScope(store(rows), "Writer")).toThrow("ambiguous");
	});

	it("collapses a constructor onto the class it sits in", () => {
		const type = declaration("a.cpp", "Writer", "namespace");
		const ctor = {
			...declaration("a.cpp", "Writer"),
			symbolId: composeSymbolId({
				language: "cpp",
				module: "a.cpp",
				descriptors: [
					{ kind: "namespace", name: "Writer" },
					{ kind: "method", name: "Writer" },
				],
			}),
		} as StoredDeclaration;
		expect(resolveScope(store([ctor, type]), "Writer").id).toBe(type.symbolId);
	});

	it("does not merge anonymous namespaces", () => {
		const rows = [
			declaration("a.cpp", ANONYMOUS_NAMESPACE, "namespace"),
			declaration("b.cpp", ANONYMOUS_NAMESPACE, "namespace"),
		];
		expect(() => resolveScope(store(rows), ANONYMOUS_NAMESPACE)).toThrow("ambiguous");
	});
});

describe("scope prefix successors", () => {
	it("increments the terminal descriptor suffix", () => {
		expect(successor("lexicon cpp a.cpp api/")).toBe("lexicon cpp a.cpp api0");
	});

	it("refuses a non-descriptor prefix", () => {
		expect(() => successor("lexicon cpp a.cpp")).toThrow("no safe successor");
	});
});
