import { describe, expect, it, mock } from "bun:test";
import type {
	Answer,
	CallHierarchy,
	DescribeResult,
	FileEdits,
	RecalledAnswer,
	ReferencesResult,
	RenameEditPlan,
	RenamePlan,
	StoredDeclaration,
	StoredReference,
	SymbolSummary,
	TypeHierarchy,
	TypeInfo,
} from "@nyaa-lexicon/core";
import type { LexiconReads } from "../reads";
import { LspServer, pathFromUri, type Range, type TypeHierarchyItem, toModule, toUri } from "../server";

////////////////////////////////
//  Helpers

const ROOT = "/workspace/project";
const MODULE = "src/file.ts";
const URI = toUri(ROOT, MODULE);

function span(startLine: number, startCharacter: number, endLine = startLine, endCharacter = startCharacter): Range {
	return {
		start: { line: startLine, character: startCharacter },
		end: { line: endLine, character: endCharacter },
	};
}

function declaration(name: string, overrides: Partial<StoredDeclaration> = {}): StoredDeclaration {
	return {
		symbolId: `symbol:${name}`,
		factId: `fact:${name}`,
		module: MODULE,
		name,
		kind: "function",
		visibility: "public",
		range: span(0, 0, 10, 0),
		selectionRange: span(0, 0, 0, name.length),
		...overrides,
	};
}

function summary(symbolId: string, name: string, kind: SymbolSummary["kind"] = "class"): SymbolSummary {
	return {
		symbolId,
		name,
		kind,
		module: MODULE,
		visibility: "public",
	};
}

function referencesResult(symbolId: string, references: StoredReference[] = []): ReferencesResult {
	return { symbolId, references, total: references.length, truncated: false, tier: "bound" };
}

function described(referenceCount: number, docComment?: string): DescribeResult {
	return {
		symbol: { ...summary("symbol:item", "item", "function"), ...(docComment === undefined ? {} : { docComment }) },
		members: [],
		referenceCount,
		graph: { symbolId: "symbol:item", fanIn: referenceCount, fanOut: 0 },
		hierarchy: {
			symbolId: "symbol:item",
			supertypes: [],
			subtypes: [],
			ancestors: [],
			unboundSupertypes: [],
		},
		tier: "bound",
	};
}

function recalled(prose: string, overrides: Partial<RecalledAnswer> = {}): RecalledAnswer {
	const answer: Answer = {
		symbolId: "symbol:item",
		question: "describe",
		factId: "answer:item",
		prose,
		citations: [],
		thin: true,
		createdAt: 1,
	};
	return {
		answer,
		stale: [],
		inheritedStale: [],
		doubtedUpstream: [],
		...overrides,
	};
}

function plan(symbolId: string, newName: string, blockers: RenamePlan["blockers"] = []): RenamePlan {
	return {
		symbolId,
		oldName: "item",
		newName,
		files: [],
		occurrences: 0,
		blockers,
		warnings: [],
	};
}

function reads(overrides: Partial<LexiconReads> = {}): LexiconReads {
	return {
		declarationsIn: async () => [],
		declarationOf: async () => null,
		describe: async () => null,
		findReferences: async (symbolId) => referencesResult(symbolId),
		typeOf: async () => ({ status: "unknown", reason: "NotImplemented" }),
		typeHierarchy: async (symbolId) => ({
			symbolId,
			supertypes: [],
			subtypes: [],
			ancestors: [],
			unboundSupertypes: [],
		}),
		callHierarchy: async (symbolId) => ({ symbolId, incoming: [], outgoing: [] }),
		recallAnswers: async () => [],
		prepareRename: async (symbolId, newName) => plan(symbolId, newName),
		renameEdits: async (symbolId, newName) => ({ ok: true, plan: plan(symbolId, newName), files: [] }),
		transactionOpen: async () => false,
		...overrides,
	};
}

function renameResult(symbolId: string, newName: string, files: FileEdits[]): RenameEditPlan {
	return { ok: true, plan: plan(symbolId, newName), files };
}

function reference(module: string, name: string, range: Range): StoredReference {
	return {
		factId: `reference:${module}:${name}`,
		module,
		name,
		role: "read",
		targetId: "symbol:item",
		fromId: null,
		provenance: "bound",
		startLine: range.start.line,
		startCharacter: range.start.character,
		endLine: range.end.line,
		endCharacter: range.end.character,
	};
}

////////////////////////////////
//  Tests

describe("URI translation", () => {
	it("round trips a module path with a space", () => {
		const module = "src/with space.ts";
		const uri = toUri(ROOT, module);

		expect(uri).toBe("file:///workspace/project/src/with%20space.ts");
		expect(pathFromUri(uri)).toBe(`${ROOT}/${module}`);
		expect(toModule(ROOT, uri)).toBe(module);
	});

	it("rejects paths outside the workspace and non-file URIs", () => {
		expect(toModule(ROOT, toUri("/workspace/other", MODULE))).toBeNull();
		expect(toModule(ROOT, "https://example.test/src/file.ts")).toBeNull();
		expect(pathFromUri("https://example.test/src/file.ts")).toBeNull();
	});
});

describe("symbol lookup", () => {
	it("returns the innermost declaration and null outside its workspace or ranges", async () => {
		const container = declaration("Container", {
			symbolId: "symbol:container",
			kind: "class",
			range: span(1, 0, 12, 0),
			selectionRange: span(1, 6, 1, 15),
		});
		const member = declaration("member", {
			symbolId: "symbol:member",
			containerId: container.symbolId,
			range: span(4, 2, 8, 2),
			selectionRange: span(4, 9, 4, 15),
		});
		const server = new LspServer(reads({ declarationsIn: async () => [container, member] }), ROOT);

		expect(await server.symbolAt(URI, { line: 5, character: 3 })).toBe(member);
		expect(await server.symbolAt(URI, { line: 20, character: 0 })).toBeNull();
		expect(await server.symbolAt(toUri("/workspace/other", MODULE), { line: 5, character: 3 })).toBeNull();
	});
});

describe("navigation", () => {
	it("definition points at the declaration selection range", async () => {
		const found = declaration("item", {
			range: span(2, 0, 8, 0),
			selectionRange: span(3, 6, 3, 10),
		});
		if (found.selectionRange === undefined) throw new Error("declaration selection range missing");
		const server = new LspServer(reads({ declarationsIn: async () => [found] }), ROOT);

		expect(await server.definition(URI, { line: 4, character: 1 })).toEqual({
			uri: URI,
			range: found.selectionRange,
		});
	});

	it("includes the declaration first or omits it from references", async () => {
		const found = declaration("item", { selectionRange: span(1, 0, 1, 4) });
		const first = reference(MODULE, "item", span(4, 2, 4, 6));
		const second = reference("src/other.ts", "item", span(7, 0, 7, 4));
		if (found.selectionRange === undefined) throw new Error("declaration selection range missing");
		const findReferences = mock(async () => referencesResult(found.symbolId, [first, second]));
		const server = new LspServer(reads({ declarationsIn: async () => [found], findReferences }), ROOT);

		const withDeclaration = await server.references(URI, { line: 1, character: 1 }, true);
		const withoutDeclaration = await server.references(URI, { line: 1, character: 1 }, false);

		expect(withDeclaration).toEqual([
			{ uri: URI, range: found.selectionRange },
			{ uri: URI, range: span(first.startLine, first.startCharacter, first.endLine, first.endCharacter) },
			{
				uri: toUri(ROOT, second.module),
				range: span(second.startLine, second.startCharacter, second.endLine, second.endCharacter),
			},
		]);
		expect(withoutDeclaration).toEqual(withDeclaration.slice(1));
		expect(withoutDeclaration).not.toContainEqual({ uri: URI, range: found.selectionRange });
		expect(findReferences).toHaveBeenCalledWith(found.symbolId, 1000);
	});
});

describe("hover", () => {
	const found = declaration("item", {
		signature: "function item(): unknown",
		selectionRange: span(2, 4, 2, 8),
	});
	const documentation = "The item documentation.";

	it("omits inferred and usage lines for unknown types and marks stale prose", async () => {
		const server = new LspServer(
			reads({
				declarationsIn: async () => [found],
				typeOf: async () => ({ status: "unknown", reason: "NotImplemented" }),
				recallAnswers: async () => [recalled("Remembered stale prose.", { stale: ["old-fact"] })],
				describe: async () => described(0, documentation),
			}),
			ROOT,
		);
		const result = await server.hover(URI, { line: 3, character: 5 });

		expect(result?.contents.value).toContain(found.signature);
		expect(result?.contents.value).toContain(documentation);
		expect(result?.contents.value).toContain("Remembered stale prose. *(stale)*");
		expect(result?.contents.value).not.toContain("*inferred*");
		expect(result?.contents.value).not.toContain("Used in");
		expect(result?.range).toEqual(found.selectionRange);
	});

	it("adds inferred type information and marks doubted prose", async () => {
		const type: TypeInfo = { status: "inferred", display: "string", basis: "return statements" };
		const doubt = { factId: "doubt:item", reason: "meaning changed", at: 2 };
		const doubted = recalled("Remembered doubted prose.");
		doubted.answer.doubt = doubt;
		const server = new LspServer(
			reads({
				declarationsIn: async () => [found],
				typeOf: async () => type,
				recallAnswers: async () => [doubted],
				describe: async () => described(0),
			}),
			ROOT,
		);

		const result = await server.hover(URI, { line: 3, character: 5 });

		expect(result?.contents.value).toContain("*inferred* `string` from return statements");
		expect(result?.contents.value).toContain("Remembered doubted prose. *(doubted)*");
		expect(result?.contents.value).not.toContain("*(stale)*");
	});

	it("leaves clean recalled prose unmarked", async () => {
		const server = new LspServer(
			reads({
				declarationsIn: async () => [found],
				typeOf: async () => ({ status: "known", display: "number", provenance: "declared" }),
				recallAnswers: async () => [recalled("Clean remembered prose.")],
				describe: async () => described(2),
			}),
			ROOT,
		);

		const result = await server.hover(URI, { line: 3, character: 5 });

		expect(result?.contents.value).toContain("Clean remembered prose.");
		expect(result?.contents.value).not.toContain("*(stale)*");
		expect(result?.contents.value).not.toContain("*(doubted)*");
		expect(result?.contents.value).toContain("Used in 2 places.");
	});
});

describe("type navigation", () => {
	it("returns null for primitive, union, and external types without symbols", async () => {
		const found = declaration("value");
		const types: TypeInfo[] = [
			{ status: "known", display: "number", provenance: "declared" },
			{ status: "known", display: "A | B", provenance: "declared" },
			{ status: "unknown", reason: "ExternalDependency" },
		];
		const declarationOf = mock(async () => declaration("adjacent"));

		for (const type of types) {
			const server = new LspServer(
				reads({ declarationsIn: async () => [found], typeOf: async () => type, declarationOf }),
				ROOT,
			);
			expect(await server.typeDefinition(URI, { line: 1, character: 1 })).toBeNull();
		}

		expect(declarationOf).not.toHaveBeenCalled();
	});

	it("maps subtypes to locations and drops missing declarations", async () => {
		const found = declaration("Base", { symbolId: "symbol:base", kind: "class" });
		const child = declaration("Child", {
			symbolId: "symbol:child",
			module: "src/child.ts",
			kind: "class",
			selectionRange: span(2, 0, 2, 5),
		});
		const typeHierarchy = mock(
			async (symbolId: string): Promise<TypeHierarchy> => ({
				symbolId,
				supertypes: [],
				subtypes: [summary(child.symbolId, child.name), summary("symbol:missing", "Missing")],
				ancestors: [],
				unboundSupertypes: [],
			}),
		);
		const declarationOf = mock(async (symbolId: string) => (symbolId === child.symbolId ? child : null));
		const server = new LspServer(
			reads({ declarationsIn: async () => [found], typeHierarchy, declarationOf }),
			ROOT,
		);
		if (child.selectionRange === undefined) throw new Error("child selection range missing");

		expect(await server.implementation(URI, { line: 1, character: 1 })).toEqual([
			{ uri: toUri(ROOT, child.module), range: child.selectionRange },
		]);
		expect(typeHierarchy).toHaveBeenCalledWith(found.symbolId);
		expect(declarationOf).toHaveBeenCalledWith(child.symbolId);
		expect(declarationOf).toHaveBeenCalledWith("symbol:missing");
	});
});

describe("hierarchy expansion", () => {
	it("rejects malformed params without querying either hierarchy", async () => {
		const typeHierarchy = mock(
			async (symbolId: string): Promise<TypeHierarchy> => ({
				symbolId,
				supertypes: [],
				subtypes: [],
				ancestors: [],
				unboundSupertypes: [],
			}),
		);
		const callHierarchy = mock(
			async (symbolId: string): Promise<CallHierarchy> => ({
				symbolId,
				incoming: [],
				outgoing: [],
			}),
		);
		const server = new LspServer(reads({ typeHierarchy, callHierarchy }), ROOT);

		expect(await server.typeHierarchyStep({}, "supertypes")).toEqual([]);
		expect(await server.typeHierarchyStep({ item: { data: 7 } }, "subtypes")).toEqual([]);
		expect(await server.callHierarchyStep({}, "incoming")).toEqual([]);
		expect(await server.callHierarchyStep({ item: { data: {} } }, "outgoing")).toEqual([]);
		expect(typeHierarchy).not.toHaveBeenCalled();
		expect(callHierarchy).not.toHaveBeenCalled();
	});

	it("uses item data for type and call expansions", async () => {
		const root = declaration("Root", { symbolId: "symbol:root", kind: "class" });
		const parent = declaration("Parent", { symbolId: "symbol:parent", kind: "class" });
		const child = declaration("Child", { symbolId: "symbol:child", kind: "class" });
		const caller = declaration("caller", { symbolId: "symbol:caller" });
		const callee = declaration("callee", { symbolId: "symbol:callee" });
		const declarations = new Map([parent, child, caller, callee].map((item) => [item.symbolId, item] as const));
		const typeHierarchy = mock(
			async (symbolId: string): Promise<TypeHierarchy> => ({
				symbolId,
				supertypes: [summary(parent.symbolId, parent.name)],
				subtypes: [summary(child.symbolId, child.name)],
				ancestors: [],
				unboundSupertypes: [],
			}),
		);
		const incomingRanges = [span(5, 2, 5, 7)];
		const outgoingRanges = [span(8, 4, 8, 10)];
		const callHierarchy = mock(
			async (symbolId: string): Promise<CallHierarchy> => ({
				symbolId,
				incoming: [{ symbol: summary(caller.symbolId, caller.name, "function"), ranges: incomingRanges }],
				outgoing: [{ symbol: summary(callee.symbolId, callee.name, "function"), ranges: outgoingRanges }],
			}),
		);
		const declarationOf = mock(async (symbolId: string) => declarations.get(symbolId) ?? null);
		const server = new LspServer(
			reads({ declarationsIn: async () => [root], typeHierarchy, callHierarchy, declarationOf }),
			ROOT,
		);

		const preparedType = await server.prepareTypeHierarchy(URI, { line: 1, character: 1 });
		const typeItem = preparedType[0] as TypeHierarchyItem;
		expect(typeItem.data).toBe(root.symbolId);
		const typeResult = await server.typeHierarchyStep({ item: typeItem }, "supertypes");
		expect(typeHierarchy).toHaveBeenCalledWith(root.symbolId);
		expect(typeResult[0]?.data).toBe(parent.symbolId);

		const preparedCall = await server.prepareCallHierarchy(URI, { line: 1, character: 1 });
		const callItem = preparedCall[0] as TypeHierarchyItem;
		expect(callItem.data).toBe(root.symbolId);
		const incoming = await server.callHierarchyStep({ item: callItem }, "incoming");
		const outgoing = await server.callHierarchyStep({ item: callItem }, "outgoing");

		expect(callHierarchy).toHaveBeenNthCalledWith(1, root.symbolId);
		expect(callHierarchy).toHaveBeenNthCalledWith(2, root.symbolId);
		expect(incoming[0]?.from?.data).toBe(caller.symbolId);
		expect(incoming[0]?.to).toBeUndefined();
		expect(incoming[0]?.fromRanges).toEqual(incomingRanges);
		expect(outgoing[0]?.to?.data).toBe(callee.symbolId);
		expect(outgoing[0]?.from).toBeUndefined();
		expect(outgoing[0]?.fromRanges).toEqual(outgoingRanges);
	});
});

describe("document outline", () => {
	it("nests local members and keeps members with external containers at the top level", async () => {
		const container = declaration("Container", {
			symbolId: "symbol:container",
			kind: "class",
			range: span(0, 0, 20, 0),
			selectionRange: span(0, 6, 0, 15),
		});
		const member = declaration("member", {
			symbolId: "symbol:member",
			containerId: container.symbolId,
			range: span(3, 2, 5, 2),
			selectionRange: span(3, 9, 3, 15),
		});
		const detached = declaration("detached", {
			symbolId: "symbol:detached",
			containerId: "symbol:other-file",
			selectionRange: span(8, 0, 8, 8),
		});
		const server = new LspServer(reads({ declarationsIn: async () => [container, member, detached] }), ROOT);

		const outline = await server.documentSymbol(URI);

		expect(outline.map((node) => node.name)).toEqual([container.name, detached.name]);
		expect(outline[0]?.children?.map((node) => node.name)).toEqual([member.name]);
		expect(outline.flatMap((node) => node.children ?? []).map((node) => node.name)).toEqual([member.name]);
	});
});

describe("rename preparation", () => {
	it("refuses any blocker and returns the selection range with a placeholder otherwise", async () => {
		const found = declaration("item", { selectionRange: span(2, 3, 2, 7) });
		const blockers = [{ kind: "UnboundOccurrence", detail: "not safe" }];
		if (found.selectionRange === undefined) throw new Error("declaration selection range missing");
		const prepareRename = mock<(symbolId: string, newName: string) => Promise<RenamePlan>>()
			.mockResolvedValueOnce(plan(found.symbolId, "item_", blockers))
			.mockResolvedValueOnce(plan(found.symbolId, "item_"));
		const server = new LspServer(reads({ declarationsIn: async () => [found], prepareRename }), ROOT);

		expect(await server.prepareRename(URI, { line: 2, character: 4 })).toBeNull();
		expect(await server.prepareRename(URI, { line: 2, character: 4 })).toEqual({
			range: found.selectionRange,
			placeholder: found.name,
		});
		expect(prepareRename).toHaveBeenNthCalledWith(1, found.symbolId, "item_");
		expect(prepareRename).toHaveBeenNthCalledWith(2, found.symbolId, "item_");
	});
});

describe("rename", () => {
	it("returns null when no symbol is at the position", async () => {
		const renameEdits = mock<(symbolId: string, newName: string) => Promise<RenameEditPlan>>();
		const server = new LspServer(reads({ declarationsIn: async () => [], renameEdits }), ROOT);

		expect(await server.rename(URI, { line: 1, character: 1 }, "renamed")).toBeNull();
		expect(renameEdits).not.toHaveBeenCalled();
	});

	it("refuses an open transaction before asking for rename edits", async () => {
		const found = declaration("item");
		const renameEdits = mock<(symbolId: string, newName: string) => Promise<RenameEditPlan>>();
		const transactionOpen = mock(async () => true);
		const server = new LspServer(
			reads({ declarationsIn: async () => [found], renameEdits, transactionOpen }),
			ROOT,
		);

		expect(await server.rename(URI, { line: 1, character: 1 }, "renamed")).toBeNull();
		expect(transactionOpen).toHaveBeenCalledTimes(1);
		expect(renameEdits).not.toHaveBeenCalled();
	});

	it("returns null when the edit plan is refused", async () => {
		const found = declaration("item");
		const renameEdits = mock<(symbolId: string, newName: string) => Promise<RenameEditPlan>>().mockResolvedValue({
			ok: false,
			plan: plan(found.symbolId, "renamed"),
			reason: "blocked",
		});
		const server = new LspServer(reads({ declarationsIn: async () => [found], renameEdits }), ROOT);

		expect(await server.rename(URI, { line: 1, character: 1 }, "renamed")).toBeNull();
		expect(renameEdits).toHaveBeenCalledWith(found.symbolId, "renamed");
	});

	it("groups successful edits by module and keys them by file URI", async () => {
		const found = declaration("item");
		const firstFile: FileEdits = {
			module: MODULE,
			edits: [
				{ range: span(1, 0, 1, 4), newText: "renamed" },
				{ range: span(5, 2, 5, 6), newText: "renamed" },
			],
		};
		const secondFile: FileEdits = {
			module: "src/other.ts",
			edits: [{ range: span(3, 1, 3, 5), newText: "renamed" }],
		};
		const renameEdits = mock<(symbolId: string, newName: string) => Promise<RenameEditPlan>>().mockResolvedValue(
			renameResult(found.symbolId, "renamed", [firstFile, secondFile]),
		);
		const server = new LspServer(reads({ declarationsIn: async () => [found], renameEdits }), ROOT);

		const result = await server.rename(URI, { line: 1, character: 1 }, "renamed");

		expect(result).toEqual({
			changes: {
				[toUri(ROOT, firstFile.module)]: firstFile.edits,
				[toUri(ROOT, secondFile.module)]: secondFile.edits,
			},
		});
		expect(renameEdits).toHaveBeenCalledWith(found.symbolId, "renamed");
	});
});
