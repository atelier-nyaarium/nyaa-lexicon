import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdits, composeSymbolId, coordinatesOf } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
				value: "True",
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
			symbolId: itemFacts.declarations.find((declaration) => declaration.name === "Item")?.symbolId,
			provenance: "bound",
		});
		expect(
			cart.references.find((reference) => reference.name === "Alias" && reference.role === "call")?.binding,
		).toEqual({
			status: "bound",
			symbolId: otherFacts.declarations.find((declaration) => declaration.name === "Other")?.symbolId,
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
