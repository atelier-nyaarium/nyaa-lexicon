import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Declaration, Reference } from "@nyaa-lexicon/protocol";
import { QUESTION_CLASSES } from "@nyaa-lexicon/protocol";
import { LexiconService } from "../service";
import { fromText } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

let dir: string;
let store: IndexStore;
let service: LexiconService;

const at = (line: number, character = 0) => ({
	start: { line, character },
	end: { line, character: character + 8 },
});
const over = (start: number, end: number) => ({
	start: { line: start, character: 0 },
	end: { line: end, character: 1 },
});

const IDS = {
	shop: "lexicon reference shop.ref Shop#",
	open: "lexicon reference shop.ref Shop#open().",
	amount: "lexicon reference shop.ref Shop#open().(amount)",
	total: "lexicon reference shop.ref Shop#open().total.",
	line: "lexicon reference shop.ref Shop#Line#",
	price: "lexicon reference shop.ref Shop#Line#price.",
	helper: "lexicon reference shop.ref helper().",
	checkout: "lexicon reference use.ref checkout().",
};

function declare(
	symbolId: string,
	kind: Declaration["kind"],
	name: string,
	range: ReturnType<typeof over>,
	extra: { containerId?: string; visibility?: Declaration["visibility"] } = {},
): Declaration {
	return {
		symbolId,
		kind,
		name,
		range,
		selectionRange: range,
		visibility: extra.visibility ?? "public",
		...(extra.containerId === undefined ? {} : { containerId: extra.containerId }),
	};
}

function uses(
	name: string,
	target: string,
	range: ReturnType<typeof at>,
	fromId?: string,
	role: Reference["role"] = "typeUse",
): Reference {
	return {
		name,
		range,
		role,
		...(fromId === undefined ? {} : { fromId }),
		binding: { status: "bound", symbolId: target, provenance: "bound" },
	};
}

function file(module: string, declarations: Declaration[], references: Reference[]): void {
	store.replaceFile({ module, contentHash: module, declarations, references, imports: [], literals: [] });
}

/** `Shop` holds `open` (a parameter, a local) and nested `Line`; `use.ref` uses `Line` twice. */
function plant(): void {
	store.replaceFile({
		module: "shop.ref",
		contentHash: "shop",
		declarations: [
			declare(IDS.shop, "class", "Shop", over(0, 20)),
			declare(IDS.open, "method", "open", over(2, 10), { containerId: IDS.shop }),
			declare(IDS.amount, "variable", "amount", over(3, 3), { containerId: IDS.open, visibility: "local" }),
			declare(IDS.total, "variable", "total", over(4, 4), { containerId: IDS.open, visibility: "fileLocal" }),
			declare(IDS.line, "class", "Line", over(12, 15), { containerId: IDS.shop }),
			declare(IDS.price, "property", "price", over(13, 13), { containerId: IDS.line }),
			declare(IDS.helper, "function", "helper", over(22, 24)),
		],
		references: [
			uses("helper", IDS.helper, at(5), IDS.total, "call"),
			{
				name: "Money",
				range: at(6),
				role: "typeUse",
				fromId: IDS.open,
				binding: { status: "unbound", reason: "NotIndexed", detail: "not in the index" },
			},
			uses("Money", IDS.helper, at(7), IDS.open, "import"),
			{
				name: "pick",
				range: at(8),
				role: "call",
				fromId: IDS.open,
				binding: { status: "ambiguous", candidates: [IDS.helper, IDS.checkout], provenance: "nameMatched" },
			},
			uses("Line", IDS.line, at(23), IDS.helper),
		],
		imports: [],
		literals: [{ kind: "string", value: "tax", range: at(4, 10), containerId: IDS.total }],
		depth: "full",
		comments: [
			{
				range: at(7),
				raw: "// Sum before tax.",
				normalized: "Sum before tax.",
				form: "leading",
				placement: "above",
				anchorId: IDS.total,
			},
		],
	});
	file(
		"use.ref",
		[declare(IDS.checkout, "function", "checkout", over(0, 5))],
		[uses("Line", IDS.line, at(1), IDS.checkout), uses("Line", IDS.line, at(7))],
	);
	file(
		"import.ref",
		[],
		[uses("Line", IDS.line, at(0), undefined, "import"), uses("Line", IDS.line, at(1), undefined, "export")],
	);
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-drill-ins-"));
	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	service = new LexiconService(
		store,
		new ProviderSupervisor(),
		fromText(() => null),
		dir,
	);
	plant();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function names(scope: ReturnType<LexiconService["knowledgeScope"]>): Array<[string, number]> | undefined {
	return scope?.symbols.map((entry) => [entry.symbol.name, entry.depth]);
}

describe("a reference list", () => {
	it("names each use's top-level declaration and language, leaving import and export lines out", () => {
		const found = service.findReferences(IDS.line, 50);

		expect(found.references.map((row) => [row.module, row.topLevel?.name ?? null, row.language])).toEqual([
			["shop.ref", "helper", "reference"],
			["use.ref", "checkout", "reference"],
			["use.ref", null, "reference"],
		]);
		expect(found.total).toBe(3);
		expect(service.describe(IDS.line)).toMatchObject({ referenceCount: 3, graph: { dependents: 3 } });
	});

	it("counts no import or export line in any graph number", () => {
		const a = "lexicon reference loop.ref a().";
		const b = "lexicon reference loop.ref b().";
		file(
			"loop.ref",
			[declare(a, "function", "a", over(0, 2)), declare(b, "function", "b", over(3, 5))],
			[
				uses("b", b, at(1), a, "call"),
				uses("a", a, at(4), b, "import"),
				uses("Line", IDS.line, at(4, 9), b, "export"),
			],
		);
		const hubs = service.mostReferenced(20);

		expect(service.describe(IDS.line)?.graph).toMatchObject({ fanIn: 3, dependents: 3 });
		expect(service.describe(b)?.graph).toEqual({ symbolId: b, fanOut: 0, fanIn: 1, dependents: 1 });
		expect(hubs.find((row) => row.symbolId === IDS.line)?.count).toBe(3);
		expect(hubs.find((row) => row.symbolId === IDS.helper)?.count).toBe(1);
		expect(hubs.some((row) => row.symbolId === a)).toBe(false);
		expect(service.knowledgeGaps(b).rows.map((row) => row.symbolId)).toEqual([b]);
		expect(service.knowledgeGaps(undefined, "describe", 60, "shop.ref").rows).toContainEqual(
			expect.objectContaining({ symbolId: IDS.line, fanIn: 3 }),
		);
	});

	it("lists what a symbol uses from anywhere inside it, saying how each bound", () => {
		const found = service.usesFrom(IDS.shop, 50);

		expect(
			found.references.map((row) => [row.name, row.status, row.reason ?? null, row.target?.name ?? null]),
		).toEqual([
			["helper", "bound", null, "helper"],
			["Money", "unbound", "NotIndexed", null],
			["pick", "ambiguous", null, null],
		]);
		expect(found.total).toBe(3);
	});

	it("keeps source order within a line, for uses of a symbol and uses from one", () => {
		const go = "lexicon reference order.ref go().";
		file(
			"order.ref",
			[declare(go, "function", "go", over(0, 2))],
			[uses("right", IDS.line, at(1, 9), go), uses("left", IDS.line, at(1, 1), go)],
		);

		expect(service.usesFrom(go, 50).references.map((row) => row.name)).toEqual(["left", "right"]);
		expect(
			service
				.findReferences(IDS.line, 50)
				.references.filter((row) => row.module === "order.ref")
				.map((row) => row.name),
		).toEqual(["left", "right"]);
	});

	it("gives a module-level use its file's language, the same as a declared use in that file", () => {
		const run = "lexicon reference calls.ref run().";
		file(
			"calls.ref",
			[declare(run, "function", "run", over(1, 2))],
			[uses("Line", IDS.line, at(0, 9)), uses("Line", IDS.line, at(1, 9), run)],
		);

		expect(
			service
				.findReferences(IDS.line, 50)
				.references.filter((row) => row.module === "calls.ref")
				.map((row) => [row.fromId, row.language]),
		).toEqual([
			[null, "reference"],
			[run, "reference"],
		]);
	});
});

describe("a grouping declaration", () => {
	const ns = "lexicon reference ns.ref Acme/";
	const line = `${ns}Line#`;
	const cart = `${ns}Cart#`;
	const add = `${cart}add().`;
	const other = `${ns}Other#`;
	const field = `${other}x.`;

	function plantNamespace(range: ReturnType<typeof over>): void {
		file(
			"ns.ref",
			[
				declare(ns, "namespace", "Acme", range),
				declare(line, "class", "Line", over(1, 1), { containerId: ns }),
				declare(cart, "class", "Cart", over(2, 4), { containerId: ns }),
				declare(add, "method", "add", over(3, 3), { containerId: cart }),
				declare(other, "class", "Other", over(5, 7), { containerId: ns }),
				declare(field, "field", "x", over(6, 6), { containerId: other }),
			],
			[
				uses("Line", line, at(3, 2), add),
				uses("Line", line, at(3, 12), add),
				uses("Line", line, at(6, 2), field),
			],
		);
	}

	it.each([
		["a block namespace", over(0, 10)],
		["a file-scoped namespace", over(0, 0)],
	])("holds nothing in %s: its classes are the top level", (_shape, range) => {
		plantNamespace(range);

		expect(service.findReferences(line, 50).references.map((row) => row.topLevel?.name)).toEqual([
			"Cart",
			"Cart",
			"Other",
		]);
		expect(service.describe(line)?.graph.dependents).toBe(2);
		const expected: Array<[string, number]> = [
			["Line", 0],
			["add", 1],
			["Cart", 0],
			["x", 1],
			["Other", 0],
		];
		expect(names(service.knowledgeScope({ module: "ns.ref" }))).toEqual(expected);
		expect(names(service.knowledgeScope({ symbolId: ns, members: true }))).toEqual(expected);
	});

	it("answers empty for the namespace alone, its members with members: true", () => {
		plantNamespace(over(0, 10));

		expect(service.knowledgeScope({ symbolId: ns })).toEqual({ symbols: [], localsExcluded: 0 });
		expect(names(service.knowledgeScope({ symbolId: ns, members: true }))?.map(([name]) => name)).toEqual([
			"Line",
			"add",
			"Cart",
			"x",
			"Other",
		]);
	});
});

describe("a knowledge scope", () => {
	it("orders a module's members before the declaration holding them, leaving locals out", () => {
		expect(names(service.knowledgeScope({ module: "shop.ref" }))).toEqual([
			["open", 1],
			["price", 2],
			["Line", 1],
			["Shop", 0],
			["helper", 0],
		]);
		expect(service.knowledgeScope({ module: "shop.ref" })?.localsExcluded).toBe(2);
		expect(
			names(service.knowledgeScope({ module: "shop.ref", includeLocals: true }))?.map(([name]) => name),
		).toEqual(["amount", "total", "open", "price", "Line", "Shop", "helper"]);
	});

	it("takes one symbol alone or with its members, siblings on one line in source order, and none unknown", () => {
		const holder = "lexicon reference row.ref P#";
		file(
			"row.ref",
			[
				declare(holder, "class", "P", over(0, 2)),
				{ ...declare(`${holder}b.`, "property", "b", over(1, 1), { containerId: holder }), range: at(1, 9) },
				{ ...declare(`${holder}a.`, "property", "a", over(1, 1), { containerId: holder }), range: at(1, 1) },
			],
			[],
		);

		expect(names(service.knowledgeScope({ symbolId: IDS.line }))).toEqual([["Line", 0]]);
		expect(names(service.knowledgeScope({ symbolId: holder, members: true }))?.map(([name]) => name)).toEqual([
			"a",
			"b",
			"P",
		]);
		expect(service.knowledgeScope({ symbolId: `${IDS.line}Gone#` })).toBeNull();
	});

	it("carries each question's recorded time, grade and demand", async () => {
		const declaration = store.declaration(IDS.line)?.factId as string;
		const recorded = await service.recordAnswer(IDS.line, "describe", "A priced entry.", [declaration]);
		if (!recorded.recorded) throw new Error(recorded.reason);
		service.recordDemand({ symbolId: IDS.line, question: "why" });

		const [line] = service.knowledgeScope({ symbolId: IDS.line })?.symbols ?? [];
		const byQuestion = new Map(line?.questions.map((entry) => [entry.question, entry]));

		expect(byQuestion.get("describe")).toMatchObject({ createdAt: recorded.answer.createdAt, thin: true });
		expect(byQuestion.get("why")).toEqual({ question: "why", askCount: 1 });
		// IDS.line is a class: no `effects`, per questionsFor.
		expect(line?.questions.map((entry) => entry.question)).toEqual([
			"describe",
			"why",
			"relate",
			"contract",
			"usage",
		]);
	});

	it("gates each member's questions by kind, and a local's by visibility", () => {
		const scope = service.knowledgeScope({ module: "shop.ref", includeLocals: true });
		const byName = new Map(
			scope?.symbols.map((entry): [string, string[]] => [
				entry.symbol.name,
				entry.questions.map((q) => q.question),
			]),
		);

		expect(byName.get("amount")).toEqual([]); // local variable: none
		expect(byName.get("total")).toEqual(["describe", "why", "contract", "usage"]); // fileLocal variable
		expect(byName.get("open")).toEqual([...QUESTION_CLASSES]); // method
		expect(byName.get("price")).toEqual(["describe", "contract"]); // property
		expect(byName.get("Line")).toEqual(["describe", "why", "relate", "contract", "usage"]); // class
		expect(byName.get("helper")).toEqual([...QUESTION_CLASSES]); // function
	});

	it("keeps an answer's own trouble apart from what it leans on, as gaps and recall do", async () => {
		const record = async (symbolId: string, citations: string[]) => {
			const outcome = await service.recordAnswer(symbolId, "describe", `About ${symbolId}.`, citations);
			if (!outcome.recorded) throw new Error(outcome.reason);
			return outcome.answer.factId;
		};
		const priceAnswer = await record(IDS.price, [store.declaration(IDS.price)?.factId as string]);
		await record(IDS.line, [store.declaration(IDS.line)?.factId as string, priceAnswer]);
		const doubt = service.invalidateAnswer(IDS.price, "Prices moved to cents.", "describe").doubted[0]?.doubt;

		const describeOf = (name: string) =>
			service
				.knowledgeScope({ symbolId: IDS.line, members: true })
				?.symbols.find((entry) => entry.symbol.name === name)
				?.questions.find((entry) => entry.question === "describe");
		expect(describeOf("price")).toMatchObject({ doubted: true });
		expect(describeOf("price")?.shaky).toBeUndefined();
		expect(describeOf("Line")).toMatchObject({ shaky: true });
		expect(describeOf("Line")?.doubted).toBeUndefined();
		expect(describeOf("Line")?.stale).toBeUndefined();

		const gaps = service.knowledgeGaps(undefined, "describe", 10, "shop.ref");
		expect(gaps.rows.filter((row) => row.why !== "missing").map((row) => [row.symbolId, row.why])).toEqual([
			[IDS.price, "doubted"],
		]);
		const demand = service.demandOf(IDS.line, "describe", service.recallAnswer(IDS.line, "describe"));
		expect(demand).not.toBeNull();

		// Asked while shaky, then healed.
		if (demand !== null) service.recordDemand(demand);
		const workspaceWhy = () =>
			new Map(service.knowledgeGaps().rows.map((row) => [row.symbolId, row.shaky === true ? "shaky" : row.why]));
		expect(workspaceWhy()).toEqual(
			new Map([
				[IDS.line, "shaky"],
				[IDS.price, "doubted"],
			]),
		);
		expect(service.knowledgeGaps().rows.find((row) => row.symbolId === IDS.line)?.why).toBe("stale");

		const healed = await service.reaffirmAnswer(IDS.price, "describe", { resolvesDoubt: doubt?.factId as string });
		expect(healed.recorded).toBe(true);
		expect(workspaceWhy().has(IDS.line)).toBe(false);
	});
});

describe("a symbol's declared members", () => {
	it("leave out a method's parameter and local, while what the local uses still counts", () => {
		const cart = "lexicon reference cart.ref Cart#";
		const add = `${cart}add().`;
		file(
			"cart.ref",
			[
				declare(cart, "class", "Cart", over(0, 9)),
				declare(add, "method", "add", over(1, 8), { containerId: cart }),
				declare(`${add}(qty)`, "variable", "qty", over(1, 1), { containerId: add }),
				declare(`${add}sum.`, "variable", "sum", over(2, 2), { containerId: add }),
			],
			[uses("helper", IDS.helper, at(2, 9), `${add}sum.`, "call"), uses("Line", IDS.line, at(3), add)],
		);

		expect(service.describe(add)).toMatchObject({ members: [], graph: { fanOut: 2 } });
		expect(service.describe(add)?.graph.viaMembers).toBeUndefined();
		expect(service.describe(cart)?.members.map((member) => member.name)).toEqual(["add"]);
		expect(service.describe(cart)?.graph).toMatchObject({ fanOut: 2, viaMembers: 1 });
	});
});

describe("reads over a malformed index", () => {
	it("survives a container cycle, naming no top-level holder", () => {
		const A = "lexicon reference loop.ref A#";
		const B = "lexicon reference loop.ref B#";
		file(
			"loop.ref",
			[declare(A, "class", "A", at(0), { containerId: B }), declare(B, "class", "B", at(1), { containerId: A })],
			[uses("Line", IDS.line, at(2), A)],
		);

		expect(names(service.knowledgeScope({ symbolId: A, members: true }))?.map(([name]) => name)).toEqual([
			"B",
			"A",
		]);
		const fromLoop = service.findReferences(IDS.line, 50).references.find((row) => row.module === "loop.ref");
		expect(fromLoop?.topLevel).toBeUndefined();
	});
});

describe("the evidence about a declaration", () => {
	it("accepts a citation of a local's comment past the listed page", async () => {
		const run = "lexicon reference many.ref run().";
		const locals = Array.from({ length: 45 }, (_, index) => `lexicon reference many.ref run().local${index}.`);
		store.replaceFile({
			module: "many.ref",
			contentHash: "many",
			declarations: [
				declare(run, "function", "run", over(0, 100)),
				...locals.map((symbolId, index) =>
					declare(symbolId, "variable", `local${index}`, at(index + 1), {
						containerId: run,
						visibility: "fileLocal",
					}),
				),
			],
			references: [],
			imports: [],
			literals: [],
			depth: "full",
			comments: locals.map((symbolId, index) => ({
				range: { start: { line: index + 1, character: 20 }, end: { line: index + 1, character: 30 } },
				raw: `// note ${index}`,
				normalized: `note ${index}`,
				form: "trailing" as const,
				placement: "after" as const,
				anchorId: symbolId,
			})),
		});
		const last = store.commentsAnchoredTo(locals[44] as string)[0]?.factId as string;

		const outcome = await service.recordAnswer(run, "why", "Keeps forty-five notes.", [last]);
		expect(outcome.recorded).toBe(true);
	});

	it("gives a local's comments, literals and notes to the nearest non-local declaration alone", async () => {
		const evidence = async (symbolId: string) => {
			const facts = (await service.factsFor(symbolId))?.facts ?? [];
			return {
				comments: facts.filter((fact) => fact.kind === "comment").map((fact) => fact.factId),
				literals: facts.filter((fact) => fact.kind === "literal").map((fact) => fact.factId),
				notes: service.describe(symbolId)?.comments?.map((note) => note.line) ?? [],
			};
		};
		const comment = store.commentsAnchoredTo(IDS.total).map((row) => row.factId);
		const literal = store.literalsContainedBy(IDS.total, 5).map((row) => row.factId);

		expect(comment).toHaveLength(1);
		expect(literal).toHaveLength(1);
		expect(await evidence(IDS.open)).toEqual({ comments: comment, literals: literal, notes: [7] });
		expect(await evidence(IDS.shop)).toEqual({ comments: [], literals: [], notes: [] });
	});
});
