import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	applyEdits,
	comparePositions,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	parseSymbolId,
	type Reference,
} from "@nyaa-lexicon/protocol";
import { PythonProvider } from "../main";
import { Python3Dispatch } from "../python3";

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-python-provider-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

function rangeAt(text: string, index: number) {
	const range = coordinatesOf(text).rangeAt(index, index + 1);
	if (range === undefined) throw new Error(`invalid test range at ${index}`);
	return range;
}

function spanAt(text: string, index: number, value: string) {
	const range = coordinatesOf(text).rangeAt(index, index + value.length);
	if (range === undefined) throw new Error(`invalid test range for ${value}`);
	return range;
}

function ownerOf(reference: Reference | undefined): string {
	if (reference?.fromId === undefined) return "module";
	const parsed = parseSymbolId(reference.fromId);
	return parsed === null ? reference.fromId : parsed.descriptors.map((descriptor) => descriptor.name).join(".");
}

function declarationNamed(facts: { declarations: Declaration[] }, name: string): Declaration {
	const found = facts.declarations.find((declaration) => declaration.name === name);
	if (found === undefined) throw new Error(`${name} declaration missing`);
	return found;
}

function declarationWhere(
	facts: { declarations: Declaration[] },
	predicate: (declaration: Declaration) => boolean,
): Declaration {
	const found = facts.declarations.find(predicate);
	if (found === undefined) throw new Error("matching declaration missing");
	return found;
}

function writtenIn(facts: { references: Reference[] }): string[] {
	return [...facts.references]
		.sort((left, right) => comparePositions(left.range.start, right.range.start))
		.map((reference) => `${reference.name} in ${ownerOf(reference)}`);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ITEM = "class Item:\n    pass\n";
const CART = "from .item import Item\ndef make():\n    return Item()\n";

function itemWorkspace(): PythonProvider {
	const root = workspace({ "src/item.py": ITEM });
	const provider = new PythonProvider();
	provider.initialize(root);
	return provider;
}

function admitItem(provider: PythonProvider, contentHash: string): void {
	provider.parseFile({ module: "src/item.py", contentHash, text: ITEM });
	provider.moduleAdmission({ module: "src/item.py", contentHash, outcome: { status: "admitted" } });
}

/** Where the `Item()` call lands, reparsing the user each time. */
function makesItem(provider: PythonProvider): string | undefined {
	const facts = provider.parseFile({ module: "src/cart.py", contentHash: "cart", text: CART });
	return facts.references.find((candidate) => candidate.name === "Item" && candidate.role === "call")?.binding.status;
}

describe("Python provider project behavior", () => {
	it("declares extracted roles and binds a certain module call", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		const info = provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: [
				"def helper():",
				"    pass",
				"def run(value):",
				"    local = value",
				"    return helper() + local",
			].join("\n"),
		});

		expect(info.referenceRoles).toEqual(["call", "read", "write", "extends", "typeUse"]);
		expect(info.tiers).toMatchObject({ literals: true, metrics: true });
		const helper = facts.references.find((reference) => reference.name === "helper");
		expect(helper?.binding).toMatchObject({
			status: "bound",
			provenance: "bound",
			symbolId: facts.declarations.find((declaration) => declaration.name === "helper")?.symbolId,
		});
		expect(
			facts.references
				.filter((reference) => reference.name === "local")
				.every(
					(reference) => reference.binding.status === "unbound" && reference.binding.reason === "NotIndexed",
				),
		).toBe(true);
		if (helper === undefined) throw new Error("helper reference missing");
		expect(provider.bind({ module: "main.py", name: "helper", range: helper.range })).toEqual(helper.binding);
	});

	it("disambiguates module redefinitions while keeping duplicate lookup ambiguous", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"def target():",
			"    pass",
			"def f():",
			"    return target()",
			"def f():",
			"    return target()",
			"f()",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const functions = facts.declarations.filter((declaration) => declaration.name === "f");
		const ids = functions.map((declaration) => declaration.symbolId);
		const second = functions[1];
		if (second === undefined) throw new Error("second f declaration missing");

		expect(ids).toEqual([
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [{ kind: "method", name: "f" }],
			}),
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [{ kind: "method", name: "f", disambiguator: "1" }],
			}),
		]);
		expect(
			facts.references.filter((reference) => reference.name === "target").map((reference) => reference.fromId),
		).toEqual(ids);
		expect(facts.references.find((reference) => reference.name === "f")?.binding).toMatchObject({
			status: "unbound",
			reason: "Ambiguous",
		});
		expect(
			provider.bind({
				module: "main.py",
				name: "f",
				range: second.selectionRange as NonNullable<typeof second.selectionRange>,
			}),
		).toEqual({
			status: "bound",
			symbolId: second.symbolId,
			provenance: "bound",
		});
	});

	it("disambiguates conditional definitions in document order", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"if enabled:",
			"    def f():",
			"        return 1",
			"else:",
			"    def f():",
			"        return 2",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(
			facts.declarations
				.filter((declaration) => declaration.name === "f")
				.map((declaration) => declaration.symbolId),
		).toEqual([
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [{ kind: "method", name: "f" }],
			}),
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [{ kind: "method", name: "f", disambiguator: "1" }],
			}),
		]);
	});

	it("disambiguates property getter and setter declarations", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"class Item:",
			"    @property",
			"    def value(self):",
			"        return self._value",
			"    @value.setter",
			"    def value(self, new_value):",
			"        self._value = new_value",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(
			facts.declarations
				.filter((declaration) => declaration.name === "value" && declaration.kind === "method")
				.map((declaration) => declaration.symbolId),
		).toEqual([
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [
					{ kind: "type", name: "Item" },
					{ kind: "method", name: "value" },
				],
			}),
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [
					{ kind: "type", name: "Item" },
					{ kind: "method", name: "value", disambiguator: "1" },
				],
			}),
		]);
	});

	it("counts duplicate names within their enclosing scope", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f():", "    pass", "class Item:", "    def f(self):", "        pass"].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const ids = facts.declarations
			.filter((declaration) => declaration.name === "f")
			.map((declaration) => declaration.symbolId);

		expect(ids).toEqual([
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [{ kind: "method", name: "f" }],
			}),
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [
					{ kind: "type", name: "Item" },
					{ kind: "method", name: "f" },
				],
			}),
		]);
	});

	it("separates nested definition counters by enclosing scope", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"def left():",
			"    def helper():",
			"        pass",
			"def right():",
			"    def helper():",
			"        pass",
			"def repeated():",
			"    def helper():",
			"        pass",
			"    def helper():",
			"        pass",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(
			facts.declarations
				.filter((declaration) => declaration.name === "helper")
				.map((declaration) => declaration.symbolId),
		).toEqual([
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [
					{ kind: "method", name: "left" },
					{ kind: "method", name: "helper" },
				],
			}),
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [
					{ kind: "method", name: "right" },
					{ kind: "method", name: "helper" },
				],
			}),
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [
					{ kind: "method", name: "repeated" },
					{ kind: "method", name: "helper" },
				],
			}),
			composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [
					{ kind: "method", name: "repeated" },
					{ kind: "method", name: "helper", disambiguator: "1" },
				],
			}),
		]);
	});

	it("repeats symbol ids deterministically", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f():", "    pass", "def f():", "    pass"].join("\n");
		const first = provider.parseFile({ module: "main.py", contentHash: "first", text });
		const second = provider.parseFile({ module: "main.py", contentHash: "second", text });

		expect(second.declarations.map((declaration) => declaration.symbolId)).toEqual(
			first.declarations.map((declaration) => declaration.symbolId),
		);
	});

	it("indexes all function parameter forms with owned symbol ids", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = "def run(self, /, cls, value: int = 1, *args, named=2, **kwargs):\n    return value\n";
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const run = facts.declarations.find((declaration) => declaration.name === "run");
		if (run === undefined) throw new Error("run declaration missing");
		const parameters = facts.declarations.filter((declaration) => declaration.containerId === run.symbolId);

		expect(parameters.map((parameter) => parameter.name)).toEqual([
			"self",
			"cls",
			"value",
			"args",
			"named",
			"kwargs",
		]);
		for (const parameter of parameters) {
			expect(parameter).toMatchObject({
				kind: "variable",
				visibility: "local",
				exported: false,
				containerId: run.symbolId,
			});
			expect(parameter.symbolId).toBe(
				composeSymbolId({
					language: "python",
					module: "main.py",
					descriptors: [
						{ kind: "method", name: "run" },
						{ kind: "parameter", name: parameter.name },
					],
				}),
			);
		}

		const value = parameters.find((parameter) => parameter.name === "value");
		if (value === undefined) throw new Error("value parameter missing");
		expect(value.selectionRange).toEqual(spanAt(text, text.indexOf("value"), "value"));
		expect(value.range.end.character).toBeGreaterThan(
			(value.selectionRange as NonNullable<typeof value.selectionRange>).end.character,
		);
	});

	it("emits decoded searchable literals without duplicating docstrings", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		const info = provider.initialize(root);
		const text = [
			'"""module docs"""',
			'__all__ = ["add"]',
			"def add(self, *args, enabled=True, **kwargs):",
			'    """function docs"""',
			"    return 'a\\nb'",
			'fplain = f"plain"',
			'fcomplex = f"value {add}"',
			'raw = b"bytes"',
			"none_value = None",
			"hexed = 0xFF",
			"negative = -1",
			"complex_value = 1j",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const add = facts.declarations.find((declaration) => declaration.name === "add");
		if (add === undefined) throw new Error("add declaration missing");

		expect(info.tiers.literals).toBe(true);
		expect(facts.literals).toEqual([
			{
				kind: "string",
				value: "add",
				range: spanAt(text, text.indexOf('"add"'), '"add"'),
			},
			{
				kind: "boolean",
				// Decoded, so lowercase whatever Python spells: one value across every language.
				value: "true",
				range: spanAt(text, text.indexOf("True"), "True"),
				containerId: add.symbolId,
			},
			{
				kind: "string",
				value: "a\nb",
				range: spanAt(text, text.indexOf("'a\\nb'"), "'a\\nb'"),
				containerId: add.symbolId,
			},
			{
				kind: "string",
				value: "plain",
				range: spanAt(text, text.indexOf('f"plain"'), 'f"plain"'),
			},
			{
				kind: "number",
				value: "0xFF",
				number: 255,
				range: spanAt(text, text.indexOf("0xFF"), "0xFF"),
			},
			{
				kind: "number",
				value: "-1",
				number: -1,
				range: spanAt(text, text.indexOf("-1"), "-1"),
			},
		]);
		expect(facts.literals.some((literal) => literal.value === "module docs")).toBe(false);
		expect(facts.literals.some((literal) => literal.value === "function docs")).toBe(false);
		expect(facts.literals.some((literal) => literal.value === "bytes")).toBe(false);
		expect(facts.literals.some((literal) => literal.value === "value ")).toBe(false);
		expect(facts.literals.some((literal) => literal.value === "None")).toBe(false);
		expect(facts.literals.some((literal) => literal.value === "1j")).toBe(false);
	});

	it("reports UTF-16 ranges for declarations, references, imports, attributes, and literals", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			'X = "😀"; DECL = 1',
			'X = "😀"; VALUE = X',
			'X = "😀"; import os as alias',
			'X = "😀"; from item import thing as alias2',
			'X = "😀"; LIT = "target"',
			'X = "😀"; obj.attr',
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		const declaration = facts.declarations.find((candidate) => candidate.name === "DECL");
		if (declaration === undefined) throw new Error("DECL declaration missing");
		expect(declaration.range).toEqual({
			start: { line: 0, character: 10 },
			end: { line: 0, character: 18 },
		});
		expect(declaration.selectionRange).toEqual({
			start: { line: 0, character: 10 },
			end: { line: 0, character: 14 },
		});

		expect(
			facts.references.find(
				(reference) => reference.name === "X" && reference.role === "read" && reference.range.start.line === 1,
			),
		).toMatchObject({
			range: { start: { line: 1, character: 18 }, end: { line: 1, character: 19 } },
		});
		expect(
			facts.references.find((reference) => reference.name === "attr" && reference.range.start.line === 5),
		).toMatchObject({
			range: { start: { line: 5, character: 14 }, end: { line: 5, character: 18 } },
		});

		expect(facts.imports).toContainEqual({
			specifier: "os",
			imported: [
				{ local: "alias", localRange: { start: { line: 2, character: 23 }, end: { line: 2, character: 28 } } },
			],
			reExport: false,
		});
		expect(facts.imports).toContainEqual({
			specifier: "item",
			imported: [
				{
					name: "thing",
					range: { start: { line: 3, character: 27 }, end: { line: 3, character: 32 } },
					local: "alias2",
					localRange: { start: { line: 3, character: 36 }, end: { line: 3, character: 42 } },
				},
			],
			reExport: false,
		});
		expect(facts.literals.find((literal) => literal.value === "target")).toMatchObject({
			range: { start: { line: 4, character: 16 }, end: { line: 4, character: 24 } },
		});
	});

	it("emits every Python comment form verbatim and leaves docstrings alone", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		const info = provider.initialize(root);
		const text = [
			"#!/usr/bin/env python3",
			"# -*- coding: utf-8 -*-",
			"# leading",
			"def work(",
			"    first,",
			"    # inline",
			"    second,",
			"):",
			'    """docs"""',
			"    return first + second",
			"",
			"",
			"total = 42  # trailing",
			"",
			"#",
			"# standalone",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(info.tiers.comments).toBe(true);
		expect(facts.comments).toEqual([
			{ text: "#!/usr/bin/env python3", range: spanAt(text, text.indexOf("#!"), "#!/usr/bin/env python3") },
			{ text: "# -*- coding: utf-8 -*-", range: spanAt(text, text.indexOf("# -*-"), "# -*- coding: utf-8 -*-") },
			{ text: "# leading", range: spanAt(text, text.indexOf("# leading"), "# leading") },
			{ text: "# inline", range: spanAt(text, text.indexOf("# inline"), "# inline") },
			{ text: "# trailing", range: spanAt(text, text.indexOf("# trailing"), "# trailing") },
			{ text: "#", range: spanAt(text, text.indexOf("\n#\n") + 1, "#") },
			{ text: "# standalone", range: spanAt(text, text.indexOf("# standalone"), "# standalone") },
		]);
		const declaration = facts.declarations.find((candidate) => candidate.name === "work");
		expect(declaration?.range).toEqual({
			start: { line: 3, character: 0 },
			end: { line: 9, character: 25 },
		});
	});

	it("never reports a hash inside a string as a comment", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			'url = "https://example.com/path"',
			"hashed = '# not a comment'",
			'block = """',
			"# still not a comment",
			'"""',
			'formatted = f"{url}# not a comment either"',
			"# real",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(facts.comments).toEqual([{ text: "# real", range: spanAt(text, text.indexOf("# real"), "# real") }]);
	});

	it("measures comment columns in UTF-16 code units", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ['X = "😀"  # tail', "# 😀 lead", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(facts.comments).toEqual([
			{ text: "# tail", range: { start: { line: 0, character: 10 }, end: { line: 0, character: 16 } } },
			{ text: "# 😀 lead", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } } },
		]);
	});

	it("reports comments from text the parser rejects", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["# kept", "def add(:", "    pass", "# also kept", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(facts.declarations).toEqual([]);
		expect(facts.comments.map((comment) => comment.text)).toEqual(["# kept", "# also kept"]);
		expect(facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});

	it("keeps the comments read before an unterminated string, which Python has instead of blocks", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["# before", 'value = """opened and never closed', "# inside the string", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });

		expect(facts.comments).toEqual([
			{ text: "# before", range: spanAt(text, text.indexOf("# before"), "# before") },
		]);
		expect(facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});

	it("reports declaration metrics with explicit parameter and branch rules", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		const info = provider.initialize(root);
		const text = [
			"def calculate(self, *args, enabled=True, **kwargs):",
			"    if enabled:",
			"        for item in args:",
			"            if item:",
			"                return 1",
			"    return 0",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const declaration = facts.declarations.find((candidate) => candidate.name === "calculate");
		if (declaration === undefined) throw new Error("calculate declaration missing");

		expect(info.tiers.metrics).toBe(true);
		expect(declaration.metrics).toEqual({ lines: 6, parameters: 4, nesting: 3, branches: 4 });
	});

	it("binds relative imports and aliases to declarations in another module", () => {
		const root = workspace({
			"src/item.py": "class Item:\n    pass\n",
			"src/other.py": "class Other:\n    pass\n",
		});
		const provider = new PythonProvider();
		provider.initialize(root);
		const itemFacts = provider.parseFile({
			module: "src/item.py",
			contentHash: "item",
			text: "class Item:\n    pass\n",
		});
		const otherFacts = provider.parseFile({
			module: "src/other.py",
			contentHash: "other",
			text: "class Other:\n    pass\n",
		});
		const item = itemFacts.declarations.find((declaration) => declaration.name === "Item");
		const other = otherFacts.declarations.find((declaration) => declaration.name === "Other");
		if (item === undefined || other === undefined) throw new Error("import declaration missing");
		const cart = provider.parseFile({
			module: "src/cart.py",
			contentHash: "cart",
			text: [
				"from .item import Item",
				"from .other import Other as Alias",
				"def make():",
				"    return Item(), Alias()",
			].join("\n"),
		});

		expect(
			cart.references.find((reference) => reference.name === "Item" && reference.role === "call")?.binding,
		).toEqual({
			status: "bound",
			symbolId: item.symbolId,
			provenance: "bound",
		});
		expect(
			cart.references.find((reference) => reference.name === "Alias" && reference.role === "call")?.binding,
		).toEqual({
			status: "bound",
			symbolId: other.symbolId,
			provenance: "bound",
		});
	});

	it("returns parseable edits for declarations and reads", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = "def old():\n    return old\n";
		const declaration = spanAt(text, text.indexOf("old"), "old");
		const reference = spanAt(text, text.lastIndexOf("old"), "old");
		const response = provider.renameEdits({
			module: "main.py",
			text,
			oldName: "old",
			newName: "new",
			sites: [{ range: declaration }, { range: reference }],
		});
		expect(response).toEqual({
			status: "ready",
			edits: [
				{ range: declaration, newText: "new" },
				{ range: reference, newText: "new" },
			],
			blocked: [],
		});
		if (response.status !== "ready") throw new Error("rename was refused");
		const rewritten = applyEdits(text, response.edits);
		if ("problem" in rewritten) throw new Error(rewritten.problem);
		const reparsed = provider.parseFile({ module: "main.py", contentHash: "rewritten", text: rewritten.text });
		expect(reparsed.diagnostics).toEqual([]);
	});

	it("applies rename sites using UTF-16 ranges", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = 'prefix = "😀"; old = 1\n';
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const declaration = facts.declarations.find((candidate) => candidate.name === "old");
		if (declaration === undefined) throw new Error("old declaration missing");
		if (declaration.selectionRange === undefined) throw new Error("declaration selection range missing");

		const response = provider.renameEdits({
			module: "main.py",
			text,
			oldName: "old",
			newName: "new",
			sites: [{ range: declaration.selectionRange as NonNullable<typeof declaration.selectionRange> }],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [{ range: declaration.selectionRange, newText: "new" }],
			blocked: [],
		});
	});

	it("rewrites static __all__ strings without touching the declaration", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = '__all__ = ["old"]\ndef old():\n    pass\n';
		const site = spanAt(text, text.indexOf('"old"'), '"old"');
		const response = provider.renameEdits({
			module: "main.py",
			text,
			oldName: "old",
			newName: "new",
			sites: [{ range: site }],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [{ range: spanAt(text, text.indexOf('"old"'), '"old"'), newText: "'new'" }],
			blocked: [],
		});
		if (response.status !== "ready") throw new Error("rename was refused");
		const rewritten = applyEdits(text, response.edits);
		if ("problem" in rewritten) throw new Error(rewritten.problem);
		expect(rewritten.text).toContain("__all__ = ['new']");
	});

	it("refuses parameter renames and collisions", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const parameterText = "def run(old):\n    return old\nrun(old=1)\n";
		expect(
			provider.renameEdits({
				module: "main.py",
				text: parameterText,
				oldName: "old",
				newName: "new",
				sites: [{ range: spanAt(parameterText, parameterText.indexOf("old"), "old") }],
			}),
		).toMatchObject({ status: "refused", reason: "NotImplemented" });

		const collisionText = "def old():\n    pass\ndef new():\n    pass\n";
		expect(
			provider.renameEdits({
				module: "main.py",
				text: collisionText,
				oldName: "old",
				newName: "new",
				sites: [{ range: spanAt(collisionText, collisionText.indexOf("old"), "old") }],
			}),
		).toMatchObject({ status: "refused", reason: "Collision" });
	});

	it("rewrites named owner calls and leaves positional or unrelated calls alone", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def run(old):", "    return old", "run(old=1)", "run(2)", "other(old=3)"].join("\n");
		const parameter = spanAt(text, text.indexOf("old"), "old");
		const namedCall = spanAt(text, text.indexOf("run(old=1)"), "run");
		const positionalCall = spanAt(text, text.indexOf("run(2)"), "run");
		const response = provider.renameEdits({
			module: "main.py",
			text,
			oldName: "old",
			newName: "new",
			sites: [{ range: parameter }],
			ownerCalls: [namedCall, positionalCall],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [
				{ range: parameter, newText: "new" },
				{ range: spanAt(text, text.indexOf("old=1"), "old"), newText: "new" },
			],
			blocked: [],
		});
		if (response.status !== "ready") throw new Error("rename was refused");
		const rewritten = applyEdits(text, response.edits);
		if ("problem" in rewritten) throw new Error(rewritten.problem);
		expect(rewritten.text).toContain("run(new=1)");
		expect(rewritten.text).toContain("run(2)");
		expect(rewritten.text).toContain("other(old=3)");
	});

	it("rewrites owner calls in a file with no parameter sites", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["run(old=1)", "run(2)", "other(old=3)"].join("\n");
		const namedCall = spanAt(text, text.indexOf("run(old=1)"), "run");
		const positionalCall = spanAt(text, text.indexOf("run(2)"), "run");
		const response = provider.renameEdits({
			module: "uses.py",
			text,
			oldName: "old",
			newName: "new",
			sites: [],
			ownerCalls: [namedCall, positionalCall],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [{ range: spanAt(text, text.indexOf("old=1"), "old"), newText: "new" }],
			blocked: [],
		});
	});

	it("blocks owner calls with dynamic keyword forwarding", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def run(old):", "    return old", "values = {}", "run(**values)"].join("\n");
		const parameter = spanAt(text, text.indexOf("old"), "old");
		const ownerCall = spanAt(text, text.indexOf("run(**values)"), "run");
		const response = provider.renameEdits({
			module: "main.py",
			text,
			oldName: "old",
			newName: "new",
			sites: [{ range: parameter }],
			ownerCalls: [ownerCall],
		});

		expect(response).toMatchObject({
			status: "ready",
			edits: [{ range: parameter, newText: "new" }],
			blocked: [
				{
					range: ownerCall,
					reason: "NotImplemented",
					detail: "the call forwards keyword names through **kwargs",
				},
			],
		});
	});

	it("does not block dynamic keywords for positional-only parameters", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def run(old, /):", "    return old", "values = {}", "run(**values)"].join("\n");
		const parameter = spanAt(text, text.indexOf("old"), "old");
		const ownerCall = spanAt(text, text.indexOf("run(**values)"), "run");
		const response = provider.renameEdits({
			module: "main.py",
			text,
			oldName: "old",
			newName: "new",
			sites: [{ range: parameter }],
			ownerCalls: [ownerCall],
		});

		expect(response).toEqual({
			status: "ready",
			edits: [{ range: parameter, newText: "new" }],
			blocked: [],
		});
	});

	it("blocks string, attribute, and dynamic scope sites", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const cases = [
			{
				text: 'value: "old"\n',
				reason: "StringLiteral",
			},
			{
				text: "obj.old\n",
				reason: "NotImplemented",
			},
			{
				text: 'def run():\n    exec("x=1")\n    return old\n',
				reason: "NotImplemented",
			},
		] as const;

		for (const testCase of cases) {
			const index = testCase.text.lastIndexOf("old");
			const response = provider.renameEdits({
				module: "main.py",
				text: testCase.text,
				oldName: "old",
				newName: "new",
				sites: [{ range: spanAt(testCase.text, index, "old") }],
			});
			expect(response).toMatchObject({
				status: "ready",
				edits: [],
				blocked: [{ reason: testCase.reason }],
			});
		}
	});

	it("keeps star and conditional imports unbound and binds parameter shadowing", () => {
		const root = workspace({ "src/item.py": "class Item:\n    pass\n" });
		const provider = new PythonProvider();
		provider.initialize(root);
		const cases = [
			{
				module: "src/star.py",
				text: ["from .item import *", "def make():", "    return Item()"].join("\n"),
				name: "star",
				reason: "Ambiguous",
			},
			{
				module: "src/conditional.py",
				text: ["if enabled:", "    from .item import Item", "def make():", "    return Item()"].join("\n"),
				name: "conditional",
				reason: "Ambiguous",
			},
		] as const;

		for (const testCase of cases) {
			const facts = provider.parseFile({
				module: testCase.module,
				contentHash: testCase.name,
				text: testCase.text,
			});
			expect(
				facts.references.find((reference) => reference.name === "Item" && reference.role === "call")?.binding,
			).toMatchObject({
				status: "unbound",
				reason: testCase.reason,
			});
		}

		const shadowText = ["from .item import Item", "def make(Item):", "    return Item()"].join("\n");
		const shadowFacts = provider.parseFile({ module: "src/shadow.py", contentHash: "shadow", text: shadowText });
		const shadowReference = shadowFacts.references.find(
			(reference) => reference.name === "Item" && reference.role === "call",
		);
		const shadowParameter = shadowFacts.declarations.find(
			(declaration) => declaration.name === "Item" && declaration.visibility === "local",
		);
		expect(shadowReference?.binding).toMatchObject({ status: "bound", symbolId: shadowParameter?.symbolId });
	});

	it("refreshes cross-file bindings when the target is reparsed", () => {
		const root = workspace({ "src/item.py": "class Item:\n    pass\n" });
		const provider = new PythonProvider();
		provider.initialize(root);
		const cartText = "from .item import Item\ndef make():\n    return Item()\n";
		const cart = provider.parseFile({ module: "src/cart.py", contentHash: "cart", text: cartText });
		const reference = cart.references.find((candidate) => candidate.name === "Item" && candidate.role === "call");
		if (reference === undefined) throw new Error("imported reference missing");
		expect(reference.binding.status).toBe("bound");

		provider.parseFile({ module: "src/item.py", contentHash: "item-2", text: "class NewItem:\n    pass\n" });

		expect(provider.bind({ module: "src/cart.py", name: "Item", range: reference.range })).toMatchObject({
			status: "unbound",
			reason: "NotIndexed",
		});
	});

	it("stops binding into a module the index forgot, and binds again once a parse is admitted", () => {
		const provider = itemWorkspace();
		admitItem(provider, "item");
		expect(makesItem(provider)).toBe("bound");

		provider.forgetModule({ module: "src/item.py" });
		expect(makesItem(provider)).toBe("unbound");

		admitItem(provider, "item-2");
		expect(makesItem(provider)).toBe("bound");
	});

	it("holds nothing for a module whose first parse the index refused", () => {
		const provider = itemWorkspace();
		provider.parseFile({ module: "src/item.py", contentHash: "item", text: ITEM });
		provider.moduleAdmission({
			module: "src/item.py",
			contentHash: "item",
			outcome: { status: "refused", reason: "an id the index could not read" },
		});

		expect(makesItem(provider)).toBe("unbound");
	});

	it("lets a new workspace fill a module the previous one withheld", () => {
		const root = workspace({ "src/item.py": ITEM });
		const provider = new PythonProvider();
		provider.initialize(root);
		provider.forgetModule({ module: "src/item.py" });
		expect(makesItem(provider)).toBe("unbound");

		provider.initialize(root);

		expect(makesItem(provider)).toBe("bound");
	});

	it("binds direct bases and annotation names but refuses receiver lookup", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: [
				"class Base:",
				"    pass",
				"class Child(Base):",
				"    def run(self, value: Base) -> Base:",
				"        return self.helper(value)",
			].join("\n"),
		});

		const base = facts.declarations.find((declaration) => declaration.name === "Base")?.symbolId;
		expect(facts.references.filter((reference) => reference.name === "Base")).toEqual([
			expect.objectContaining({
				role: "extends",
				binding: { status: "bound", symbolId: base, provenance: "bound" },
			}),
			expect.objectContaining({
				role: "typeUse",
				binding: { status: "bound", symbolId: base, provenance: "bound" },
			}),
			expect.objectContaining({
				role: "typeUse",
				binding: { status: "bound", symbolId: base, provenance: "bound" },
			}),
		]);
		expect(facts.references.find((reference) => reference.name === "helper")?.binding).toMatchObject({
			status: "unbound",
			reason: "Ambiguous",
		});
	});

	it("writes every signature use in the declaration it heads", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: [
				"LIMIT = 1",
				"class Base:",
				"    pass",
				"def deco(f):",
				"    return f",
				"@deco",
				"class Holder(Base):",
				"    @deco",
				"    def method(self, x: Base = LIMIT) -> Base:",
				"        return x",
				"@deco",
				"def free(y: Base = LIMIT) -> Base:",
				"    return y",
			].join("\n"),
		});

		expect(writtenIn(facts)).toEqual([
			"LIMIT in module",
			"f in deco",
			"deco in Holder",
			"Base in Holder",
			"deco in Holder.method",
			"Base in Holder.method",
			"LIMIT in Holder.method",
			"Base in Holder.method",
			"x in Holder.method",
			"deco in free",
			"Base in free",
			"LIMIT in free",
			"Base in free",
			"y in free",
		]);
	});

	it("resolves a signature use outside the declaration it is written in", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: ["value = 3", "def g(value=value):", "    return value"].join("\n"),
		});

		const dflt = facts.references.find(
			(reference) => reference.name === "value" && reference.range.start.line === 1,
		);

		expect(dflt?.binding).toEqual({
			status: "bound",
			symbolId: composeSymbolId({
				language: "python",
				module: "main.py",
				descriptors: [{ kind: "term", name: "value" }],
			}),
			provenance: "bound",
		});
		expect(ownerOf(dflt)).toBe("g");
	});

	it("keeps a nested header in its own declaration and a lambda default in the header around it", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: [
				"LIMIT = 1",
				"class Outer:",
				"    class Inner:",
				"        def method(self, cb=lambda v=LIMIT: v):",
				"            return cb",
				"def outer():",
				"    def inner(x=LIMIT):",
				"        return x",
			].join("\n"),
		});

		expect(writtenIn(facts).filter((entry) => entry.startsWith("LIMIT"))).toEqual([
			"LIMIT in module",
			"LIMIT in Outer.Inner.method",
			"LIMIT in outer.inner",
		]);
	});

	it("writes a type parameter's bound and constraints in the declaration it heads", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: [
				"class Bound:",
				"    pass",
				"class Other:",
				"    pass",
				"class Typed[T: Bound]:",
				"    def method[M: Other](self, value: M) -> M:",
				"        return value",
				"def sign[U: (Bound, Other)](value: U) -> U:",
				"    return value",
				"type Alias[A: Bound] = list[A]",
			].join("\n"),
		});
		const ordered = [...facts.references].sort((left, right) =>
			comparePositions(left.range.start, right.range.start),
		);

		const bounds = ordered.filter((reference) => reference.name === "Bound" || reference.name === "Other");
		expect(
			bounds.map(
				(reference) =>
					`${reference.role} ${reference.name} in ${ownerOf(reference)} -> ${reference.binding.status}`,
			),
		).toEqual([
			"typeUse Bound in Typed -> bound",
			"typeUse Other in Typed.method -> bound",
			"typeUse Bound in sign -> bound",
			"typeUse Other in sign -> bound",
			"typeUse Bound in Alias -> bound",
		]);
		const alias = ordered.filter((reference) => reference.range.start.line === 9);
		expect(alias.map((reference) => `${reference.role} ${reference.name}`)).toEqual([
			"typeUse Bound",
			"typeUse list",
			"typeUse A",
		]);
	});

	// Defaults need Python 3.13.
	const pythonVersion = new Python3Dispatch().runJson<number[]>([
		"-c",
		"import json, sys; print(json.dumps(list(sys.version_info[:2])))",
	]) ?? [0, 0];
	const major = pythonVersion[0] ?? 0;
	const minor = pythonVersion[1] ?? 0;
	const typeParameterDefaults = major > 3 || (major === 3 && minor >= 13);

	it.skipIf(!typeParameterDefaults)("writes a type parameter's default in the declaration it heads", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: [
				"class Bound:",
				"    pass",
				"class Default(Bound):",
				"    pass",
				"class Box[T: Bound = Default]:",
				"    pass",
				"def wrap[U = Default](value: U) -> U:",
				"    return value",
				"type Named[**P = [Default]] = tuple[Default]",
			].join("\n"),
		});
		const defaults = [...facts.references]
			.sort((left, right) => comparePositions(left.range.start, right.range.start))
			.filter((reference) => reference.name === "Default");

		expect(
			defaults.map((reference) => `${reference.role} in ${ownerOf(reference)} -> ${reference.binding.status}`),
		).toEqual([
			"typeUse in Box -> bound",
			"typeUse in wrap -> bound",
			"typeUse in module -> bound",
			"typeUse in module -> bound",
		]);
	});

	it("renames a class named in a type parameter bound", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"class Old:",
			"    pass",
			"class Typed[T: Old]:",
			"    pass",
			"def sign[U: (Old, int)](value: U) -> U:",
			"    return value",
			"",
		].join("\n");
		const sites = [...text.matchAll(/Old/g)].map((match) => ({ range: spanAt(text, match.index, "Old") }));
		const response = provider.renameEdits({ module: "main.py", text, oldName: "Old", newName: "New", sites });

		expect(sites).toHaveLength(3);
		expect(response).toEqual({
			status: "ready",
			edits: sites.map((site) => ({ range: site.range, newText: "New" })),
			blocked: [],
		});
	});

	it("reports a string literal inside a type parameter bound", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = 'class Typed[T: "Later"]:\n    pass\nclass Later:\n    pass\n';
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typed = facts.declarations.find((declaration) => declaration.name === "Typed");

		expect(facts.literals).toEqual([
			{
				kind: "string",
				value: "Later",
				range: spanAt(text, text.indexOf('"Later"'), '"Later"'),
				containerId: typed?.symbolId,
			},
		]);
	});

	it("declares a type parameter owned by the declaration it heads", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"def wrap[T](value: T) -> T:",
			"    return value",
			"",
			"class Box[U]:",
			"    pass",
			"",
			"def variadic[**P, *Ts](fn):",
			"    pass",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const declaration = (name: string) => facts.declarations.find((candidate) => candidate.name === name);
		const wrap = declaration("wrap");
		const box = declaration("Box");
		const t = declaration("T");
		const u = declaration("U");
		const paramSpec = declaration("P");
		const typeVarTuple = declaration("Ts");

		expect(t).toMatchObject({ kind: "typeParameter", visibility: "local", containerId: wrap?.symbolId });
		expect(u).toMatchObject({ kind: "typeParameter", visibility: "local", containerId: box?.symbolId });
		// A ParamSpec/TypeVarTuple selectionRange excludes the **/* sigil.
		expect(paramSpec?.selectionRange).toEqual(spanAt(text, text.indexOf("P,"), "P"));
		expect(typeVarTuple?.selectionRange).toEqual(spanAt(text, text.indexOf("Ts]"), "Ts"));
	});

	it("declares a type alias as its own symbol instead of writing its name", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class Item:", "    pass", "", "type Alias[T] = list[T]", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const alias = facts.declarations.find((declaration) => declaration.name === "Alias");
		const typeParameter = facts.declarations.find((declaration) => declaration.name === "T");

		expect(alias).toMatchObject({ kind: "interface", visibility: "public" });
		expect(typeParameter).toMatchObject({ kind: "typeParameter", containerId: alias?.symbolId });
		expect(facts.references.some((reference) => reference.name === "Alias")).toBe(false);
	});

	it("binds a typeUse reference to a variable, a function, or an alias, not only a class", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"def factory():",
			"    return None",
			"",
			"Number = int",
			"",
			"type FromFunction = factory",
			"type FromVariable = Number",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const declaration = (name: string) => {
			const found = facts.declarations.find((candidate) => candidate.name === name);
			if (found === undefined) throw new Error(`${name} declaration missing`);
			return found;
		};
		const typeUses = facts.references.filter((reference) => reference.role === "typeUse");

		expect(typeUses.find((reference) => reference.name === "factory")?.binding).toEqual({
			status: "bound",
			symbolId: declaration("factory").symbolId,
			provenance: "bound",
		});
		expect(typeUses.find((reference) => reference.name === "Number")?.binding).toEqual({
			status: "bound",
			symbolId: declaration("Number").symbolId,
			provenance: "bound",
		});
	});

	it("renames a type parameter across its bound and every annotation", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def wrap[T](value: T) -> T:", "    return value", ""].join("\n");
		const sites = [...text.matchAll(/\bT\b/g)].map((match) => ({ range: spanAt(text, match.index, "T") }));
		const response = provider.renameEdits({ module: "main.py", text, oldName: "T", newName: "TRenamed", sites });

		expect(sites).toHaveLength(3);
		expect(response).toEqual({
			status: "ready",
			edits: sites.map((site) => ({ range: site.range, newText: "TRenamed" })),
			blocked: [],
		});
	});

	it("renames a type alias's own name", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = "type Alias = int\n";
		const range = spanAt(text, text.indexOf("Alias"), "Alias");
		const sites = [{ range }];
		const response = provider.renameEdits({
			module: "main.py",
			text,
			oldName: "Alias",
			newName: "Renamed",
			sites,
		});

		expect(response).toEqual({
			status: "ready",
			edits: [{ range, newText: "Renamed" }],
			blocked: [],
		});
	});

	it("keeps a call's arguments inside a type expression as ordinary reads", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"def StringProperty(update=None):",
			"    return None",
			"",
			"",
			"def update_export_path():",
			"    pass",
			"",
			"",
			"class C:",
			"    path: StringProperty(update=update_export_path)",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const callback = declarationNamed(facts, "update_export_path");
		const argument = facts.references.find((reference) => reference.name === "update_export_path");

		expect(argument?.role).toBe("read");
		expect(argument?.binding).toEqual({ status: "bound", symbolId: callback.symbolId, provenance: "bound" });
	});

	it("binds a class base's subscript operand to the class's own type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = "class Box[T](list[T]):\n    pass\n";
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const operand = facts.references.find((reference) => reference.role === "typeUse" && reference.name === "T");
		const head = facts.references.find((reference) => reference.role === "extends");

		expect(head?.name).toBe("list");
		expect(operand?.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
	});

	it("reads an enclosing class's type parameter from a method body", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class C[T]:", "    def m(self):", "        return T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
	});

	it("resolves a class-body local over the class's own type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class C[T]:", "    T = 1", "    x = T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const local = declarationWhere(
			facts,
			(declaration) => declaration.name === "T" && declaration.kind !== "typeParameter",
		);
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: local.symbolId, provenance: "bound" });
	});

	it("resolves a method-local over the enclosing class's type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class C[T]:", "    def m(self):", "        T = 2", "        return T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const use = facts.references.find(
			(reference) => reference.name === "T" && reference.role === "read" && reference.range.start.line === 3,
		);

		expect(use?.binding).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "local, parameter, or imported binding is not indexed",
		});
	});

	it("resolves a parameter over the enclosing class's type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class C[T]:", "    def m(self, T):", "        return T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const parameter = declarationWhere(
			facts,
			(declaration) => declaration.name === "T" && declaration.kind === "variable",
		);
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: parameter.symbolId, provenance: "bound" });
	});

	it("resolves a method's own type parameter over the enclosing class's", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class C[T]:", "    def m[T](self):", "        return T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const method = declarationNamed(facts, "m");
		const methodTypeParameter = declarationWhere(
			facts,
			(declaration) => declaration.name === "T" && declaration.containerId === method.symbolId,
		);
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: methodTypeParameter.symbolId, provenance: "bound" });
	});

	it("reads an outer generic class's type parameter through a nested generic class", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"class Outer[T]:",
			"    class Inner[U]:",
			"        def m(self):",
			"            return T",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const outer = declarationNamed(facts, "Outer");
		const outerTypeParameter = declarationWhere(
			facts,
			(declaration) => declaration.name === "T" && declaration.containerId === outer.symbolId,
		);
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: outerTypeParameter.symbolId, provenance: "bound" });
	});

	it("reads a generic function's type parameter from inside a comprehension", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f[T]():", "    return [T for _ in range(1)]", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
	});

	it("reads a generic function's type parameter from inside a lambda", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f[T]():", "    return (lambda: T)()", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
	});

	it("resolves a comprehension's own target over the enclosing method's type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class C[T]:", "    def m(self, xs):", "        return [T for T in xs]", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "comprehension scope is not indexed",
		});
	});

	it("reads the enclosing method's type parameter from a comprehension that does not bind it", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["class C[T]:", "    def m(self, xs):", "        return [T for x in xs]", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
	});

	it("resolves a lambda's own parameter over the enclosing function's type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f[T]():", "    return (lambda T: T)(1)", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "lambda scope is not indexed",
		});
	});

	it("reads the enclosing function's type parameter from a lambda that does not bind it", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f[T]():", "    return (lambda x: T)(1)", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
	});

	it("reads a generic method's own class parameter from both a comprehension and a lambda", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"class C[T]:",
			"    def m(self, xs):",
			"        comp = [T for x in xs]",
			"        fn = (lambda: T)()",
			"        return comp, fn",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const uses = facts.references.filter((reference) => reference.name === "T" && reference.role === "read");

		expect(uses).toHaveLength(2);
		for (const use of uses) {
			expect(use.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
		}
	});

	it("refuses a nonlocal name access to an enclosing declaration's type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f[T]():", "    def g():", "        nonlocal T", "        return T", "    return g", ""].join(
			"\n",
		);
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "the nonlocal target is not indexed",
		});
	});

	it("resolves a class's own type parameter over a module-level global of the same name", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["T = 'module value'", "", "", "class C[T]:", "    def m(self):", "        return T", ""].join(
			"\n",
		);
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const classTypeParameter = declarationWhere(
			facts,
			(declaration) => declaration.name === "T" && declaration.kind === "typeParameter",
		);
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: classTypeParameter.symbolId, provenance: "bound" });
	});

	it("resolves a function's own type parameter over a module-level global of the same name", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["T = 'module value'", "", "", "def f[T]():", "    return T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const functionTypeParameter = declarationWhere(
			facts,
			(declaration) => declaration.name === "T" && declaration.kind === "typeParameter",
		);
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({
			status: "bound",
			symbolId: functionTypeParameter.symbolId,
			provenance: "bound",
		});
	});

	it("reads both a nested generic class's own type parameter and the outer class's", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"class Outer[T]:",
			"    class Inner[U]:",
			"        def m(self):",
			"            return T, U",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const outer = declarationNamed(facts, "Outer");
		const inner = declarationNamed(facts, "Inner");
		const outerTypeParameter = declarationWhere(
			facts,
			(declaration) => declaration.name === "T" && declaration.containerId === outer.symbolId,
		);
		const innerTypeParameter = declarationWhere(
			facts,
			(declaration) => declaration.name === "U" && declaration.containerId === inner.symbolId,
		);
		const readT = facts.references.find((reference) => reference.name === "T" && reference.role === "read");
		const readU = facts.references.find((reference) => reference.name === "U" && reference.role === "read");

		expect(readT?.binding).toEqual({ status: "bound", symbolId: outerTypeParameter.symbolId, provenance: "bound" });
		expect(readU?.binding).toEqual({ status: "bound", symbolId: innerTypeParameter.symbolId, provenance: "bound" });
	});

	it("binds a plain return of a generic function's type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f[T]():", "    return T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeParameter = declarationNamed(facts, "T");
		const use = facts.references.find((reference) => reference.name === "T" && reference.role === "read");

		expect(use?.binding).toEqual({ status: "bound", symbolId: typeParameter.symbolId, provenance: "bound" });
	});

	it("resolves a plain assignment over a generic function's own type parameter", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = ["def f[T]():", "    T = 3", "    return T", ""].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const use = facts.references.find(
			(reference) => reference.name === "T" && reference.role === "read" && reference.range.start.line === 2,
		);

		expect(use?.binding).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "local, parameter, or imported binding is not indexed",
		});
	});

	it("keeps every name in Callable, Literal, Union, a forward reference, a union, tuple, and a nested generic as typeUse", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"class A:",
			"    pass",
			"",
			"",
			"class B:",
			"    pass",
			"",
			"",
			"def f[T](",
			"    callable_shape: Callable[[int], str],",
			'    literal_shape: Literal["a"],',
			"    union_shape: Union[A, B],",
			'    forward_shape: "A",',
			"    optional_shape: A | None,",
			"    tuple_shape: tuple[int, ...],",
			"    dict_shape: dict[str, list[T]],",
			"):",
			"    pass",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const ordered = [...facts.references].sort((left, right) =>
			comparePositions(left.range.start, right.range.start),
		);

		expect(ordered.every((reference) => reference.role === "typeUse")).toBe(true);
		expect(ordered.map((reference) => `${reference.name} ${reference.binding.status}`)).toEqual([
			"Callable unbound",
			"int unbound",
			"str unbound",
			"Literal unbound",
			"Union unbound",
			"A bound",
			"B bound",
			"A bound",
			"tuple unbound",
			"int unbound",
			"dict unbound",
			"str unbound",
			"list unbound",
			"T bound",
		]);
	});

	it("binds an imported type alias, an imported TypeVar variable, and an imported function as typeUse", () => {
		const root = workspace({
			"src/shared.py": [
				"from typing import TypeVar",
				"",
				"",
				"type Alias = int",
				'_T = TypeVar("_T")',
				"",
				"",
				"def factory():",
				"    return None",
				"",
			].join("\n"),
		});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"from .shared import Alias, _T, factory",
			"",
			"type FromAlias = Alias",
			"type FromTypeVar = _T",
			"type FromFunction = factory",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "src/main.py", contentHash: "hash", text });
		const typeUses = facts.references.filter((reference) => reference.role === "typeUse");

		expect(typeUses.find((reference) => reference.name === "Alias")?.binding.status).toBe("bound");
		expect(typeUses.find((reference) => reference.name === "_T")?.binding.status).toBe("bound");
		expect(typeUses.find((reference) => reference.name === "factory")?.binding.status).toBe("bound");
	});

	it("refuses to rename a type parameter onto its sibling", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);

		const functionText = "def f[T, U](x: T, y: U) -> T:\n    return x\n";
		const functionSites = [...functionText.matchAll(/\bT\b/g)].map((match) => ({
			range: spanAt(functionText, match.index, "T"),
		}));
		expect(
			provider.renameEdits({
				module: "main.py",
				text: functionText,
				oldName: "T",
				newName: "U",
				sites: functionSites,
			}),
		).toMatchObject({ status: "refused", reason: "Collision" });

		const classText = "class C[T, U]:\n    pass\n";
		const classSites = [{ range: spanAt(classText, classText.indexOf("T"), "T") }];
		expect(
			provider.renameEdits({ module: "main.py", text: classText, oldName: "T", newName: "U", sites: classSites }),
		).toMatchObject({ status: "refused", reason: "Collision" });

		const aliasText = "type A[T, U] = dict[T, U]\n";
		const aliasSites = [...aliasText.matchAll(/\bT\b/g)].map((match) => ({
			range: spanAt(aliasText, match.index, "T"),
		}));
		expect(
			provider.renameEdits({ module: "main.py", text: aliasText, oldName: "T", newName: "U", sites: aliasSites }),
		).toMatchObject({ status: "refused", reason: "Collision" });
	});

	it("keeps the same-file typeUse kind filter for an imported name", () => {
		const root = workspace({
			"src/values.py": [
				"from typing import Final",
				"",
				"",
				"class Thing:",
				"    pass",
				"",
				"",
				"LOCKED: Final = int",
				"",
			].join("\n"),
		});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"from .values import Thing, LOCKED",
			"",
			"type FromClass = Thing",
			"type FromConstant = LOCKED",
			"",
		].join("\n");
		const facts = provider.parseFile({ module: "src/main.py", contentHash: "hash", text });
		const thingUse = facts.references.find(
			(reference) => reference.role === "typeUse" && reference.name === "Thing",
		);
		const lockedUse = facts.references.find(
			(reference) => reference.role === "typeUse" && reference.name === "LOCKED",
		);

		expect(thingUse?.binding.status).toBe("bound");
		expect(lockedUse?.binding).toEqual({
			status: "unbound",
			reason: "NotIndexed",
			detail: "the imported declaration is not indexed",
		});
	});

	it("reports explicit annotation text and infers simple initializers", () => {
		const text = [
			"from typing import Final, Optional",
			"LIMIT: Final[int] = 1",
			"unassigned: dict[str, int]",
			"def render(value: Optional[str]) -> str:",
			'    return value or ""',
			'forward: "Node"',
			"inferred = 1",
		].join("\n");
		const root = workspace({});
		const provider = new PythonProvider();
		const info = provider.initialize(root);
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeOf = (name: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.name === name);
			if (declaration === undefined) throw new Error(`${name} declaration missing`);
			return provider.typeOf({ symbolId: declaration.symbolId });
		};

		expect(info.tiers.types).toBe(true);
		expect(typeOf("LIMIT")).toEqual({
			status: "known",
			display: "Final[int]",
			provenance: "declared",
		});
		expect(typeOf("unassigned")).toEqual({
			status: "known",
			display: "dict[str, int]",
			provenance: "declared",
		});
		expect(typeOf("render")).toEqual({ status: "known", display: "str", provenance: "declared" });
		expect(provider.typeOf({ module: "main.py", range: rangeAt(text, text.indexOf("value")) })).toEqual({
			status: "known",
			display: "Optional[str]",
			provenance: "declared",
		});
		expect(typeOf("forward")).toEqual({
			status: "unknown",
			reason: "NotImplemented",
			detail: "string forward references are not resolved",
		});
		expect(typeOf("inferred")).toEqual({
			status: "inferred",
			display: "Literal[1]",
			basis: "initializer",
		});
	});

	it("links named annotation and initializer types to indexed declarations", () => {
		const root = workspace({ "src/item.py": "class Item:\n    pass\n" });
		const provider = new PythonProvider();
		provider.initialize(root);
		const itemFacts = provider.parseFile({
			module: "src/item.py",
			contentHash: "item",
			text: "class Item:\n    pass\n",
		});
		const item = itemFacts.declarations.find((declaration) => declaration.name === "Item");
		if (item === undefined) throw new Error("Item declaration missing");
		const text = [
			"class Local:",
			"    pass",
			"local_value: Local",
			"constructed = Local()",
			"generic: list[Local]",
			"from .item import Item",
			"external_value: Item",
		].join("\n");
		const facts = provider.parseFile({ module: "src/main.py", contentHash: "main", text });
		const declaration = (name: string) => {
			const value = facts.declarations.find((candidate) => candidate.name === name);
			if (value === undefined) throw new Error(`${name} declaration missing`);
			return value;
		};

		const local = declaration("Local");
		expect(provider.typeOf({ symbolId: declaration("local_value").symbolId })).toEqual({
			status: "known",
			display: "Local",
			symbolId: local.symbolId,
			provenance: "declared",
		});
		expect(provider.typeOf({ symbolId: declaration("constructed").symbolId })).toEqual({
			status: "inferred",
			display: "Local",
			symbolId: local.symbolId,
			basis: "initializer",
		});
		expect(provider.typeOf({ symbolId: declaration("generic").symbolId })).toEqual({
			status: "known",
			display: "list[Local]",
			provenance: "declared",
		});
		expect(provider.typeOf({ symbolId: declaration("external_value").symbolId })).toEqual({
			status: "known",
			display: "Item",
			symbolId: item.symbolId,
			provenance: "declared",
		});
	});

	it("joins literal returns and accounts for implicit None", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const text = [
			"def pick(first, second):",
			"    if first:",
			"        return 'foo'",
			"    elif second:",
			"        return 'bar'",
			"    return 'baz'",
			"def maybe(flag):",
			"    if flag:",
			"        return 'yes'",
			"def guarded(flag):",
			"    if flag:",
			"        return 'yes'",
			"    raise ValueError()",
			"def stop():",
			"    import sys",
			"    sys.exit()",
			"def partial():",
			"    return unknown_call()",
			"def recursive():",
			"    return recursive()",
			"def generated():",
			"    yield 'value'",
		].join("\n");
		const facts = provider.parseFile({ module: "main.py", contentHash: "hash", text });
		const typeOf = (name: string) => {
			const declaration = facts.declarations.find((candidate) => candidate.name === name);
			if (declaration === undefined) throw new Error(`${name} declaration missing`);
			return provider.typeOf({ symbolId: declaration.symbolId });
		};

		expect(typeOf("pick")).toEqual({
			status: "inferred",
			display: "Literal['foo', 'bar', 'baz']",
			basis: "3 return statements",
		});
		expect(typeOf("maybe")).toEqual({
			status: "inferred",
			display: "Literal['yes'] | None",
			basis: "1 return statement and implicit None",
		});
		expect(typeOf("guarded")).toEqual({
			status: "inferred",
			display: "Literal['yes']",
			basis: "1 return statement",
		});
		expect(typeOf("stop")).toEqual({
			status: "inferred",
			display: "Never",
			basis: "non-returning function",
		});
		expect(typeOf("partial")).toEqual({
			status: "unknown",
			reason: "NotImplemented",
			detail: "expression type is not inferred",
		});
		expect(typeOf("recursive")).toEqual({
			status: "unknown",
			reason: "RecursionLimit",
			detail: "recursive return inference reached its limit",
		});
		expect(typeOf("generated")).toEqual({
			status: "unknown",
			reason: "NotImplemented",
			detail: "generator return inference is not implemented",
		});
	});

	it("keeps conditional definitions ambiguous", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: ["def helper():", "    pass", "if enabled:", "    def helper():", "        pass", "helper()"].join(
				"\n",
			),
		});

		expect(
			facts.references.find((reference) => reference.name === "helper" && reference.role === "call"),
		).toMatchObject({
			binding: { status: "unbound", reason: "Ambiguous" },
		});
	});

	it("keeps comprehension bindings unbound", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: ["helper = 1", "values = [helper for helper in items]"].join("\n"),
		});

		expect(
			facts.references.filter((reference) => reference.name === "helper" && reference.range.start.line === 1),
		).toEqual([
			expect.objectContaining({
				role: "read",
				binding: expect.objectContaining({ status: "unbound", reason: "NotIndexed" }),
			}),
			expect.objectContaining({
				role: "write",
				binding: expect.objectContaining({ status: "unbound", reason: "NotIndexed" }),
			}),
		]);
	});

	it("poisons dynamic scopes with a runtime-constructed binding", () => {
		const root = workspace({});
		const provider = new PythonProvider();
		provider.initialize(root);
		const facts = provider.parseFile({
			module: "main.py",
			contentHash: "hash",
			text: ["def helper():", "    pass", "exec(code)", "helper()"].join("\n"),
		});

		expect(
			facts.references.find((reference) => reference.name === "helper" && reference.role === "call"),
		).toMatchObject({
			binding: { status: "unbound", reason: "RuntimeConstructed" },
		});
		expect(facts.references.find((reference) => reference.name === "exec")).toMatchObject({
			binding: { status: "unbound", reason: "RuntimeConstructed" },
		});
	});

	it("reports a missing workspace root as a project diagnostic", () => {
		const root = workspace({});
		rmSync(root, { recursive: true, force: true });

		const model = new PythonProvider().discoverProject(root);

		expect(model).toEqual({
			files: [],
			externalRoots: [],
			configFiles: [],
			diagnostics: [
				{
					severity: "error",
					message: `workspace root does not exist: ${root}`,
					path: root,
				},
			],
		});
	});

	it("keeps workspace, standard-library, and missing imports distinct", () => {
		const root = workspace({ "local.py": "value = 1\n" });
		const provider = new PythonProvider();
		provider.initialize(root);

		expect(provider.resolveImport({ fromModule: "main.py", specifier: "local" })).toEqual({
			status: "resolved",
			module: "local.py",
		});
		const stdlib = provider.resolveImport({ fromModule: "main.py", specifier: "ast" });
		const missing = provider.resolveImport({ fromModule: "main.py", specifier: "package_that_is_not_installed" });
		expect(stdlib).toEqual({ status: "external", packageName: "ast" });
		expect(missing).toEqual({
			status: "unresolved",
			reason: "ExternalDependency",
			detail: "package_that_is_not_installed is outside the indexed workspace",
		});
	});

	it("uses one honest answer when python3 is absent", () => {
		const executable = "python3-lexicon-provider-missing";
		const provider = new PythonProvider(new Python3Dispatch(executable));
		const facts = provider.parseFile({ module: "broken.py", contentHash: "hash", text: "value = 1\n" });
		const detail = `Executable not found in $PATH: ${executable}`;

		expect(facts).toMatchObject({
			declarations: [],
			references: [],
			imports: [],
			diagnostics: [{ severity: "error", message: detail }],
		});
		expect(provider.resolveImport({ fromModule: "main.py", specifier: "ast" })).toEqual({
			status: "unresolved",
			reason: "NotImplemented",
			detail,
		});
	});
});
