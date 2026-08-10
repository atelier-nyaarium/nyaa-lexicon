import type { DescribeResult, ReferencesResult, SymbolSummary } from "@nyaa-lexicon/core";
import { describe, expect, it } from "vitest";
import { MEMBER_PREVIEW, renderDescribe, renderReferences } from "../render";
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
		indexStatus: async () => ({ state: "ready", done: 1, total: 1, stored: 1 }),
		findLiterals: async (query) => ({ query, literals: [], total: 0, truncated: false }),
		graphOf: async (symbolId) => ({ symbolId, fanIn: 0, fanOut: 0 }),
		searchSymbols: async (text) => ({ text, symbols: [], total: 0, truncated: false }),
		outlineModule: async () => [],
		findImports: async (query) => ({ query, imports: [], total: 0, truncated: false }),
		hubs: async () => [],
		typeHierarchy: async (symbolId) => ({
			symbolId,
			supertypes: [],
			subtypes: [],
			ancestors: [],
			unboundSupertypes: [],
		}),
		fileHistory: async (module) => ({
			module,
			commits: 0,
			linesAdded: 0,
			linesDeleted: 0,
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
			index: { state: "ready", done: 0, total: 0, stored: 0 },
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

function textOf(result: { content: Array<{ text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

const described: DescribeResult = {
	symbol: summary("Cart", { kind: "class", signature: "class Cart" }),
	members: [summary("add", { kind: "method" }), summary("total", { kind: "method" })],
	referenceCount: 3,
	tier: "bound",
};

////////////////////////////////
//  Tests

describe("resolving what the caller gave", () => {
	it("uses a symbolId directly", async () => {
		const result = await describeSymbol(backend({ describe: async () => described }), { symbolId: "x" });
		expect(textOf(result)).toContain("class Cart");
	});

	it("resolves a unique name", async () => {
		const result = await describeSymbol(
			backend({ findByName: async () => [summary("Cart")], describe: async () => described }),
			{ name: "Cart" },
		);
		expect(textOf(result)).toContain("Cart");
	});

	it("lists the candidates rather than describing whichever came first", async () => {
		const two = [summary("Cart"), summary("Cart", { module: "src/b.ts" })];
		const result = await describeSymbol(backend({ findByName: async () => two }), { name: "Cart" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("2 symbols named Cart");
		expect(textOf(result)).toContain("src/b.ts");
	});

	it("says so when nothing matches, rather than answering emptily", async () => {
		const result = await describeSymbol(backend(), { name: "Ghost" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("No symbol named Ghost");
	});

	it("refuses a call giving neither name nor id", async () => {
		const result = await describeSymbol(backend(), {});
		expect(result.isError).toBe(true);
	});
});

describe("rendering a description", () => {
	it("shows the surface, the id, and a use count rather than the uses", () => {
		const rendered = renderDescribe(described);
		expect(rendered).toContain("class Cart");
		expect(rendered).toContain("members 1 to 2 of 2");
		expect(rendered).toContain("used in 3 places");
		expect(rendered).toContain("call find_references");
	});

	it("caps a long member list, since a class listing is not a class surface", () => {
		const many = { ...described, members: Array.from({ length: 60 }, (_, i) => summary(`m${i}`)) };
		const rendered = renderDescribe(many);

		expect(rendered).toContain(`members 1 to ${MEMBER_PREVIEW} of 60`);
		expect(rendered).toContain(`... ${60 - MEMBER_PREVIEW} more`);
		expect(rendered.split("\n").length).toBeLessThan(MEMBER_PREVIEW + 12);
	});

	// The cap protected the token budget by making part of the answer permanently unreachable: a
	// 48-member class had 28 members no call could get to. It says how to get the rest now.
	it("pages past the cap rather than hiding the rest forever", () => {
		const many = { ...described, members: Array.from({ length: 60 }, (_, i) => summary(`m${i}`)) };

		expect(renderDescribe(many)).toContain(`call again with from: ${MEMBER_PREVIEW}`);

		const second = renderDescribe(many, MEMBER_PREVIEW);
		expect(second).toContain(`members ${MEMBER_PREVIEW + 1} to ${MEMBER_PREVIEW * 2} of 60`);
		expect(second).toContain("m25");
		expect(second).not.toContain("m5 ");
	});

	it("says nothing about references when there are none to ask for", () => {
		expect(renderDescribe({ ...described, referenceCount: 0 })).not.toContain("call find_references");
	});
});

describe("rendering references", () => {
	function reference(module: string, line: number) {
		return {
			factId: `lexfact-stand-in-${module}-${line}`,
			module,
			name: "Cart",
			role: "call",
			targetId: "x",
			fromId: null,
			provenance: "bound",
			startLine: line,
			startCharacter: 0,
			endLine: line,
			endCharacter: 4,
		};
	}

	it("groups by file so the shape of the usage is visible", () => {
		const result: ReferencesResult = {
			symbolId: "x",
			references: [reference("a.ts", 0), reference("a.ts", 4), reference("b.ts", 2)],
			total: 3,
			truncated: false,
			tier: "bound",
		};
		const rendered = renderReferences(result);

		expect(rendered).toContain("3 references");
		expect(rendered.indexOf("a.ts")).toBeLessThan(rendered.indexOf("b.ts"));
		expect(rendered).toContain("line 1");
	});

	it("reports the cap rather than quietly truncating", () => {
		const result: ReferencesResult = {
			symbolId: "x",
			references: [reference("a.ts", 0)],
			total: 40,
			truncated: true,
			tier: "bound",
		};
		expect(renderReferences(result)).toContain("39 more");
	});

	it("states its own limits when it found nothing", () => {
		const rendered = renderReferences({
			symbolId: "x",
			references: [],
			total: 0,
			truncated: false,
			tier: "bound",
		});
		expect(rendered).toContain("No references found");
		expect(rendered).toContain("as far as binding reaches");
	});
});

describe("resolving an import", () => {
	it("names the module a specifier landed on", async () => {
		const result = await resolveImport(
			backend({ resolveImport: async () => ({ status: "resolved", module: "src/item.ts" }) }),
			{ fromModule: "src/cart.ts", specifier: "./item" },
		);
		expect(textOf(result)).toContain("resolves to src/item.ts");
	});

	it("separates external from unresolved, which are different answers", async () => {
		const external = await resolveImport(
			backend({ resolveImport: async () => ({ status: "external", packageName: "zod", version: "4.4.3" }) }),
			{ fromModule: "src/a.ts", specifier: "zod" },
		);
		expect(textOf(external)).toContain("external: zod@4.4.3");

		const missing = await resolveImport(backend(), { fromModule: "src/a.ts", specifier: "./gone" });
		expect(textOf(missing)).toContain("did not resolve (NotImplemented)");
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

	it("counts the occurrences and names the files before anything is written", async () => {
		const result = await prepareRename(backend({ ...found, prepareRename: async () => plan }), {
			name: "Cart",
			newName: "Basket",
		});

		expect(textOf(result)).toContain("3 occurrences in 2 files");
		expect(textOf(result)).toContain("src/uses.ts  2");
		expect(result.isError).toBeUndefined();
	});

	// An empty warnings list has to READ as a claim, otherwise a reader takes silence for coverage.
	it("says outright that the set is closed when it is", async () => {
		const result = await prepareRename(backend({ ...found, prepareRename: async () => plan }), {
			name: "Cart",
			newName: "Basket",
		});
		expect(textOf(result)).toContain("Every occurrence is a bound edge");
	});

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
		expect(textOf(result)).toContain("may not be complete");
		expect(textOf(result)).toContain("src/x.ts:7");
	});

	it("refuses on a blocker, which is a different answer from a warning", async () => {
		const blocked = { ...plan, blockers: [{ kind: "SameName", detail: "already named Cart" }] };
		const result = await prepareRename(backend({ ...found, prepareRename: async () => blocked }), {
			name: "Cart",
			newName: "Cart",
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Cannot rename Cart");
	});
});

// The daemon answers before its first scan finishes, so "no references" during a scan and "no
// references" after one are the same sentence about different worlds. Only this tells them apart.
describe("answering from an index that is still being built", () => {
	const found = { findByName: async () => [summary("Cart")] };

	it("says how much has been read when references come back empty mid-scan", async () => {
		const result = await findReferences(
			backend({ ...found, indexStatus: async () => ({ state: "indexing", done: 40, total: 700, stored: 0 }) }),
			{ name: "Cart" },
		);
		expect(textOf(result)).toContain("40 of 700 files read");
	});

	it("says nothing extra once the scan is done, so the note means something", async () => {
		const result = await findReferences(backend(found), { name: "Cart" });
		expect(textOf(result)).not.toContain("Still indexing");
	});

	it("does not let an unbuilt index look like an empty repository", async () => {
		const result = await findReferences(
			backend({ ...found, indexStatus: async () => ({ state: "unstarted", done: 0, total: 0, stored: 0 }) }),
			{ name: "Cart" },
		);
		expect(textOf(result)).toContain("has not been built yet");
	});

	// The commonest answer during a cold scan, and the one the first version of this missed.
	it("qualifies 'no symbol named that', which otherwise reads as a settled fact", async () => {
		const result = await describeSymbol(
			backend({ indexStatus: async () => ({ state: "indexing", done: 12, total: 700, stored: 0 }) }),
			{ name: "Ghost" },
		);

		expect(textOf(result)).toContain("No symbol named Ghost");
		expect(textOf(result)).toContain("12 of 700 files read");
	});

	it("qualifies a rename plan too, since a partial index makes a partial plan", async () => {
		const result = await prepareRename(
			backend({ ...found, indexStatus: async () => ({ state: "indexing", done: 5, total: 700, stored: 0 }) }),
			{ name: "Cart", newName: "Basket" },
		);
		expect(textOf(result)).toContain("5 of 700 files read");
	});

	/**
	 * A rescan over an index that already holds files is a REFRESH, not a cold build.
	 *
	 * The answer came from a complete earlier scan, so calling it incomplete is its own dishonesty:
	 * a daemon restart would otherwise stamp every correct answer as unreliable, and a caveat that
	 * is usually wrong is one a reader learns to skip.
	 */
	it("separates a refresh over a warm index from a cold build", async () => {
		const result = await findReferences(
			backend({ ...found, indexStatus: async () => ({ state: "indexing", done: 3, total: 109, stored: 109 }) }),
			{ name: "Cart" },
		);

		expect(textOf(result)).toContain("Answered from an index of 109 files");
		expect(textOf(result)).toContain("rescan is in progress (3 of 109)");
		expect(textOf(result)).not.toContain("may be incomplete");
	});
});

describe("asking for a type", () => {
	const found = { findByName: async () => [summary("Cart")] };

	it("says a declared type came from source", async () => {
		const result = await typeOfSymbol(
			backend({ ...found, typeOf: async () => ({ status: "known", display: "number", provenance: "declared" }) }),
			{ name: "Cart" },
		);
		expect(textOf(result)).toContain("Cart: number");
		expect(textOf(result)).toContain("declared in source");
	});

	it("states what an inferred type was inferred from", async () => {
		const result = await typeOfSymbol(
			backend({
				...found,
				typeOf: async () => ({ status: "inferred", display: "string", basis: "return statements" }),
			}),
			{ name: "Cart" },
		);
		expect(textOf(result)).toContain("inferred from return statements");
	});

	// The distinction the whole tri-state design exists for: a reader must never mistake "nobody
	// built this yet" for "the checker looked and found nothing".
	it("keeps an unimplemented tier distinct from a type the language cannot know", async () => {
		const notBuilt = await typeOfSymbol(
			backend({ ...found, typeOf: async () => ({ status: "unknown", reason: "NotImplemented" }) }),
			{ name: "Cart" },
		);
		const cannotKnow = await typeOfSymbol(
			backend({ ...found, typeOf: async () => ({ status: "unknown", reason: "DynamicallyTyped" }) }),
			{ name: "Cart" },
		);

		expect(textOf(notBuilt)).toContain("NotImplemented");
		expect(textOf(cannotKnow)).toContain("DynamicallyTyped");
		expect(textOf(notBuilt)).not.toEqual(textOf(cannotKnow));
	});

	it("asks the caller to choose rather than typing whichever symbol came first", async () => {
		const result = await typeOfSymbol(
			backend({ findByName: async () => [summary("Cart"), summary("Cart", { module: "src/b.ts" })] }),
			{ name: "Cart" },
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Pass one of the symbolIds above to pick one.");
		// The ids themselves must be in the answer, or eight identical minified methods render as
		// eight identical lines and "pick one" is an instruction nobody can follow.
		expect(textOf(result)).toContain("lexicon ts src/a.ts Cart.");
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
