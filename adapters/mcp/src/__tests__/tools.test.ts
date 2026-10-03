import { describe, expect, it } from "bun:test";
import type { DescribeResult, SymbolSummary } from "@nyaa-lexicon/core";
import type { StoredDeclaration } from "@nyaa-lexicon/protocol";
import {
	describeSymbol,
	doubtNote,
	findReferences,
	noteBacklinks,
	outlineModule,
	readNote,
	refactorMove,
	refactorPreview,
	refactorRename,
	refactorReplace,
	refactorRevert,
	refactorStatus,
	refactorUndo,
	resolveImport,
	searchDocs,
	searchSymbols,
	symbolSource,
	type ToolBackend,
	typeOfSymbol,
	writeNote,
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
		// Resolves by default, so a test that hands an id reaches its handler; a test about a bad id overrides it.
		declarationOf: async (symbolId) => ({ symbolId }) as unknown as StoredDeclaration,
		diagnoseSubject: async (symbolId) => ({ kind: "unknown", reason: `${symbolId} diagnosed`, candidates: [] }),
		findReferences: async (symbolId) => ({ symbolId, references: [], total: 0, truncated: false, tier: "bound" }),
		resolveImport: async () => ({ status: "unresolved", reason: "NotImplemented" }),
		typeOf: async () => ({ status: "unknown", reason: "NotImplemented" }),
		indexStatus: async () => ({
			state: "ready",
			done: 1,
			total: 1,
			failures: 0,
			failed: [],
			stored: 1,
			fullFiles: 1,
			outlineFiles: 0,
		}),
		findLiterals: async (query) => ({
			query,
			literals: [],
			total: 0,
			truncated: false,
			count: { kind: "exact", count: 0 },
		}),
		findComments: async (query) => ({
			query,
			comments: [],
			total: 0,
			truncated: false,
			count: { kind: "exact", count: 0 },
		}),
		findDocs: async (query) => ({
			query,
			docs: [],
			total: 0,
			truncated: false,
			count: { kind: "exact", count: 0 },
		}),
		searchSymbols: async ({ text }) => ({
			text,
			symbols: [],
			total: 0,
			truncated: false,
			count: { kind: "exact", count: 0 },
		}),
		outlineModule: async () => [],
		fileNotes: async (module) => ({ module, known: true, notes: [] }),
		findImports: async (query) => ({
			query,
			imports: [],
			total: 0,
			truncated: false,
			count: { kind: "exact", count: 0 },
		}),
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
		commitsMentioning: async (name) => ({ name, mentions: [], commits: 0 }),
		readNote: async () => null,
		writeNote: async () => ({ outcome: "refused", reason: "not under test" }),
		doubtNote: async () => ({ outcome: "refused", reason: "not under test" }),
		noteBacklinks: async () => ({ notes: [], total: 0 }),
		overview: async () => ({
			files: 0,
			symbols: 0,
			references: 0,
			imports: 0,
			literals: 0,
			modules: 0,
			scope: "test",
			index: {
				state: "ready",
				done: 0,
				total: 0,
				failures: 0,
				failed: [],
				stored: 0,
				fullFiles: 0,
				outlineFiles: 0,
			},
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
		refactorStatus: async () => ({ open: false, steps: [], tracked: [], drifted: [], edited: [], issues: [] }),
		prepareRename: async (symbolId, newName) => ({
			symbolId,
			oldName: "Cart",
			newName,
			files: [],
			occurrences: 0,
			blockers: [],
			warnings: [],
			routes: { edges: [], modules: [] },
			mentions: { comments: 0, strings: 0 },
		}),
		planMove: async (symbolId) => ({ ok: false, reason: `${symbolId} is not in the index` }),
		refactorTrack: async () => ({ tracked: true }),
		refactorUndo: async () => ({ undone: false, reason: "nothing to undo" }),
		refactorRevert: async () => ({ reverted: true, modules: [] }),
		refactorCommit: async () => ({ committed: true, issues: [] }),
		refactorReplace: async () => ({ replaced: true, module: "src/a.ts", issues: [] }),
		refactorReplaceSpan: async () => ({ replaced: true, module: "src/a.ts", issues: [], transaction: "joined" }),
		refactorInsert: async () => ({ inserted: true, module: "src/a.ts", symbolIds: [], issues: [] }),
		refactorRename: async () => ({ renamed: true, modules: ["src/a.ts"], issues: [] }),
		refactorMove: async () => ({ moved: true, modules: ["src/a.ts", "src/b.ts"], issues: [] }),
		...overrides,
	};
}

/** Empty text removes. */
const NOTHING = { text: "", expectedRevision: 0 };

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

	it("diagnoses an id that names nothing once, for every handler behind the resolver", async () => {
		const dead = backend({ declarationOf: async () => null });
		const results = [
			await describeSymbol(dead, { symbolId: "x" }),
			await findReferences(dead, { symbolId: "x" }),
			await typeOfSymbol(dead, { symbolId: "x" }),
			await readNote(dead, { symbolId: "x" }),
			await writeNote(dead, { symbolId: "x", ...NOTHING }),
			await doubtNote(dead, { symbolId: "x", reason: "misleading", expectedRevision: 1 }),
			await noteBacklinks(dead, { symbolId: "x" }),
			await refactorPreview(dead, { symbolId: "x", newName: "y" }),
		];

		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toContain("x diagnosed");
		}
	});

	it("answers a file replaced between resolution and the read with the same diagnosis", async () => {
		let resolved = 0;
		const replaced = backend({
			declarationOf: async (symbolId) => {
				resolved += 1;
				return { symbolId } as unknown as StoredDeclaration;
			},
			describe: async () => null,
		});
		const result = await describeSymbol(replaced, { symbolId: "x" });

		expect(resolved).toBe(1);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("x diagnosed");
	});

	it("refuses a symbol_source call naming both ids or neither, rather than picking one", async () => {
		let asked = 0;
		const counting = backend({
			symbolSource: async () => {
				asked += 1;
				return { found: false, reason: "unreached" };
			},
		});
		expect((await symbolSource(counting, { symbolId: "x", factId: "y" })).isError).toBe(true);
		expect((await symbolSource(counting, {})).isError).toBe(true);
		expect(asked).toBe(0);
	});

	it("shows the span hash a guarded replace needs, and nothing when an older daemon sent none", async () => {
		const found = {
			found: true as const,
			name: "add",
			kind: "function",
			module: "src/a.ts",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
			text: "code",
			contentHash: "file",
		};
		const withHash = await symbolSource(backend({ symbolSource: async () => ({ ...found, spanHash: "5ba0" }) }), {
			symbolId: "x",
		});
		const without = await symbolSource(backend({ symbolSource: async () => found }), { symbolId: "x" });

		expect(JSON.stringify(withHash)).toContain("Span hash: `5ba0`");
		expect(JSON.stringify(without)).not.toContain("Span hash");
	});

	// Older daemons strip unknown fields.
	it("sends a replace carrying a span hash to the checked method, and refuses one naming no symbol", async () => {
		const asked: string[] = [];
		const routed = backend({
			refactorReplace: async () => {
				asked.push("refactorReplace");
				return { replaced: true, module: "src/a.ts", issues: [] };
			},
			refactorReplaceSpan: async (args) => {
				asked.push(`refactorReplaceSpan ${args.expectedSpanHash}`);
				return { replaced: false, issues: [], reason: "changed", stale: true };
			},
		});

		const stale = await refactorReplace(routed, { symbolId: "x", newText: "t", expectedSpanHash: "h" });
		expect(stale.isError).toBe(true);
		expect((await refactorReplace(routed, { symbolId: "x", newText: "t" })).isError).toBeFalsy();
		expect((await refactorReplace(routed, { factId: "f", newText: "t", expectedSpanHash: "h" })).isError).toBe(
			true,
		);
		expect(asked).toEqual(["refactorReplaceSpan h", "refactorReplace"]);
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

describe("the note tools", () => {
	const CART = "lexicon ts src/a.ts Cart.";
	const saved = {
		symbolId: CART,
		recordedAs: CART,
		revision: 1,
		text: "Holds items.\n\nOne per shopper.",
		summary: "Holds items.",
		restAt: 12,
		author: null,
		authoredAt: 1,
		editedBy: null,
		editedAt: 1,
		confirmedBy: null,
		confirmedAt: null,
		doubt: null,
		sourceChanged: false,
		links: [],
		proposal: null,
	};

	it("reads a missing note as a finding, not a failure", async () => {
		const result = await readNote(backend(), { symbolId: CART });
		expect(result.isError).toBeUndefined();
	});

	it("resolves a name, then sends the text and the harness's author untouched", async () => {
		const sent: unknown[] = [];
		const author = { kind: "client" as const, name: "claude-code", version: null };
		const result = await writeNote(
			backend({
				findByName: async () => [summary("Cart")],
				writeNote: async (request) => {
					sent.push(request);
					return { outcome: "saved", note: saved };
				},
			}),
			{ name: "Cart", ...NOTHING, text: "Holds items.", author },
		);

		expect(result.isError).toBeUndefined();
		expect(sent).toEqual([{ symbolId: CART, ...NOTHING, text: "Holds items.", author }]);
	});

	it("marks a refused write and a refused doubt as errors, and a proposal as neither", async () => {
		const refusing = backend({
			writeNote: async () => ({ outcome: "refused", reason: "stale revision", current: saved }),
			doubtNote: async () => ({ outcome: "refused", reason: "no note stands" }),
		});
		expect((await writeNote(refusing, { symbolId: CART, ...NOTHING })).isError).toBe(true);
		expect((await doubtNote(refusing, { symbolId: CART, reason: "misleading", expectedRevision: 1 })).isError).toBe(
			true,
		);

		const proposing = backend({ writeNote: async () => ({ outcome: "proposed", note: saved }) });
		expect((await writeNote(proposing, { symbolId: CART, ...NOTHING })).isError).toBeUndefined();
	});

	it("names a file when given a module alone, and resolves a symbol otherwise", async () => {
		const asked: string[] = [];
		const counting = backend({
			findByName: async () => [summary("Cart")],
			noteBacklinks: async (target) => {
				asked.push(target);
				return { notes: [{ symbolId: CART, summary: null }], total: 1 };
			},
		});

		await noteBacklinks(counting, { module: "src/a.ts" });
		await noteBacklinks(counting, { name: "Cart", module: "src/a.ts" });

		expect(asked).toEqual(["src/a.ts", CART]);
	});

	it("carries the note's summary on a describe", async () => {
		const result = await describeSymbol(backend({ describe: async () => described, readNote: async () => saved }), {
			symbolId: CART,
		});
		expect(result.content[0]?.text).toContain("Holds items. `read_note` shows the rest.");
	});
});

describe("resolving an import", () => {
	it("names the module a specifier landed on", async () => {
		const result = await resolveImport(
			backend({
				resolveImport: async () => ({ status: "resolved", landing: { kind: "module", module: "src/item.ts" } }),
			}),
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
					failed: [],
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

	it("says nothing extra once every file is full and ready, or when the status read fails", async () => {
		const failing = backend({
			indexStatus: async () => {
				throw new Error("no daemon is registered");
			},
		});
		for (const result of [
			await findReferences(backend(), { symbolId: "x" }),
			await findReferences(failing, { symbolId: "x" }),
		]) {
			const text = (result.content[0] as { text: string }).text;
			expect(result.isError).toBeUndefined();
			expect(text).not.toContain("lower bounds");
			expect(text).not.toContain("Still indexing");
		}
	});

	it("names each failed file with its reason, and says where the full list is", async () => {
		const result = await findReferences(
			backend({
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 5,
					failed: [
						{ module: "src/a.ts", reason: "Unexpected token" },
						{ module: "src/b.ts", reason: "Unexpected\n   end of file" },
						{ module: "src/c.ts", reason: "timed out" },
					],
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
			}),
			{ symbolId: "x" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("5 files failed to parse");
		expect(text).toContain("`src/a.ts` (Unexpected token)");
		expect(text).toContain("`src/b.ts` (Unexpected end of file)");
		expect(text).toContain("and 2 more");
		expect(text).toContain("`overview`");
	});

	it("asks about the file a symbol lives in, and leads with that file's own failure", async () => {
		const asked: Array<string | undefined> = [];
		const result = await findReferences(
			backend({
				indexStatus: async (concerning) => {
					asked.push(concerning);
					return {
						state: "ready",
						done: 1,
						total: 1,
						failures: 2,
						failed: [
							{ module: "src/a.ts", reason: "Unexpected token" },
							{ module: "src/z.ts", reason: "timed out" },
						],
						...(concerning === "src/a.ts"
							? { concerning: { module: "src/a.ts", reason: "Unexpected token" } }
							: {}),
						stored: 1,
						fullFiles: 1,
						outlineFiles: 0,
					};
				},
			}),
			{ symbolId: "lexicon ts src/a.ts Cart#" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(asked).toEqual(["src/a.ts"]);
		expect(text).toContain("`src/a.ts`, the file this answer concerns, failed to parse: Unexpected token");
		expect(text).toContain("1 other file failed to parse");
		expect(text).toContain("`src/z.ts` (timed out)");
		expect(text).not.toContain("`src/a.ts` (Unexpected token)");
	});

	it("keeps the named sample whole when the concerning file is outside it", async () => {
		const result = await findReferences(
			backend({
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 4,
					failed: [
						{ module: "src/a.ts", reason: "bad" },
						{ module: "src/b.ts", reason: "bad" },
						{ module: "src/c.ts", reason: "bad" },
					],
					concerning: { module: "src/z.ts", reason: "timed out" },
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
			}),
			{ symbolId: "lexicon ts src/z.ts Cart#" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("`src/z.ts`, the file this answer concerns, failed to parse: timed out");
		expect(text).toContain("3 other files failed to parse");
		expect(text).toContain("`src/c.ts` (bad)");
		expect(text).not.toContain("more");
	});

	it("says nothing of others when the concerning file is the only failure", async () => {
		const result = await findReferences(
			backend({
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 1,
					failed: [{ module: "src/z.ts", reason: "timed out" }],
					concerning: { module: "src/z.ts", reason: "timed out" },
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
			}),
			{ symbolId: "lexicon ts src/z.ts Cart#" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("the file this answer concerns");
		expect(text).not.toContain("other file");
		expect(text).not.toContain("1 file failed");
	});

	it("counts without naming when no failure is in the sample", async () => {
		const result = await findReferences(
			backend({
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 2,
					failed: [],
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
			}),
			{ symbolId: "x" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("2 files failed to parse; facts indexed before each failure were kept. `overview`");
	});

	it("asks about the module given when a name did not resolve", async () => {
		const asked: Array<string | undefined> = [];
		await describeSymbol(
			backend({
				indexStatus: async (concerning) => {
					asked.push(concerning);
					return {
						state: "ready",
						done: 1,
						total: 1,
						failures: 0,
						failed: [],
						stored: 1,
						fullFiles: 1,
						outlineFiles: 0,
					};
				},
			}),
			{ name: "Cart", module: "src/a.ts" },
		);
		expect(asked).toEqual(["src/a.ts"]);
	});
});

describe("refusing a search term the store cannot match as written", () => {
	it("says why before any round trip", async () => {
		let asked = 0;
		const result = await searchSymbols(
			backend({
				searchSymbols: async ({ text }) => {
					asked += 1;
					return { text, symbols: [], total: 0, truncated: false, count: { kind: "exact", count: 0 } };
				},
			}),
			{ text: "a\0b" },
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("NUL");
		expect(asked).toBe(0);
	});
});

describe("previewing a refactor without a transaction", () => {
	it("previews a rename by name, reading the plan and opening nothing", async () => {
		const asked: Array<[string, string]> = [];
		const result = await refactorPreview(
			backend({
				findByName: async () => [summary("Cart")],
				prepareRename: async (symbolId, newName) => {
					asked.push([symbolId, newName]);
					return {
						symbolId,
						oldName: "Cart",
						newName,
						files: [{ module: "src/a.ts", sites: [] }],
						occurrences: 3,
						blockers: [],
						warnings: [{ kind: "ExportedBeyondIndex", detail: "exported past the index" }],
						routes: { edges: [], modules: [] },
						mentions: { comments: 0, strings: 0 },
					};
				},
			}),
			{ name: "Cart", newName: "Basket" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(asked).toEqual([["lexicon ts src/a.ts Cart.", "Basket"]]);
		expect(result.isError).toBeUndefined();
		expect(text).toContain("Rename Cart to Basket");
		expect(text).toContain("ExportedBeyondIndex");
	});

	it("passes stops to a preview and to the step, and names each route's stop id", async () => {
		const stop = "lexicon export src/index.ts 0:9";
		const asked: Array<string[] | undefined> = [];
		const routed = backend({
			findByName: async () => [summary("Cart")],
			prepareRename: async (symbolId, newName, stops) => {
				asked.push(stops);
				return {
					symbolId,
					oldName: "Cart",
					newName,
					files: [{ module: "src/index.ts", sites: [] }],
					occurrences: 1,
					blockers: [],
					warnings: [],
					routes: {
						edges: [
							{
								fact: "export",
								id: stop,
								from: "src/index.ts",
								form: "forward",
								name: "Cart",
								state: "stopped",
								stoppable: true,
							},
						],
						modules: [],
					},
					mentions: { comments: 0, strings: 0 },
				};
			},
			refactorRename: async (_symbolId, _newName, stops) => {
				asked.push(stops);
				return { renamed: true, modules: ["src/index.ts"], issues: [] };
			},
		});
		const preview = await refactorPreview(routed, { name: "Cart", newName: "Basket", stops: [stop] });
		await refactorRename(routed, { name: "Cart", newName: "Basket", stops: [stop] });

		expect(asked).toEqual([[stop], [stop]]);
		expect((preview.content[0] as { text: string }).text).toContain(stop);
	});

	it("previews a move, naming the files it would touch", async () => {
		const result = await refactorPreview(
			backend({
				planMove: async (symbolId, toModule) => ({
					ok: true,
					symbolId,
					name: "Cart",
					fromModule: "src/a.ts",
					toModule,
					text: "export class Cart {\n\ttotal = sum;\n}\n",
					removal: { start: { line: 3, character: 0 }, end: { line: 5, character: 1 } },
					closure: [symbolId, `${symbolId}total.`],
					dependencies: [
						{ name: "total", origin: { kind: "insideClosure", symbolId: `${symbolId}total.` } },
						{
							name: "sum",
							origin: {
								kind: "sourceModule",
								symbolId: "lexicon ts src/a.ts sum.",
								name: "sum",
								exported: false,
							},
						},
						{
							name: "Money",
							origin: {
								kind: "workspaceModule",
								symbolId: "lexicon ts src/money.ts Money#",
								module: "src/money.ts",
							},
						},
						{
							name: "z",
							origin: {
								kind: "external",
								via: { specifier: "zod", importKind: "named", importedName: "z" },
							},
						},
						{ name: "ghost", origin: { kind: "unresolved", reason: "NotImplemented" } },
					],
					referencing: ["src/use.ts"],
					usedAtSource: true,
					exportsAtTarget: false,
					baseHash: "h",
				}),
			}),
			{ symbolId: "lexicon ts src/a.ts Cart#", toModule: "src/b.ts" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Move Cart from `src/a.ts` to `src/b.ts`");
		expect(text).toContain("lines 4 to 6 removed, and an import back added");
		expect(text).toContain("`src/b.ts`: 3 lines inserted");
		expect(text).toContain("`src/use.ts`: import specifier re-pointed");
		expect(text).toContain("Moves 2 symbols");
		expect(text).toContain("`sum`: stays in `src/a.ts`, and is not exported, which blocks the move");
		expect(text).toContain("`Money`: from `src/money.ts`");
		expect(text).toContain("`z`: from `zod`, outside the workspace");
		expect(text).toContain("`ghost`: unresolved (NotImplemented)");
		expect(text).not.toContain("`total`");
	});

	it("names the target as the daemon spelled it, not as the caller did", async () => {
		const result = await refactorMove(
			backend({
				refactorMove: async () => ({
					moved: true,
					toModule: "src/b.ts",
					modules: ["src/a.ts", "src/b.ts"],
					issues: [],
				}),
			}),
			{ symbolId: "lexicon ts src/a.ts Cart#", toModule: "./src/b.ts" },
		);
		expect((result.content[0] as { text: string }).text).toContain("Moved to `src/b.ts`");
	});

	it("renders a thrown plan as a tool error rather than a transport error", async () => {
		const result = await refactorPreview(
			backend({
				planMove: async () => {
					throw new Error("daemon went away");
				},
			}),
			{ symbolId: "lexicon ts src/a.ts Cart#", toModule: "src/b.ts" },
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("daemon went away");
	});

	it("refuses neither or both of a new name and a target module", async () => {
		expect((await refactorPreview(backend(), { symbolId: "x" })).isError).toBe(true);
		expect((await refactorPreview(backend(), { symbolId: "x", newName: "y", toModule: "z" })).isError).toBe(true);
	});
});

describe("reverting a refactor", () => {
	it("forwards the drift list and transaction expectation", async () => {
		const expected: Parameters<ToolBackend["refactorRevert"]>[0] = {
			drifted: [{ module: "src/a.ts", contentHash: "a".repeat(32) }],
			expect: { id: "rt-test", revision: 3 },
		};
		let received: Parameters<ToolBackend["refactorRevert"]>[0] | undefined;
		const result = await refactorRevert(
			backend({
				refactorRevert: async (args) => {
					received = args;
					return { reverted: false, modules: [], reason: "stale" };
				},
			}),
			expected,
		);

		expect(received).toEqual(expected);
		expect(result.isError).toBeUndefined();
	});

	it("names a restored file undo or revert could not reindex", async () => {
		const issues = [{ kind: "ReindexFailed", detail: "provider down", module: "src/a.ts" }];
		const undone = await refactorUndo(
			backend({ refactorUndo: async () => ({ undone: true, stepNo: 1, modules: ["src/a.ts"], issues }) }),
		);
		const reverted = await refactorRevert(
			backend({ refactorRevert: async () => ({ reverted: true, modules: ["src/a.ts"], issues }) }),
			{ drifted: [] },
		);

		for (const result of [undone, reverted]) expect(result.content[0]?.text).toContain("ReindexFailed");
	});

	it("renders the reviewed disk hash in refactor status", async () => {
		const hash = "b".repeat(32);
		const result = await refactorStatus(
			backend({
				refactorStatus: async () => ({
					open: true,
					id: "rt-test",
					steps: [],
					tracked: ["src/a.ts"],
					drifted: [{ module: "src/a.ts", contentHash: hash }],
					edited: [],
					issues: [],
				}),
			}),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("src/a.ts");
		expect(text).toContain(hash);
	});
});

describe("the outline_module handler", () => {
	it("asks for the file's notes and prints them under the outline", async () => {
		const asked: string[] = [];
		const result = await outlineModule(
			backend({
				outlineModule: async () => [summary("Cart")],
				fileNotes: async (module) => {
					asked.push(module);
					return { module, known: true, notes: [{ severity: "warning", message: "duplicate key" }] };
				},
			}),
			{ module: "src/a.ts" },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(asked).toEqual(["src/a.ts"]);
		expect(text).toContain("Cart");
		expect(text).toContain("warning: duplicate key");
	});
});

describe("the search_docs handler", () => {
	const body = (result: Awaited<ReturnType<typeof searchDocs>>) => (result.content[0] as { text: string }).text;

	it("passes every argument through, so none is silently dropped", async () => {
		let seen: unknown;
		await searchDocs(
			backend({
				findDocs: async (query) => {
					seen = query;
					return { query, docs: [], total: 0, truncated: false, count: { kind: "exact", count: 0 } };
				},
			}),
			{ text: "band-aid", fenced: true, module: "CLAUDE.md", limit: 7 },
		);

		expect(seen).toEqual({ text: "band-aid", fenced: true, module: "CLAUDE.md", limit: 7 });
	});

	it("refuses a text and a regex together rather than picking one", async () => {
		const result = await searchDocs(backend(), { text: "a", regex: "/b/" });

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("not both");
	});

	// An empty page would read as "nothing matched" when the query was actually rejected.
	it("says why a bad query failed instead of answering it with nothing", async () => {
		const result = await searchDocs(
			backend({
				findDocs: async () => {
					throw new Error("Regex failed to compile: expected /pattern/flags.");
				},
			}),
			{ regex: "[" },
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("Regex failed to compile");
	});
});
