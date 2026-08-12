import type { DescribeResult, SymbolSummary } from "@nyaa-lexicon/core";
import { describe, expect, it } from "vitest";
import { describeSymbol, findReferences, prepareRename, resolveImport, type ToolBackend, typeOfSymbol } from "../tools";

////////////////////////////////
//  Helpers

function summary(name: string, extra: Partial<SymbolSummary> = {}): SymbolSummary {
	return {
		symbolId: `lexicon ts src/a.ts ${name}.`,
		name,
		kind: "function",
		module: "src/a.ts",
		exported: true,
		visibility: "public",
		...extra,
	};
}

function backend(overrides: Partial<ToolBackend> = {}): ToolBackend {
	return {
		findByName: async () => [],
		describe: async () => null,
		findReferences: async (symbolId) => ({ symbolId, references: [], total: 0, truncated: false, tier: "bound" }),
		resolveImport: async () => ({ status: "unresolved", reason: "NotImplemented" }),
		typeOf: async () => ({ status: "unknown", reason: "NotImplemented" }),
		prepareRename: async (symbolId, newName) => ({
			symbolId,
			oldName: "Cart",
			newName,
			files: [],
			occurrences: 0,
			blockers: [],
			warnings: [],
		}),
		indexStatus: async () => ({ state: "ready", done: 1, total: 1, failures: 0, stored: 1 }),
		findLiterals: async (query) => ({ query, literals: [], total: 0, truncated: false }),
		searchSymbols: async (text) => ({ text, symbols: [], total: 0, truncated: false }),
		outlineModule: async () => [],
		findImports: async (query) => ({ query, imports: [], total: 0, truncated: false }),
		hubs: async () => [],
		fileHistory: async (module) => ({
			module,
			commits: 0,
			linesAdded: 0,
			linesDeleted: 0,
			recent: [],
			firstSeen: null,
			lastTouched: null,
			truncated: false,
		}),
		factsFor: async (symbolId) => ({ symbolId, facts: [], truncated: [] }),
		commitsMentioning: async (name) => ({ name, mentions: [], commits: 0 }),
		recordAnswer: async () => ({ recorded: false, reason: "not under test" }),
		recallAnswer: async () => null,
		recallAnswers: async () => [],
		invalidateAnswer: async (symbolId) => ({ symbolId, doubted: [], noAnswer: [], refused: "not under test" }),
		reaffirmAnswer: async () => ({ recorded: false, reason: "not under test" }),
		knowledgeGaps: async (root, question) => ({
			question: question ?? "describe",
			rows: [],
			total: 0,
			external: 0,
			truncated: false,
		}),
		overview: async () => ({
			files: 0,
			symbols: 0,
			references: 0,
			imports: 0,
			literals: 0,
			modules: 0,
			scope: "test",
			index: { state: "ready", done: 0, total: 0, failures: 0, stored: 0 },
			largest: [],
		}),
		coChangedWith: async (module) => ({
			module,
			partners: [],
			total: 0,
			commits: 0,
			skippedWideCommits: 0,
			widthLimit: 40,
		}),
		renameSymbol: async (symbolId, newName) => ({
			renamed: true,
			modules: ["src/a.ts"],
			plan: { symbolId, oldName: "Cart", newName, files: [], occurrences: 0, blockers: [], warnings: [] },
		}),
		...overrides,
	};
}

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

const described: DescribeResult = {
	symbol: summary("Cart", { kind: "class", signature: "class Cart" }),
	members: [summary("add", { kind: "method" }), summary("total", { kind: "method" })],
	referenceCount: 3,
	graph: { symbolId: "lexicon ts src/a.ts Cart#", fanIn: 3, fanOut: 2 },
	hierarchy: {
		symbolId: "lexicon ts src/a.ts Cart#",
		supertypes: [],
		subtypes: [],
		ancestors: [],
		unboundSupertypes: [],
	},
	tier: "bound",
};

////////////////////////////////
//  Tests

describe("resolving what the caller gave", () => {
	it("uses a symbolId directly", async () => {
		let seen: string | undefined;
		const result = await describeSymbol(
			backend({
				describe: async (symbolId) => {
					seen = symbolId;
					return described;
				},
			}),
			{ symbolId: "x" },
		);
		expect(seen).toBe("x");
		expect(result.isError).toBeUndefined();
	});

	it("resolves a unique name", async () => {
		const result = await describeSymbol(
			backend({ findByName: async () => [summary("Cart")], describe: async () => described }),
			{ name: "Cart" },
		);
		expect(result.isError).toBeUndefined();
	});

	it("lists the candidates rather than describing whichever came first", async () => {
		const two = [summary("Cart"), summary("Cart", { module: "src/b.ts" })];
		const result = await describeSymbol(backend({ findByName: async () => two }), { name: "Cart" });

		expect(result.isError).toBe(true);
	});

	it("says so when nothing matches, rather than answering emptily", async () => {
		const result = await describeSymbol(backend(), { name: "Ghost" });
		expect(result.isError).toBe(true);
	});

	it("refuses a call giving neither name nor id", async () => {
		const result = await describeSymbol(backend(), {});
		expect(result.isError).toBe(true);
	});
});

describe("resolving an import", () => {
	it("names the module a specifier landed on", async () => {
		const result = await resolveImport(
			backend({ resolveImport: async () => ({ status: "resolved", module: "src/item.ts" }) }),
			{ fromModule: "src/cart.ts", specifier: "./item" },
		);
		expect(result.isError).toBeUndefined();
	});

	it("separates external from unresolved, which are different answers", async () => {
		const external = await resolveImport(
			backend({ resolveImport: async () => ({ status: "external", packageName: "zod", version: "4.4.3" }) }),
			{ fromModule: "src/a.ts", specifier: "zod" },
		);
		expect(external.isError).toBeUndefined();

		const missing = await resolveImport(backend(), { fromModule: "src/a.ts", specifier: "./gone" });
		expect(missing.isError).toBeUndefined();
	});

	it("does not call an unresolved import an error, since it is a finding", async () => {
		const result = await resolveImport(backend(), { fromModule: "src/a.ts", specifier: "./gone" });
		expect(result.isError).toBeUndefined();
	});
});

describe("planning a rename", () => {
	const found = { findByName: async () => [summary("Cart")] };
	const plan = {
		symbolId: "x",
		oldName: "Cart",
		newName: "Basket",
		files: [
			{ module: "src/cart.ts", sites: [{ range: RANGE }] },
			{ module: "src/uses.ts", sites: [{ range: RANGE }, { range: RANGE }] },
		],
		occurrences: 3,
		blockers: [],
		warnings: [],
	};

	it("reports a warning without refusing, since uncertainty is the caller's call", async () => {
		const warned = {
			...plan,
			warnings: [
				{ kind: "SameSpellingUnbound", detail: "2 did not bind", sites: [{ module: "src/x.ts", line: 7 }] },
			],
		};
		const result = await prepareRename(backend({ ...found, prepareRename: async () => warned }), {
			name: "Cart",
			newName: "Basket",
		});

		expect(result.isError).toBeUndefined();
	});

	it("refuses on a blocker, which is a different answer from a warning", async () => {
		const blocked = { ...plan, blockers: [{ kind: "SameName", detail: "already named Cart" }] };
		const result = await prepareRename(backend({ ...found, prepareRename: async () => blocked }), {
			name: "Cart",
			newName: "Cart",
		});

		expect(result.isError).toBe(true);
	});
});

describe("asking for a type", () => {
	it("rejects an ambiguous symbol name", async () => {
		const result = await typeOfSymbol(
			backend({ findByName: async () => [summary("Cart"), summary("Cart", { module: "src/b.ts" })] }),
			{ name: "Cart" },
		);
		expect(result.isError).toBe(true);
	});
});

describe("find_references passes its limit through", () => {
	it("forwards the caller's limit", async () => {
		let seen: number | undefined;
		await findReferences(
			backend({
				findReferences: async (symbolId, limit) => {
					seen = limit;
					return { symbolId, references: [], total: 0, truncated: false, tier: "bound" };
				},
			}),
			{ symbolId: "x", limit: 5 },
		);
		expect(seen).toBe(5);
	});
});
