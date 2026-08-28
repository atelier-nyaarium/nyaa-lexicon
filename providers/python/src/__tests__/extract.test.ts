import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ImportedName } from "@nyaa-lexicon/protocol";
import { Python3Dispatch } from "../python3";

const EXTRACTOR = fileURLToPath(new URL("../extract.py", import.meta.url));
const python3 = new Python3Dispatch();

function extract(module: string, text: string) {
	const facts = python3.runJson<{
		declarations: { name: string; kind: string; exported: boolean; visibility: string }[];
		imports: { specifier: string; imported: ImportedName[]; reExport: boolean }[];
		literals: { kind: string; value: string; range: { start: { line: number; character: number } } }[];
		references: { name: string; role: string }[];
		diagnostics: { severity: string }[];
	}>([EXTRACTOR], { input: JSON.stringify({ module, text }) });
	if (facts === null) throw new Error(python3.unavailableDetail);
	return facts;
}

test("extracts public declarations, explicit exports, and final reassignments", () => {
	const facts = extract(
		"pkg/mod.py",
		['__all__ = ["Public", "_listed"]', "Public = 1", "Public = 2", "_hidden = 3", "_listed = 4", ""].join("\n"),
	);

	expect(facts.declarations.map((declaration) => declaration.name)).toEqual(["Public", "_hidden", "_listed"]);
	expect(facts.declarations.find((declaration) => declaration.name === "Public")).toMatchObject({
		kind: "variable",
		exported: true,
		visibility: "public",
	});
	expect(facts.declarations.find((declaration) => declaration.name === "_hidden")).toMatchObject({
		exported: false,
		visibility: "fileLocal",
	});
	expect(facts.declarations.find((declaration) => declaration.name === "_listed")).toMatchObject({
		exported: true,
		visibility: "public",
	});
});

test("classifies imported Final annotations as constants", () => {
	const facts = extract(
		"pkg/mod.py",
		[
			"from typing import Final",
			"from typing import Final as F",
			"from typing_extensions import Final as EF",
			"import typing",
			"import typing as t",
			"import typing_extensions",
			"import typing_extensions as te",
			"LIMIT: Final = 1",
			"LIMIT_TYPED: Final[int] = 2",
			"ALIAS_LIMIT: F = 3",
			"TYPED_LIMIT: typing.Final = 3",
			"TYPED_ALIAS_LIMIT: t.Final[int] = 4",
			"EXTENDED_LIMIT: typing_extensions.Final[int] = 5",
			"EXTENDED_ALIAS_LIMIT: te.Final[int] = 6",
			"EXTENDED_IMPORTED_LIMIT: EF = 7",
			"plain = 8",
		].join("\n"),
	);

	expect(facts.declarations.map((declaration) => [declaration.name, declaration.kind])).toEqual([
		["LIMIT", "constant"],
		["LIMIT_TYPED", "constant"],
		["ALIAS_LIMIT", "constant"],
		["TYPED_LIMIT", "constant"],
		["TYPED_ALIAS_LIMIT", "constant"],
		["EXTENDED_LIMIT", "constant"],
		["EXTENDED_ALIAS_LIMIT", "constant"],
		["EXTENDED_IMPORTED_LIMIT", "constant"],
		["plain", "variable"],
	]);
});

test("leaves conflicting Final bindings as variables", () => {
	const facts = extract(
		"pkg/mod.py",
		["from typing import Final", "Final = object()", "limit: Final = 1"].join("\n"),
	);

	expect(facts.declarations.find((declaration) => declaration.name === "limit")).toMatchObject({ kind: "variable" });
});

test("leaves conditionally shadowed Final bindings as variables", () => {
	const facts = extract(
		"pkg/mod.py",
		["from typing import Final", "if enabled:", "    Final = object()", "limit: Final = 1"].join("\n"),
	);

	expect(facts.declarations.find((declaration) => declaration.name === "limit")).toMatchObject({ kind: "variable" });
});

test("extracts decorators, nested declarations, relative imports, and call candidates", () => {
	const facts = extract(
		"pkg/sub/mod.py",
		[
			"from . import sibling",
			"from ..common import value as alias",
			"import bpy",
			"class Widget:",
			"    @property",
			"    def value(self):",
			"        return helper()",
			"def outer():",
			"    def inner():",
			"        return sibling()",
		].join("\n"),
	);

	expect(facts.imports).toEqual([
		{
			specifier: ".",
			imported: [
				{ name: "sibling", range: { start: { line: 0, character: 14 }, end: { line: 0, character: 21 } } },
			],
			reExport: false,
		},
		{
			specifier: "..common",
			imported: [
				{
					name: "value",
					range: { start: { line: 1, character: 21 }, end: { line: 1, character: 26 } },
					local: "alias",
					localRange: { start: { line: 1, character: 30 }, end: { line: 1, character: 35 } },
				},
			],
			reExport: false,
		},
		{
			specifier: "bpy",
			imported: [
				{ local: "bpy", localRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } } },
			],
			reExport: false,
		},
	]);
	expect(facts.declarations.map((declaration) => declaration.name)).toEqual([
		"Widget",
		"value",
		"self",
		"outer",
		"inner",
	]);
	expect(facts.references.map((reference) => [reference.name, reference.role])).toEqual([
		["property", "read"],
		["helper", "call"],
		["sibling", "call"],
	]);
});

test("classifies calls, receiver reads, writes, bases, and annotations", () => {
	const facts = extract(
		"pkg/mod.py",
		[
			"class Base:",
			"    pass",
			"class Child(Base):",
			"    def run(self, value: Input) -> Output:",
			"        count = value",
			"        count += 1",
			"        return self.helper(count)",
		].join("\n"),
	);

	expect(facts.references.map((reference) => [reference.name, reference.role])).toEqual([
		["Base", "extends"],
		["Input", "typeUse"],
		["Output", "typeUse"],
		["count", "write"],
		["value", "read"],
		["count", "read"],
		["count", "write"],
		["self", "read"],
		["helper", "call"],
		["count", "read"],
	]);
	expect(facts.references.some((reference) => reference.role === "instantiate")).toBe(false);
	expect(facts.references.some((reference) => reference.role === "implements")).toBe(false);
});

test("classifies explicit type comments without inferring types", () => {
	const facts = extract(
		"pkg/mod.py",
		["def run(value):  # type: (Input) -> Output", "    result = value  # type: Result", "    return result"].join(
			"\n",
		),
	);

	expect(
		facts.references.filter((reference) => reference.role === "typeUse").map((reference) => reference.name),
	).toEqual(["Input", "Output", "Result"]);
});

test("classifies exception and pattern captures as writes", () => {
	const facts = extract(
		"pkg/mod.py",
		[
			"try:",
			"    run()",
			"except Error as failure:",
			"    report(failure)",
			"match value:",
			"    case Point(x, y) as point:",
			"        use(point, x, y)",
		].join("\n"),
	);

	expect(
		facts.references.filter((reference) => reference.role === "write").map((reference) => reference.name),
	).toEqual(["failure", "x", "y", "point"]);
});

test("keeps imports and exports in import facts rather than duplicate references", () => {
	const facts = extract(
		"pkg/mod.py",
		['__all__ = ["thing"]', "from .other import thing", "import sibling"].join("\n"),
	);

	expect(facts.imports).toEqual([
		{
			specifier: ".other",
			imported: [
				{ name: "thing", range: { start: { line: 1, character: 19 }, end: { line: 1, character: 24 } } },
			],
			reExport: true,
		},
		{
			specifier: "sibling",
			imported: [
				{ local: "sibling", localRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 14 } } },
			],
			reExport: false,
		},
	]);
	expect(facts.references).toEqual([]);
});

test("marks only deliberate imports as re-exports", () => {
	const leaf = extract(
		"pkg/leaf.py",
		["import os", "from .item import Item", "from .other import Public", '__all__ = ["Public"]'].join("\n"),
	);
	const packageInit = extract("pkg/__init__.py", "from .item import Item\nimport os\n");

	expect(leaf.imports.map((item) => [item.specifier, item.reExport])).toEqual([
		["os", false],
		[".item", false],
		[".other", true],
	]);
	expect(packageInit.imports.map((item) => [item.specifier, item.reExport])).toEqual([
		[".item", true],
		["os", false],
	]);
});

test("emits exact import name ranges for aliases and multiline lists", () => {
	const facts = extract(
		"pkg/mod.py",
		["from .item import helper as h", "from .item import (", "    Item,", "    other as alias,", ")"].join("\n"),
	);

	expect(facts.imports).toEqual([
		{
			specifier: ".item",
			imported: [
				{
					name: "helper",
					range: { start: { line: 0, character: 18 }, end: { line: 0, character: 24 } },
					local: "h",
					localRange: { start: { line: 0, character: 28 }, end: { line: 0, character: 29 } },
				},
			],
			reExport: false,
		},
		{
			specifier: ".item",
			imported: [
				{ name: "Item", range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } } },
				{
					name: "other",
					range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } },
					local: "alias",
					localRange: { start: { line: 3, character: 13 }, end: { line: 3, character: 18 } },
				},
			],
			reExport: false,
		},
	]);
});

test("keeps star imports empty and preserves local import bindings", () => {
	const facts = extract("pkg/mod.py", "from .item import *\nimport os.path as p\nimport os\n");

	expect(facts.imports).toEqual([
		{ specifier: ".item", imported: [], reExport: false },
		{
			specifier: "os.path",
			imported: [
				{ local: "p", localRange: { start: { line: 1, character: 18 }, end: { line: 1, character: 19 } } },
			],
			reExport: false,
		},
		{
			specifier: "os",
			imported: [
				{ local: "os", localRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 9 } } },
			],
			reExport: false,
		},
	]);
});

test("keeps import specifiers out of literals while indexing string arguments", () => {
	const facts = extract(
		"pkg/mod.py",
		[
			"import os",
			"from .item import Item",
			'ordinary = "os"',
			'__import__("os")',
			'importlib.import_module("os")',
		].join("\n"),
	);

	expect(facts.imports.map((item) => item.specifier)).toEqual(["os", ".item"]);
	expect(
		facts.literals.filter((literal) => literal.value === "os").map((literal) => literal.range.start.line),
	).toEqual([2, 3, 4]);
});

test("records imports at every relative depth and nested scope", () => {
	const facts = extract(
		"pkg/sub/mod.py",
		[
			"from . import sibling",
			"from .. import parent",
			"from ...root import value",
			"try:",
			"    import optional",
			"except ImportError:",
			"    pass",
			"def load():",
			"    import os.path as path",
			"    from .inside import item",
		].join("\n"),
	);

	expect(facts.imports.map((item) => item.specifier)).toEqual([
		".",
		"..",
		"...root",
		"optional",
		"os.path",
		".inside",
	]);
});

test("keeps exact ranges for imports in conditional blocks", () => {
	const facts = extract("pkg/mod.py", "try:\n    import optional\nexcept ImportError:\n    pass\n");

	expect(facts.imports).toEqual([
		{
			specifier: "optional",
			imported: [
				{
					local: "optional",
					localRange: { start: { line: 1, character: 11 }, end: { line: 1, character: 19 } },
				},
			],
			reExport: false,
		},
	]);
});

test("accumulates literal __all__ additions", () => {
	const facts = extract("pkg/mod.py", '__all__ = ["a"]\n__all__ += ["b"]\na = 1\nb = 2\n');

	expect(facts.declarations.filter((declaration) => declaration.name === "a" || declaration.name === "b")).toEqual([
		expect.objectContaining({ name: "a", exported: true, visibility: "public" }),
		expect.objectContaining({ name: "b", exported: true, visibility: "public" }),
	]);
});

test("reports syntax errors without inventing facts", () => {
	const facts = extract("broken.py", "def broken(:\n    pass\n");

	expect(facts.declarations).toEqual([]);
	expect(facts.imports).toEqual([]);
	expect(facts.diagnostics).toHaveLength(1);
	expect(facts.diagnostics[0]?.severity).toBe("error");
});
