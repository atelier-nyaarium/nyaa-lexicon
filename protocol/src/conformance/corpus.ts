// The shared corpus. Data, so a provider team reads it without reading the runner.
//
// A case states ONE expectation in language-neutral terms, then carries a fixture per language
// saying it. The expectations are shared; the syntax never is. A language with no fixture for a
// case skips it, which is the corpus admitting a gap rather than the provider failing one.
//
// Adding a language means adding fixtures here, and the provider team is the right author: they
// know their language's edge cases better than this file does.

import { type ConformanceCase, ConformanceCaseSchema } from "./types.js";

////////////////////////////////
//  Constants

/**
 * One character above U+FFFF, built from its code point rather than written literally.
 *
 * It is 2 UTF-16 code units, 1 codepoint and 4 UTF-8 bytes, so a column measured after it says
 * which unit the provider counts. Constructed here because a literal astral character in source is
 * exactly the kind of byte that survives review by being invisible.
 */
const ASTRAL = String.fromCodePoint(0x1f600);

/** The suite's own reference provider, whose toy grammar is a subset of TypeScript's. */
const REFERENCE = "reference";
const TYPESCRIPT = "typescript";
const PYTHON = "python";
const GDSCRIPT = "gdscript";

const CASES: ConformanceCase[] = [
	{
		id: "exported-declarations",
		tier: "declarations",
		about: "Every exported declaration is reported, with its kind and exported flag.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/cart.ts": "export class Cart {}\nexport function add() {}\nexport const LIMIT = 1;\n" },
				subject: "src/cart.ts",
			},
			[REFERENCE]: {
				files: { "src/cart.ref": "export class Cart {}\nexport function add() {}\nexport const LIMIT = 1;\n" },
				subject: "src/cart.ref",
			},
			// Python has no export keyword. __all__ is the one statement of public API a reader and a
			// tool can both act on, so it is what "exported" means here.
			// LIMIT is annotated Final because that is Python's constant, and a bare `LIMIT = 1` is a
			// variable the language lets anyone reassign. Matching the syntax rather than the spelling
			// is what keeps one expectation meaningful across languages.
			// GDScript has NO fixture on purpose: the language has no export concept, its extractor
			// answers `exported` with absence, and a fixture would have to drop the flag this case is
			// about. The skip is the honest outcome, not a gap.
			[PYTHON]: {
				files: {
					"src/cart.py":
						'from typing import Final\n\n__all__ = ["Cart", "add", "LIMIT"]\n\n\nclass Cart:\n    pass\n\n\ndef add():\n    pass\n\n\nLIMIT: Final = 1\n',
				},
				subject: "src/cart.py",
			},
		},
		declarations: [
			{ name: "Cart", kind: "class", exported: true },
			{ name: "add", kind: "function", exported: true },
			{ name: "LIMIT", kind: "constant", exported: true },
		],
	},
	{
		id: "declaration-id-descriptors",
		tier: "declarations",
		about: "A symbol id carries the declaration's descriptor chain, asserted by parts not text.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/cart.ts": "export class Cart {}\n" }, subject: "src/cart.ts" },
			[REFERENCE]: { files: { "src/cart.ref": "export class Cart {}\n" }, subject: "src/cart.ref" },
			[PYTHON]: { files: { "src/cart.py": "class Cart:\n    pass\n" }, subject: "src/cart.py" },
			[GDSCRIPT]: { files: { "src/cart.gd": "class_name Cart\nextends Node\n" }, subject: "src/cart.gd" },
		},
		// The one expectation that must hold in every language: a class is a `type` descriptor. Three
		// syntaxes with nothing in common still have to mint the same id shape, because the id is the
		// join key across providers.
		declarations: [{ name: "Cart", descriptors: ["type:Cart"] }],
	},
	{
		id: "position-is-utf16-code-units",
		tier: "declarations",
		about: "A column counts UTF-16 code units, so an astral character before a name shifts it by two.",
		fixtures: {
			// A block comment puts the astral character on the same line as the name, which is the only
			// arrangement that tests a COLUMN. `/* ` is 3, the character is 2, ` */ export class ` is 17.
			// Each expected column is the ONLY one UTF-16 gives. Counting bytes puts it two further
			// right and counting codepoints one further left, so no unit but the required one passes.
			[TYPESCRIPT]: {
				files: { "src/cart.ts": `/* ${ASTRAL} */ export class Cart {}\n` },
				subject: "src/cart.ts",
				declarations: [{ name: "Cart", nameStart: { line: 0, character: 22 } }],
			},
			// Neither Python nor GDScript has a block comment, so a separated statement is what puts the
			// character to the left of a name. Python's ast reports UTF-8 byte columns, and converting
			// those to codepoints is the near miss this case exists to catch: it is right for every
			// character below U+FFFF and one short for every character above it.
			[PYTHON]: {
				files: { "src/cart.py": `X = "${ASTRAL}"; Y = 1\n` },
				subject: "src/cart.py",
				declarations: [{ name: "Y", nameStart: { line: 0, character: 10 } }],
			},
			[GDSCRIPT]: {
				files: { "src/cart.gd": `extends Node\n\nvar x = "${ASTRAL}"; var y = 1\n` },
				subject: "src/cart.gd",
				declarations: [{ name: "y", nameStart: { line: 2, character: 18 } }],
			},
		},
	},
	{
		id: "declaration-range-with-trailing-newline",
		tier: "declarations",
		about: "A declaration stays addressable when a trailing newline creates a final empty line.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/cart.ts": "\nexport const cart = 1;\n" },
				subject: "src/cart.ts",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 13 } }],
			},
			[REFERENCE]: {
				files: { "src/cart.ref": "\nexport const cart = 1;\n" },
				subject: "src/cart.ref",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 13 } }],
			},
			[PYTHON]: {
				files: { "src/cart.py": "\ncart = 1\n" },
				subject: "src/cart.py",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 0 } }],
			},
			[GDSCRIPT]: {
				files: { "src/cart.gd": "\nvar cart = 1\n" },
				subject: "src/cart.gd",
				declarations: [{ name: "cart", nameStart: { line: 1, character: 4 } }],
			},
		},
	},
	{
		id: "empty-file",
		tier: "declarations",
		about: "A file with nothing in it reports nothing, and does not error.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/empty.ts": "\n" }, subject: "src/empty.ts" },
			[REFERENCE]: { files: { "src/empty.ref": "\n" }, subject: "src/empty.ref" },
			[PYTHON]: { files: { "src/empty.py": "\n" }, subject: "src/empty.py" },
			[GDSCRIPT]: { files: { "src/empty.gd": "\n" }, subject: "src/empty.gd" },
		},
		declarations: [],
	},
	{
		id: "broken-syntax-is-an-error-diagnostic",
		tier: "syntaxDiagnostics",
		about: "A provider claiming syntax diagnostics reports an error for text that cannot parse.",
		// Unambiguously invalid under any reading, so a lenient extractor that recovers and reports
		// nothing fails here rather than passing on silence.
		fixtures: {
			[TYPESCRIPT]: { files: { "src/broken.ts": "export function add( {\n" }, subject: "src/broken.ts" },
			[REFERENCE]: { files: { "src/broken.ref": "export class {\n" }, subject: "src/broken.ref" },
			[PYTHON]: { files: { "src/broken.py": "def add(:\n    pass\n" }, subject: "src/broken.py" },
			[GDSCRIPT]: { files: { "src/broken.gd": "func add(:\n\tpass\n" }, subject: "src/broken.gd" },
		},
		parseErrors: "required",
	},
	{
		id: "import-resolves-to-module",
		tier: "imports",
		about: "A relative specifier resolves to a workspace-relative module path.",
		fixtures: {
			[TYPESCRIPT]: {
				files: {
					"src/cart.ts": 'import { Item } from "./item";\n',
					"src/item.ts": "export class Item {}\n",
				},
				subject: "src/cart.ts",
			},
			[PYTHON]: {
				files: {
					"src/cart.py": "from .item import Item\n",
					"src/item.py": "class Item:\n    pass\n",
				},
				subject: "src/cart.py",
				imports: [{ specifier: ".item", status: "resolved", module: "src/item.py" }],
			},
			// GDScript writes no specifier at all: the module is named by a literal path inside a
			// preload, and the local `Item` is a binding of the consumer's own choosing. The shared
			// sentence still holds, and only this language's spelling of it is unusual.
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/item.gd": "class_name Item\nextends Node\n",
					"src/cart.gd": 'class_name Cart\nextends Node\n\nconst Item = preload("res://src/item.gd")\n',
				},
				subject: "src/cart.gd",
				imports: [{ specifier: "res://src/item.gd", status: "resolved", module: "src/item.gd" }],
			},
		},
		imports: [{ specifier: "./item", status: "resolved", module: "src/item.ts" }],
	},
	{
		id: "import-external-is-not-unresolved",
		tier: "imports",
		about: "An installed dependency is external, which is a different answer from unresolved.",
		fixtures: {
			// The dependency is part of the fixture. Without it a provider is right to say unresolved,
			// and the case would be testing whether the runner's temp dir has node_modules.
			[TYPESCRIPT]: {
				files: {
					"src/cart.ts": 'import { z } from "zod";\n',
					"node_modules/zod/package.json": '{ "name": "zod", "version": "4.0.0", "types": "index.d.ts" }\n',
					"node_modules/zod/index.d.ts": "export declare const z: unknown;\n",
				},
				subject: "src/cart.ts",
			},
			// No vendored package needed: the standard library is the dependency every Python has, and
			// telling it apart from a missing one is the distinction this case exists to make.
			[PYTHON]: {
				files: { "src/cart.py": "import ast\n" },
				subject: "src/cart.py",
				imports: [{ specifier: "ast", status: "external" }],
			},
			// A scene is the GDScript case for this: it exists, it is really depended on, and it holds
			// no GDScript declaration, so calling it unresolved would report a present file as missing.
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/enemy.tscn": '[gd_scene format=3]\n\n[node name="Enemy" type="Node2D"]\n',
					"src/cart.gd": 'class_name Cart\nextends Node\n\nconst Enemy = preload("res://src/enemy.tscn")\n',
				},
				subject: "src/cart.gd",
				imports: [{ specifier: "res://src/enemy.tscn", status: "external" }],
			},
		},
		imports: [{ specifier: "zod", status: "external" }],
	},
	{
		id: "import-missing-is-unresolved",
		tier: "imports",
		about: "A specifier nothing satisfies is unresolved, which is a finding rather than an error.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/cart.ts": 'import { gone } from "./gone";\n' }, subject: "src/cart.ts" },
			[PYTHON]: {
				files: { "src/cart.py": "from .gone import gone\n" },
				subject: "src/cart.py",
				imports: [{ specifier: ".gone", status: "unresolved" }],
			},
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/cart.gd": 'class_name Cart\nextends Node\n\nconst Gone = preload("res://src/gone.gd")\n',
				},
				subject: "src/cart.gd",
				imports: [{ specifier: "res://src/gone.gd", status: "unresolved" }],
			},
		},
		imports: [{ specifier: "./gone", status: "unresolved" }],
	},
	{
		id: "reference-binds-to-its-declaration",
		tier: "binding",
		about: "A use of a local declaration binds to it rather than merely matching by name.",
		fixtures: {
			[TYPESCRIPT]: {
				files: { "src/cart.ts": "export function add() {}\nexport function run() { add(); }\n" },
				subject: "src/cart.ts",
			},
			[PYTHON]: {
				files: { "src/cart.py": "def add():\n    pass\n\n\ndef run():\n    add()\n" },
				subject: "src/cart.py",
			},
			[GDSCRIPT]: {
				files: {
					"project.godot": 'config_version=5\n\n[application]\nconfig/name="cart"\n',
					"src/cart.gd":
						"class_name Cart\nextends Node\n\n\nfunc add() -> void:\n\tpass\n\n\nfunc run() -> void:\n\tadd()\n",
				},
				subject: "src/cart.gd",
			},
		},
		references: [{ name: "add", status: "bound", bindsTo: "add" }],
	},
	{
		id: "type-of-annotated-constant",
		tier: "types",
		about: "An explicitly annotated declaration reports that type.",
		fixtures: {
			[TYPESCRIPT]: { files: { "src/cart.ts": "export const LIMIT: number = 1;\n" }, subject: "src/cart.ts" },
			// The display is per-fixture because `number` and `int` are one sentence in two spellings.
			[GDSCRIPT]: {
				files: { "src/cart.gd": "class_name Cart\nextends Node\n\nconst LIMIT: int = 1\n" },
				subject: "src/cart.gd",
				typeOf: { name: "LIMIT", display: "int" },
			},
		},
		typeOf: { name: "LIMIT", display: "number" },
	},
	{
		id: "type-of-annotated-declaration",
		tier: "types",
		about: "An annotated declaration reports a KNOWN type, whatever each language spells it.",
		fixtures: {
			// Display text is deliberately not asserted here. `number`, `int` and `float` are the same
			// sentence in three languages, and pinning one spelling would make this a TypeScript case
			// wearing a shared name.
			[TYPESCRIPT]: { files: { "src/cart.ts": "export const LIMIT: number = 1;\n" }, subject: "src/cart.ts" },
			[PYTHON]: { files: { "src/cart.py": "LIMIT: int = 1\n" }, subject: "src/cart.py" },
			[GDSCRIPT]: {
				files: { "src/cart.gd": "class_name Cart\nextends Node\n\nconst LIMIT: int = 1\n" },
				subject: "src/cart.gd",
			},
		},
		typeOf: { name: "LIMIT", status: "known" },
	},
	{
		id: "type-of-inferred-return-union",
		tier: "types",
		about: "Every return is joined, and the exact values survive when they are determinable.",
		fixtures: {
			// No display assertion anywhere here on purpose. Python spells this Literal['foo', 'bar',
			// 'baz'], TypeScript spells it "foo" | "bar" | "baz", and GDScript has no syntax for it at
			// all. What is actually shared is that no member was dropped.
			[TYPESCRIPT]: {
				files: {
					"src/cart.ts":
						'export function pick(a: boolean, b: boolean) {\n\tif (a) return "foo";\n\telse if (b) return "bar";\n\treturn "baz";\n}\n',
				},
				subject: "src/cart.ts",
			},
			[PYTHON]: {
				files: {
					"src/cart.py":
						'def pick(a, b):\n    if a:\n        return "foo"\n    elif b:\n        return "bar"\n    return "baz"\n',
				},
				subject: "src/cart.py",
			},
			[GDSCRIPT]: {
				files: {
					"src/cart.gd":
						'class_name Cart\nextends Node\n\n\nfunc pick(a, b):\n\tif a:\n\t\treturn "foo"\n\telif b:\n\t\treturn "bar"\n\treturn "baz"\n',
				},
				subject: "src/cart.gd",
			},
		},
		typeOf: { name: "pick", status: "inferred", mentions: ["foo", "bar", "baz"] },
	},
	{
		id: "type-of-implicit-return",
		tier: "types",
		about: "A path that falls off the end returns nothing, and that is a member of the union.",
		fixtures: {
			// The member a naive implementation drops. Measured on the TypeScript checker, which
			// answers `"foo" | undefined` here, so the precise answer is the correct one.
			[TYPESCRIPT]: {
				files: { "src/cart.ts": 'export function maybe(a: boolean) {\n\tif (a) return "foo";\n}\n' },
				subject: "src/cart.ts",
				typeOf: { name: "maybe", status: "inferred", mentions: ["foo", "undefined"] },
			},
			[PYTHON]: {
				files: { "src/cart.py": 'def maybe(a):\n    if a:\n        return "foo"\n' },
				subject: "src/cart.py",
				typeOf: { name: "maybe", status: "inferred", mentions: ["foo", "None"] },
			},
			[GDSCRIPT]: {
				files: {
					"src/cart.gd": 'class_name Cart\nextends Node\n\n\nfunc maybe(a):\n\tif a:\n\t\treturn "foo"\n',
				},
				subject: "src/cart.gd",
				typeOf: { name: "maybe", status: "inferred", mentions: ["foo", "null"] },
			},
		},
		typeOf: { name: "maybe", status: "inferred", mentions: ["foo"] },
	},
	{
		id: "type-of-partial-inference-is-unknown",
		tier: "types",
		about: "One uninferrable branch makes the whole answer unknown, never a union of the rest.",
		fixtures: {
			// The honesty case. A caller cannot tell a complete union from a truncated one, so a
			// truncated one is worse than no answer at all.
			[PYTHON]: {
				files: {
					"src/cart.py": 'def pick(a, mystery):\n    if a:\n        return "foo"\n    return mystery()\n',
				},
				subject: "src/cart.py",
			},
			[GDSCRIPT]: {
				files: {
					"src/cart.gd":
						'class_name Cart\nextends Node\n\n\nfunc pick(a, mystery):\n\tif a:\n\t\treturn "foo"\n\treturn mystery.call()\n',
				},
				subject: "src/cart.gd",
			},
		},
		typeOf: { name: "pick", status: "unknown" },
	},
	{
		id: "type-of-inferred-initializer",
		tier: "types",
		about: "An unannotated declaration takes its type from what it was assigned.",
		fixtures: {
			// This case used to assert `unknown`, back when Python and GDScript read annotations and
			// nothing else. Both now infer, so the old expectation was a test encoding the absence of
			// a feature, and it went red the moment the feature arrived, which is the test working.
			[TYPESCRIPT]: { files: { "src/cart.ts": "export const LIMIT = 1;\n" }, subject: "src/cart.ts" },
			[PYTHON]: { files: { "src/cart.py": "LIMIT = 1\n" }, subject: "src/cart.py" },
			[GDSCRIPT]: {
				files: { "src/cart.gd": "class_name Cart\nextends Node\n\nvar LIMIT = 1\n" },
				subject: "src/cart.gd",
			},
		},
		// Status only. `inferred` is the whole claim: the source never said this, we concluded it,
		// and a consumer weighs that differently from an annotation it can go and read.
		typeOf: { name: "LIMIT", status: "inferred" },
	},
];

////////////////////////////////
//  Functions & Helpers

/**
 * The corpus, validated on read.
 *
 * Parsed rather than trusted so a malformed case fails here, where the message names the case,
 * instead of somewhere inside a provider run where it looks like the provider's fault.
 */
export function loadCorpus(): ConformanceCase[] {
	return CASES.map((testCase) => ConformanceCaseSchema.parse(testCase));
}

/** Cases for one tier, which is how a provider team runs only what it claims. */
export function casesForTier(tier: string): ConformanceCase[] {
	return loadCorpus().filter((testCase) => testCase.tier === tier);
}

/** Every language the corpus can currently speak, for a report that names what it does not. */
export function corpusLanguages(): string[] {
	const seen = new Set<string>();
	for (const testCase of loadCorpus()) for (const language of Object.keys(testCase.fixtures)) seen.add(language);
	return [...seen].sort();
}
