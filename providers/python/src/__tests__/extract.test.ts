import { expect, test } from "bun:test";
import { extractFacts } from "../facts/extract";
import type { Range } from "../facts/types";

/** One-line span as [line, start column, end column]. */
function at(span: Range): [number, number, number] {
	return [span.start.line, span.start.character, span.end.character];
}

/** A one-line range. */
function on(line: number, start: number, end: number): Range {
	return { start: { line, character: start }, end: { line, character: end } };
}

async function extract(module: string, text: string) {
	return extractFacts(module, text);
}

test("recognizes guarded main in either order, nested in setup too, unless its else runs on import", async () => {
	const texts = [
		'if __name__ == "__main__":\n    pass\n',
		"if '__main__' == __name__:\n    pass\n",
		"if FEATURE:\n    if __name__ == '__main__':\n        run()\n",
		"if __name__ == '__main__':\n    run()\nelse:\n    value = 1\n",
	];
	const roles = await Promise.all(texts.map(async (text) => (await extract("pkg/cli.py", text)).role));
	const elseRuns = await extract("pkg/cli.py", "if __name__ == '__main__':\n    run()\nelse:\n    initialize()\n");

	expect(roles).toEqual(texts.map(() => ({ kind: "entry", how: "guardedMain" })));
	expect(elseRuns.role).toEqual({ kind: "entry", how: "topLevel" });
});

test("classifies other module statements as top-level entries", async () => {
	const facts = await extract("pkg/script.py", "if __name__ == '__main__':\n    pass\nprint('loaded')\n");

	expect(facts.role).toEqual({ kind: "entry", how: "topLevel" });
});

test("classifies declarative conditional setup as a library", async () => {
	const fixtureText =
		"from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from collections.abc import Iterable\n";
	const facts = await extract("src/lib.py", fixtureText);
	const nested = await extract(
		"src/nested.py",
		"if FEATURE:\n    if ENABLED:\n        value = 1\n    else:\n        pass\nelse:\n    from fallback import value\n",
	);
	const executable = await extract("src/setup.py", "if FEATURE:\n    initialize()\n");
	const executableElse = await extract("src/setup_else.py", "if FEATURE:\n    pass\nelse:\n    initialize()\n");

	expect(facts.role).toEqual({ kind: "library" });
	expect(nested.role).toEqual({ kind: "library" });
	expect(executable.role).toEqual({ kind: "entry", how: "topLevel" });
	expect(executableElse.role).toEqual({ kind: "entry", how: "topLevel" });
});

test("classifies declarative import fallback setup as a library", async () => {
	const fixtureText = "try:\n    import ujson as json\nexcept ImportError:\n    import json\n";
	const facts = await extract("src/lib.py", fixtureText);
	const complete = await extract(
		"src/complete.py",
		"try:\n    import preferred\nexcept ImportError:\n    import fallback\nelse:\n    selected = preferred\nfinally:\n    pass\n",
	);
	const executableBranches = [
		["src/setup_body.py", "try:\n    initialize()\nexcept ImportError:\n    import fallback\n"],
		["src/setup_handler.py", "try:\n    import preferred\nexcept ImportError:\n    initialize()\n"],
		[
			"src/setup_else.py",
			"try:\n    import preferred\nexcept ImportError:\n    import fallback\nelse:\n    initialize()\n",
		],
		[
			"src/setup_finally.py",
			"try:\n    import preferred\nexcept ImportError:\n    import fallback\nfinally:\n    initialize()\n",
		],
	] as const;

	expect(facts.role).toEqual({ kind: "library" });
	expect(complete.role).toEqual({ kind: "library" });
	for (const [module, text] of executableBranches) {
		const facts = await extract(module, text);
		expect(facts.role).toEqual({ kind: "entry", how: "topLevel" });
	}
});

test("keeps imports, declarations, assignments, and bare strings in a library", async () => {
	const facts = await extract(
		"pkg/library.py",
		[
			'"""Library docs."""',
			"import os",
			"value = 1",
			"value: int",
			"value += 1",
			"'standalone string'",
			"def run():",
			"    pass",
			"class Library:",
			"    pass",
		].join("\n"),
	);

	expect(facts.role).toEqual({ kind: "library" });
});

test("extracts public declarations, explicit exports, and final reassignments", async () => {
	const facts = await extract(
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

test("classifies imported Final annotations as constants", async () => {
	const facts = await extract(
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

test("leaves conflicting Final bindings as variables", async () => {
	const facts = await extract(
		"pkg/mod.py",
		["from typing import Final", "Final = object()", "limit: Final = 1"].join("\n"),
	);

	expect(facts.declarations.find((declaration) => declaration.name === "limit")).toMatchObject({ kind: "variable" });
});

test("leaves conditionally shadowed Final bindings as variables", async () => {
	const facts = await extract(
		"pkg/mod.py",
		["from typing import Final", "if enabled:", "    Final = object()", "limit: Final = 1"].join("\n"),
	);

	expect(facts.declarations.find((declaration) => declaration.name === "limit")).toMatchObject({ kind: "variable" });
});

test("extracts decorators, nested declarations, relative imports, and call candidates", async () => {
	const facts = await extract(
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

	const site = { conditional: false, moduleLevel: true };
	expect(facts.imports).toEqual([
		{
			specifier: ".",
			edges: [{ kind: "named", span: on(0, 14, 21), name: "sibling", range: on(0, 14, 21), ...site }],
			load: { kind: "sideEffect", span: on(0, 5, 6), ...site },
		},
		{
			specifier: "..common",
			edges: [
				{
					kind: "named",
					span: on(1, 21, 35),
					name: "value",
					range: on(1, 21, 26),
					local: "alias",
					localRange: on(1, 30, 35),
					...site,
				},
			],
			load: { kind: "sideEffect", span: on(1, 5, 13), ...site },
		},
		{
			specifier: "bpy",
			edges: [{ kind: "namespace", span: on(2, 7, 10), local: "bpy", localRange: on(2, 7, 10), ...site }],
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

test("classifies calls, receiver reads, writes, bases, and annotations", async () => {
	const facts = await extract(
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

test("classifies explicit type comments without inferring types", async () => {
	const facts = await extract(
		"pkg/mod.py",
		[
			"def run(value):  # type: (Input) -> Output",
			"    result = value  # type: Result",
			"    return result",
			"def spread(*args, **kwargs):  # type: (*Args, **Kwargs) -> Spread",
			"    pass",
			'def arrow(value):  # type: (Literal["->"]) -> Arrow',
			"    pass",
		].join("\n"),
	);

	expect(
		facts.references.filter((reference) => reference.role === "typeUse").map((reference) => reference.name),
	).toEqual(["Input", "Output", "Result", "Args", "Kwargs", "Spread", "Literal", "Arrow"]);
});

test("classifies exception and pattern captures as writes", async () => {
	const facts = await extract(
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

test("selects the name token each definition and capture binds", async () => {
	const facts = await extract(
		"pkg/mod.py",
		[
			"def ef():",
			"    pass",
			"async def sync():",
			"    pass",
			"class ss:",
			"    pass",
			"try:",
			"    pass",
			"except Error as E:",
			"    pass",
			"match p:",
			"    case Point(x=b) as a:",
			"        pass",
			'    case {"k": v, **rest}:',
			"        pass",
			"    case [*tail]:",
			"        pass",
		].join("\n"),
	);

	expect(facts.declarations.map((declaration) => [declaration.name, ...at(declaration.selectionRange)])).toEqual([
		["ef", 0, 4, 6],
		["sync", 2, 10, 14],
		["ss", 4, 6, 8],
	]);
	expect(
		facts.references
			.filter((reference) => reference.role === "write")
			.map((reference) => [reference.name, ...at(reference.range)]),
	).toEqual([
		["E", 8, 16, 17],
		["b", 11, 17, 18],
		["a", 11, 23, 24],
		["v", 13, 15, 16],
		["rest", 13, 20, 24],
		["tail", 15, 11, 15],
	]);
});

test("marks only receiver and path uses qualified", async () => {
	const facts = await extract(
		"pkg/mod.py",
		[
			"import pkg.sub",
			"from .other import thing",
			"class Base:",
			"    limit = 1",
			"    cap = limit",
			"class Child(pkg.sub.Base, Base):",
			"    @tools.wrap",
			"    def run(self, value: pkg.sub.Input) -> Output:",
			"        thing(value)",
			"        self.count += value.size",
			"        try:",
			"            pass",
			"        except errors.Failure as failure:",
			"            pass",
		].join("\n"),
	);

	expect(facts.references.map((reference) => [reference.name, reference.role, reference.qualified])).toEqual([
		["limit", "write", false],
		["cap", "write", false],
		["limit", "read", false],
		["pkg", "read", false],
		["sub", "read", true],
		["Base", "extends", true],
		["Base", "extends", false],
		["tools", "read", false],
		["wrap", "read", true],
		["pkg", "typeUse", false],
		["sub", "typeUse", true],
		["Input", "typeUse", true],
		["Output", "typeUse", false],
		["thing", "call", false],
		["value", "read", false],
		["self", "read", false],
		["count", "read", true],
		["count", "write", true],
		["value", "read", false],
		["size", "read", true],
		["errors", "read", false],
		["Failure", "read", true],
		["failure", "write", false],
	]);
});

test("keeps imports and exports in import facts rather than duplicate references", async () => {
	const facts = await extract(
		"pkg/mod.py",
		['__all__ = ["thing"]', "from .other import thing", "import sibling"].join("\n"),
	);

	const site = { conditional: false, moduleLevel: true };
	expect(facts.imports).toEqual([
		{
			specifier: ".other",
			edges: [{ kind: "named", span: on(1, 19, 24), name: "thing", range: on(1, 19, 24), ...site }],
			load: { kind: "sideEffect", span: on(1, 5, 11), ...site },
		},
		{
			specifier: "sibling",
			edges: [{ kind: "namespace", span: on(2, 7, 14), local: "sibling", localRange: on(2, 7, 14), ...site }],
		},
	]);
	expect(facts.references).toEqual([]);
});

test("reads __all__ as absent, a static list matched to its bindings, or dynamic once anything changes it", async () => {
	const absent = await extract("pkg/mod.py", "x = 1\n");
	const listed = await extract(
		"pkg/mod.py",
		['__all__ = ["thing", "local", "missing"]', "from .other import thing", "local = 1", ""].join("\n"),
	);
	const reassigned = await extract("pkg/mod.py", '__all__ = names()\n__all__ = ["a"]\na = 1\n');
	const read = await extract(
		"pkg/mod.py",
		'__all__ = ["a"]\nif "a" in __all__:\n    for name in __all__[:]:\n        print(name, *__all__)\na = 1\n',
	);
	const changed = [
		'__all__ = ["a"]\n__all__ += ["b"]\n',
		'__all__ = ["a"]\n__all__.append("b")\n',
		'__all__ = ["a"]\n__all__.extend(more)\n',
		"__all__ = names()\n",
		'if flag:\n    __all__ = ["a"]\n',
		"def reset():\n    global __all__\n    __all__ = []\n",
		'__all__ = ["a"]\nnames = __all__\nnames.clear()\n',
		'__all__ = ["a"]\nmutate(__all__)\n',
	];
	const dynamic = await Promise.all(changed.map((text) => extract("pkg/mod.py", text)));
	const fallback = await extract("pkg/mod.py", '__all__ = ["a"]\n__all__ += ["b"]\na = 1\n_c = 2\n');

	expect(absent.allList).toEqual({ state: "absent" });
	expect(listed.allList).toEqual({
		state: "static",
		entries: [
			{ name: "thing", range: on(0, 11, 18), target: { kind: "import", span: on(1, 19, 24) } },
			{
				name: "local",
				range: on(0, 20, 27),
				target: { kind: "symbol", descriptorPath: [{ kind: "term", name: "local" }] },
			},
			{ name: "missing", range: on(0, 29, 38), target: { kind: "unknown", reason: "NotIndexed" } },
		],
	});
	expect(reassigned.allList).toMatchObject({ state: "static", entries: [{ name: "a" }] });
	expect(read.allList).toMatchObject({ state: "static", entries: [{ name: "a" }] });
	expect(dynamic.map((facts) => facts.allList)).toEqual(
		changed.map(() => ({ state: "dynamic", reason: "RuntimeConstructed" })),
	);
	expect(fallback.declarations.map((declaration) => [declaration.name, declaration.exported])).toEqual([
		["a", true],
		["_c", false],
	]);
});

test("emits exact import name ranges for aliases and multiline lists", async () => {
	const facts = await extract(
		"pkg/mod.py",
		["from .item import helper as h", "from .item import (", "    Item,", "    other as alias,", ")"].join("\n"),
	);

	const site = { conditional: false, moduleLevel: true };
	expect(facts.imports).toEqual([
		{
			specifier: ".item",
			edges: [
				{
					kind: "named",
					span: on(0, 18, 29),
					name: "helper",
					range: on(0, 18, 24),
					local: "h",
					localRange: on(0, 28, 29),
					...site,
				},
			],
			load: { kind: "sideEffect", span: on(0, 5, 10), ...site },
		},
		{
			specifier: ".item",
			edges: [
				{ kind: "named", span: on(2, 4, 8), name: "Item", range: on(2, 4, 8), ...site },
				{
					kind: "named",
					span: on(3, 4, 18),
					name: "other",
					range: on(3, 4, 9),
					local: "alias",
					localRange: on(3, 13, 18),
					...site,
				},
			],
			load: { kind: "sideEffect", span: on(1, 5, 10), ...site },
		},
	]);
});

test("reports a star as one selecting edge, and a dotted import as its package binding plus a load per submodule", async () => {
	const facts = await extract(
		"pkg/mod.py",
		"from .item import *\nimport os.path as p\nimport os\nimport a.b\nimport x . y.z\n",
	);

	const site = { conditional: false, moduleLevel: true };
	expect(facts.imports).toEqual([
		{
			specifier: ".item",
			edges: [{ kind: "wildcard", span: on(0, 18, 19), selector: { kind: "allList" }, ...site }],
			load: { kind: "sideEffect", span: on(0, 5, 10), ...site },
		},
		{
			specifier: "os.path",
			edges: [{ kind: "namespace", span: on(1, 7, 19), local: "p", localRange: on(1, 18, 19), ...site }],
		},
		{
			specifier: "os",
			edges: [{ kind: "namespace", span: on(2, 7, 9), local: "os", localRange: on(2, 7, 9), ...site }],
		},
		{
			specifier: "a",
			edges: [{ kind: "namespace", span: on(3, 7, 8), local: "a", localRange: on(3, 7, 8), ...site }],
		},
		{ specifier: "a.b", edges: [{ kind: "sideEffect", span: on(3, 7, 10), ...site }] },
		{
			specifier: "x",
			edges: [{ kind: "namespace", span: on(4, 7, 8), local: "x", localRange: on(4, 7, 8), ...site }],
		},
		{ specifier: "x.y", edges: [{ kind: "sideEffect", span: on(4, 7, 12), ...site }] },
		{ specifier: "x.y.z", edges: [{ kind: "sideEffect", span: on(4, 7, 14), ...site }] },
	]);
	expect(facts.importBindings.find((binding) => binding.specifier === "a.b")).toMatchObject({
		lands: "a",
		localName: "a",
		span: on(3, 7, 8),
		loads: [on(3, 7, 10)],
	});
	expect(facts.importBindings.find((binding) => binding.specifier === "x.y.z")?.loads).toEqual([
		on(4, 7, 12),
		on(4, 7, 14),
	]);
});

test("keeps import specifiers out of literals while indexing string arguments", async () => {
	const facts = await extract(
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

test("records imports at every relative depth and nested scope", async () => {
	const facts = await extract(
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

test("keeps exact ranges for imports in conditional blocks", async () => {
	const facts = await extract("pkg/mod.py", "try:\n    import optional\nexcept ImportError:\n    pass\n");

	expect(facts.imports).toEqual([
		{
			specifier: "optional",
			edges: [
				{
					kind: "namespace",
					span: on(1, 11, 19),
					local: "optional",
					localRange: on(1, 11, 19),
					conditional: true,
					moduleLevel: true,
				},
			],
		},
	]);
});

test("reports syntax errors without inventing facts", async () => {
	const facts = await extract("broken.py", "def broken(:\n    pass\n");

	expect(facts.declarations).toEqual([]);
	expect(facts.imports).toEqual([]);
	expect({ exports: facts.exports, allList: facts.allList }).toEqual({ exports: null, allList: null });
	expect(facts.diagnostics).toHaveLength(1);
	expect(facts.diagnostics[0]?.severity).toBe("error");
});
