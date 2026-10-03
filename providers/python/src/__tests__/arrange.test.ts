import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	type ArrangeImportSite,
	type ArrangeMember,
	applyEdits,
	composeSymbolId,
	coordinatesOf,
	type Position,
	type Range,
} from "@nyaa-lexicon/protocol";
import { PythonProvider } from "../main";

const CART = "src/cart.py";
const ITEMS = "src/items.py";
const USE = "src/use.py";
const roots: string[] = [];

function provider(files: Record<string, string>): PythonProvider {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-python-arrange-"));
	roots.push(root);
	for (const [module, text] of Object.entries({ "src/__init__.py": "", ...files })) {
		const file = path.join(root, module);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	const value = new PythonProvider();
	value.initialize(root);
	return value;
}

/** Lines joined, each ended. */
function py(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function symbolId(module: string, name: string): string {
	return composeSymbolId({ language: "python", module, descriptors: [{ kind: "method", name }] });
}

function span(text: string, value: string, from = 0): Range {
	const start = text.indexOf(value, from);
	if (start < 0) throw new Error(`missing ${value}`);
	const range = coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`invalid test range at ${start}`);
	return range;
}

/** Whole lines `first` to `end`, end exclusive, as the core's layout removes them. */
function lines(first: number, end: number): Range {
	return { start: { line: first, character: 0 }, end: { line: end, character: 0 } };
}

function at(line: number): Position {
	return { line, character: 0 };
}

/** A member of an arrangement out of cart. */
function member(name: string, part: Partial<ArrangeMember> = {}): ArrangeMember {
	return { symbolId: symbolId(CART, name), name, sites: [], ...part };
}

/** A `from .cart import` naming a member, located after `import`. */
function importSite(text: string, name: string, localName?: string): ArrangeImportSite {
	return {
		range: span(text, name, text.indexOf(" import ")),
		specifier: ".cart",
		importKind: "named",
		importedName: name,
		...(localName === undefined ? {} : { localName }),
		symbolId: symbolId(CART, name),
	};
}

function request(module: string, text: string, part: Partial<ArrangeEditsRequest>): ArrangeEditsRequest {
	return {
		module,
		text,
		exists: true,
		fromModule: CART,
		toModule: ITEMS,
		members: [],
		importSites: [],
		dependencies: [],
		...part,
	};
}

function answer(arrangement: ArrangeEditsRequest) {
	return provider({ [arrangement.module]: arrangement.text }).arrangeEdits(arrangement);
}

function arrange(arrangement: ArrangeEditsRequest): string {
	const response = answer(arrangement);
	if (response.status !== "ready") throw new Error(`arrangement refused with ${response.reason}`);
	if (response.blocked.length > 0) throw new Error(`arrangement blocked with ${response.blocked[0]?.reason}`);
	const result = applyEdits(arrangement.text, response.edits);
	if ("problem" in result) throw new Error(result.problem);
	return result.text;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Python arrange edits", () => {
	it("lands two members at the target's end as one group and lifts both from a source that keeps its imports", () => {
		const source = py(
			"from .util import clamp",
			"",
			"",
			"def add(left, right):",
			"    return clamp(left + right)",
			"",
			"",
			"def total(values):",
			"    return add(values[0], values[1])",
			"",
			"",
			"def keep():",
			"    return 1",
		);
		const target = py("def first():", "    return 0");
		const add = py("def add(left, right):", "    return clamp(left + right)");
		const total = py("def total(values):", "    return add(values[0], values[1])");

		expect(
			arrange(
				request(ITEMS, target, {
					members: [
						member("add", { insertion: { text: `\n${add}`, position: at(2) } }),
						member("total", { insertion: { text: `\n${total}`, position: at(2) } }),
					],
					dependencies: [
						{
							name: "clamp",
							origin: {
								kind: "workspaceModule",
								symbolId: symbolId("src/util.py", "clamp"),
								module: "src/util.py",
								via: { specifier: ".util", importKind: "named", importedName: "clamp" },
							},
						},
						{ name: "add", origin: { kind: "insideClosure", symbolId: symbolId(CART, "add") } },
					],
				}),
			),
		).toBe(`from .util import clamp\n${target}\n${add}\n${total}`);

		expect(
			arrange(
				request(CART, source, {
					members: [member("add", { removal: lines(3, 7) }), member("total", { removal: lines(7, 11) })],
				}),
			),
		).toBe(py("from .util import clamp", "", "", "def keep():", "    return 1"));
	});

	it("lands members sharing a point as one edit in member order", () => {
		const target = py("def first():", "    return 0", "", "", "def last():", "    return 9");
		const arrangement = request(ITEMS, target, {
			members: [
				member("a", { insertion: { text: py("def a():", "    return 1"), position: at(4) } }),
				member("b", { insertion: { text: `\n${py("def b():", "    return 2")}\n`, position: at(4) } }),
				// Python has no export form.
				member("c", {
					insertion: { text: `\n${py("def c():", "    return 3")}`, position: at(6), exported: true },
				}),
			],
		});

		expect(arrange(arrangement)).toBe(
			py(
				"def first():",
				"    return 0",
				"",
				"",
				"def a():",
				"    return 1",
				"",
				"def b():",
				"    return 2",
				"",
				"def last():",
				"    return 9",
				"",
				"def c():",
				"    return 3",
			),
		);
	});

	it("reorders within one module and keeps its imports as written", () => {
		const text = py(
			"from math import floor",
			"",
			"",
			"def helper(value):",
			"    return value",
			"",
			"",
			"def total(value):",
			"    return value",
			"",
			"",
			"def add(value):",
			"    return floor(helper(value))",
		);

		expect(
			arrange(
				request(CART, text, {
					toModule: CART,
					members: [
						member("add", {
							removal: lines(11, 13),
							insertion: {
								text: `${py("def add(value):", "    return floor(helper(value))")}\n`,
								position: at(3),
							},
						}),
						member("total", {
							removal: lines(6, 11),
							insertion: { text: py("def total(value):", "    return value"), position: at(6) },
						}),
					],
				}),
			),
		).toBe(
			py(
				"from math import floor",
				"",
				"",
				"def add(value):",
				"    return floor(helper(value))",
				"",
				"def helper(value):",
				"    return value",
				"",
				"def total(value):",
				"    return value",
			),
		);
	});

	it("imports every member the source still uses in one statement", () => {
		const source = py(
			"def add(left, right):",
			"    return left + right",
			"",
			"",
			"def total(values):",
			"    return add(values[0], values[1])",
			"",
			"",
			"def report(values):",
			"    return add(1, 2) + total(values)",
		);

		expect(
			arrange(
				request(CART, source, {
					members: [member("add", { removal: lines(0, 4) }), member("total", { removal: lines(4, 7) })],
					dependencies: ["add", "total"].map((name) => ({
						name,
						origin: { kind: "workspaceModule" as const, symbolId: symbolId(CART, name), module: ITEMS },
					})),
				}),
			),
		).toBe(py("from .items import add, total", "", "def report(values):", "    return add(1, 2) + total(values)"));
	});

	it("re-points each referencing statement once and splits one that keeps a staying name", () => {
		const cases = [
			[
				py("from .cart import add, total", "", "print(add(1, 2), total([1]))"),
				[undefined, undefined],
				py("from .items import add, total", "", "print(add(1, 2), total([1]))"),
			],
			[
				py("from .cart import keep, add as plus, total", "", "print(keep(), plus(1, 2), total([1]))"),
				["plus", undefined],
				py(
					"from .cart import keep",
					"from .items import add as plus, total",
					"",
					"print(keep(), plus(1, 2), total([1]))",
				),
			],
		] as const;

		for (const [text, locals, expected] of cases) {
			expect(
				arrange(
					request(USE, text, {
						members: [member("add"), member("total")],
						importSites: [importSite(text, "add", locals[0]), importSite(text, "total", locals[1])],
					}),
				),
			).toBe(expected);
		}
	});

	it("removes the target's import of a member that lands there", () => {
		const add = py("def add(left, right):", "    return left + right");
		const cases = [
			[
				py("from .cart import add", "", "", "def total(values):", "    return add(values[0], values[1])"),
				py(
					"def add(left, right):",
					"    return left + right",
					"",
					"def total(values):",
					"    return add(values[0], values[1])",
				),
			],
			[
				py(
					"from .cart import add, keep",
					"",
					"",
					"def total(values):",
					"    return keep(add(values[0], values[1]))",
				),
				py(
					"from .cart import keep",
					"",
					"",
					"def add(left, right):",
					"    return left + right",
					"",
					"def total(values):",
					"    return keep(add(values[0], values[1]))",
				),
			],
		] as const;

		for (const [text, expected] of cases) {
			expect(
				arrange(
					request(ITEMS, text, {
						members: [member("add", { insertion: { text: `${add}\n`, position: at(3) } })],
						importSites: [importSite(text, "add")],
					}),
				),
			).toBe(expected);
		}

		// The blank lines below go past an own member lifted from under the import.
		const own = py(
			"from .cart import add",
			"def own():",
			"    return 0",
			"",
			"",
			"def total(values):",
			"    return add(values[0], values[1])",
		);
		expect(
			arrange(
				request(ITEMS, own, {
					members: [
						member("add", { insertion: { text: `\n${add}`, position: at(7) } }),
						member("own", {
							symbolId: symbolId(ITEMS, "own"),
							removal: lines(1, 3),
							insertion: { text: `\n${py("def own():", "    return 0")}`, position: at(7) },
						}),
					],
					importSites: [importSite(own, "add")],
				}),
			),
		).toBe(
			py(
				"def total(values):",
				"    return add(values[0], values[1])",
				"",
				"def add(left, right):",
				"    return left + right",
				"",
				"def own():",
				"    return 0",
			),
		);
	});

	it("blocks re-pointing or trimming an import that holds a comment", () => {
		const text = py(
			"from .cart import (",
			"    keep,  # compatibility export",
			"    add,",
			")",
			"print(keep(), add())",
		);
		const add = py("def add():", "    pass");
		const cases = [
			[
				request(USE, text, { members: [member("add")], importSites: [importSite(text, "add")] }),
				span(text, "add"),
			],
			[
				request(ITEMS, text, {
					members: [member("add", { insertion: { text: `\n${add}`, position: at(5) } })],
					importSites: [importSite(text, "add")],
				}),
				{ start: at(0), end: { line: 3, character: 1 } },
			],
		] as const;

		for (const [arrangement, range] of cases) {
			const response = answer(arrangement);
			expect(response).toMatchObject({ status: "ready", blocked: [{ range, reason: "NotImplemented" }] });
			if (response.status !== "ready") continue;
			const result = applyEdits(text, response.edits);
			expect("text" in result && result.text.includes("# compatibility export")).toBe(true);
		}
	});

	it("refuses a target binding a member's name to something else, and blocks an aliased member import", () => {
		const add = { insertion: { text: py("def add():", "    pass"), position: at(1) } };
		const other = py("from .other import add", "value = add()");
		expect(answer(request(ITEMS, other, { members: [member("add", add)] }))).toMatchObject({
			status: "refused",
			reason: "TargetCollision",
		});

		const aliased = py("from .cart import add as plus", "value = plus()");
		expect(
			answer(
				request(ITEMS, aliased, {
					members: [member("add", add)],
					importSites: [importSite(aliased, "add", "plus")],
				}),
			),
		).toMatchObject({ status: "ready", blocked: [{ reason: "NotImplemented" }] });
	});

	it("imports a staying exported declaration from the source, and blocks a private one", () => {
		const target = py("def first():", "    return 0");
		const arrangement = (name: string, exported: boolean) =>
			request(ITEMS, target, {
				members: [
					member("add", {
						insertion: { text: `\n${py("def add(value):", `    return ${name}(value)`)}`, position: at(2) },
					}),
				],
				dependencies: [
					{ name, origin: { kind: "sourceModule", symbolId: symbolId(CART, name), name, exported } },
				],
			});

		expect(arrange(arrangement("helper", true))).toBe(
			py(
				"from .cart import helper",
				"def first():",
				"    return 0",
				"",
				"def add(value):",
				"    return helper(value)",
			),
		);
		expect(answer(arrangement("_helper", false))).toMatchObject({
			status: "ready",
			blocked: [{ reason: "PrivateSibling" }],
		});
	});

	it("blocks a qualified use of a member", () => {
		const text = py("from . import cart", "", "print(cart.add(1, 2))");

		expect(answer(request(USE, text, { members: [member("add", { sites: [span(text, "add")] })] }))).toMatchObject({
			status: "ready",
			edits: [],
			blocked: [{ reason: "NotImplemented" }],
		});
	});
});
