import type { DescribeResult, SymbolSummary } from "@nyaa-lexicon/core";
import { describe, expect, it } from "vitest";
import {
	describeSymbol,
	findReferences,
	refactorRename,
	resolveImport,
	type ToolBackend,
	typeOfSymbol,
} from "../tools";

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
		indexStatus: async () => ({
			state: "ready",
			done: 1,
			total: 1,
			failures: 0,
			stored: 1,
			fullFiles: 1,
			outlineFiles: 0,
		}),
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
			index: { state: "ready", done: 0, total: 0, failures: 0, stored: 0, fullFiles: 0, outlineFiles: 0 },
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
		symbolSource: async () => ({ found: false, reason: "not stubbed" }),
		refactorStart: async () => ({ started: true, id: "rt-test" }),
		refactorStatus: async () => ({ open: false, steps: [], tracked: [], issues: [] }),
		refactorTrack: async () => ({ tracked: true }),
		refactorUndo: async () => ({ undone: false, reason: "nothing to undo" }),
		refactorRevert: async () => ({ reverted: true, modules: [] }),
		refactorCommit: async () => ({ committed: true, issues: [] }),
		refactorReplace: async () => ({ replaced: true, module: "src/a.ts", issues: [] }),
		refactorInsert: async () => ({ inserted: true, module: "src/a.ts", symbolIds: [], issues: [] }),
		refactorRename: async () => ({ renamed: true, modules: ["src/a.ts"], issues: [] }),
		refactorMove: async () => ({ moved: true, modules: ["src/a.ts", "src/b.ts"], issues: [] }),
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

describe("renaming as a transaction step", () => {
	const found = { findByName: async () => [summary("Cart")] };

	// A warning is somewhere the index cannot promise completeness. Refusing on one would refuse
	// most real renames, so it is reported and the caller decides.
	it("applies despite a warning, and shows it", async () => {
		const warned = {
			renamed: true,
			modules: ["src/cart.ts"],
			issues: [{ kind: "SameSpellingUnbound", detail: "2 occurrences did not bind" }],
		};
		const result = await refactorRename(backend({ ...found, refactorRename: async () => warned }), {
			name: "Cart",
			newName: "Basket",
		});

		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("SameSpellingUnbound");
	});

	it("refuses on a blocker, which is a different answer from a warning", async () => {
		const blocked = {
			renamed: false,
			issues: [{ kind: "SameName", detail: "already named Cart" }],
			reason: "already named Cart",
		};
		const result = await refactorRename(backend({ ...found, refactorRename: async () => blocked }), {
			name: "Cart",
			newName: "Cart",
		});

		expect(result.isError).toBe(true);
	});

	// The prose written about a symbol is the one thing a re-index cannot rebuild, so a rename that
	// carried some says so rather than leaving the caller to wonder.
	it("says what knowledge it carried across", async () => {
		const migrated = {
			renamed: true,
			modules: ["src/cart.ts"],
			migrated: { answers: 3, gaps: 1 },
			issues: [],
		};
		const result = await refactorRename(backend({ ...found, refactorRename: async () => migrated }), {
			name: "Cart",
			newName: "Basket",
		});

		expect(result.content[0]?.text).toContain("3 answer(s)");
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

describe("index-state honesty notes", () => {
	it("marks counts as lower bounds while outline files remain", async () => {
		const result = await findReferences(
			backend({
				indexStatus: async () => ({
					state: "upgrading",
					done: 3,
					total: 10,
					failures: 0,
					stored: 10,
					fullFiles: 3,
					outlineFiles: 7,
				}),
			}),
			{ symbolId: "x" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("lower bounds");
		expect(text).toContain("7 of 10");
	});

	it("says nothing extra once every file is full and ready", async () => {
		const result = await findReferences(backend(), { symbolId: "x" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).not.toContain("lower bounds");
		expect(text).not.toContain("Still indexing");
	});

	it("counts persisted failures even when the state is ready", async () => {
		const result = await findReferences(
			backend({
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 2,
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
			}),
			{ symbolId: "x" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("2 files failed to parse");
	});
});
