// What a signature holds, and what a body holds, stated once per language.

import { FOLD_MARK } from "../header.js";
import type { ConformanceCase } from "./types.js";

const TYPESCRIPT = "typescript";
const PYTHON = "python";
const GDSCRIPT = "gdscript";
const C = "c";
const CPP = "cpp";
const CSHARP = "csharp";
const RUST = "rust";
const KOTLIN = "kotlin";
const BASH = "bash";
const XML = "xml";
const HTML = "html";

/** Delimiters around the fold mark. */
function fold(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

function signatures(expected: Record<string, string>) {
	return Object.entries(expected).map(([name, signature]) => ({ name, signature }));
}

function locals(names: string[]) {
	return names.map((name) => ({ name, visibility: "local" as const }));
}

/** A declaration file, the same whether a workspace or a package holds it. */
const DECLARATION_FILE = [
	"/** Adds. */",
	"export declare function add(",
	"\tleft: number,",
	"\tright: number, // wide",
	"): number;",
	"",
	"export declare class Client<T>",
	"\textends Base<T>",
	"\timplements Shape {",
	"\tconstructor(seed: string);",
	"\tpublic open(",
	"\t\turl: string,",
	"\t): Promise<void>;",
	"\treadonly ready: boolean;",
	"}",
	"",
	"export interface Options extends Base<string> {",
	"\texact: boolean;",
	"}",
	"",
	"export type Claim = { claimed: true } | { claimed: false };",
	"",
	"export declare const TABLE: readonly string[];",
	"",
].join("\n");

const DECLARATION_FILE_SIGNATURES = {
	add: "export declare function add(left: number, right: number): number",
	Client: "export declare class Client<T> extends Base<T> implements Shape",
	constructor: "constructor(seed: string)",
	open: "public open(url: string): Promise<void>",
	ready: "readonly ready: boolean",
	Options: "export interface Options extends Base<string>",
	exact: "exact: boolean",
	Claim: `export type Claim = ${fold("{", "}")} | ${fold("{", "}")}`,
	TABLE: "export declare const TABLE: readonly string[]",
};

/** One case per place a declaration file is read from. */
function declarationFileCase(id: string, about: string, subject: string): ConformanceCase {
	return {
		id,
		tier: "declarations",
		about,
		fixtures: {
			[TYPESCRIPT]: {
				files: { [subject]: DECLARATION_FILE },
				subject,
				declarations: signatures(DECLARATION_FILE_SIGNATURES),
			},
		},
	};
}

/** A case fixture: one file, its lines, and the signatures it must carry. */
function literalFixture(subject: string, lines: string[], expected: Record<string, string>) {
	return { files: { [subject]: lines.join("\n") }, subject, declarations: signatures(expected) };
}

export function headerCases(): ConformanceCase[] {
	return [
		{
			id: "a-literal-in-a-header-keeps-its-whitespace",
			tier: "declarations",
			about: "A string, template or regex literal in a header keeps its spacing as written, and a line break inside it reads as an escaped \\n.",
			fixtures: {
				[TYPESCRIPT]: literalFixture(
					"src/literals.ts",
					[
						'export const SEP = "a  b";',
						"export const DOC = `one",
						"  two`;",
						"export const RE = /a  b/;",
						"",
					],
					{
						SEP: 'export const SEP = "a  b"',
						DOC: "export const DOC = `one\\n  two`",
						RE: "export const RE = /a  b/",
					},
				),
				[PYTHON]: literalFixture("src/literals.py", ['SEP = "a  b"', 'DOC = """one', '  two"""', ""], {
					SEP: 'SEP = "a  b"',
					DOC: 'DOC = """one\\n  two"""',
				}),
				[C]: literalFixture("src/literals.c", ['static const char *SEP = "a  b";', ""], {
					SEP: 'static const char *SEP = "a  b"',
				}),
				[CPP]: literalFixture(
					"src/literals.cpp",
					['const char *SEP = "a  b";', 'const char *DOC = R"(one', '  two)";', ""],
					{ SEP: 'const char *SEP = "a  b"', DOC: 'const char *DOC = R"(one\\n  two)"' },
				),
				[CSHARP]: literalFixture(
					"src/Literals.cs",
					[
						"public static class Text",
						"{",
						'\tpublic const string Sep = "a  b";',
						'\tpublic const string Doc = @"one',
						'  two";',
						"}",
						"",
					],
					{ Sep: 'public const string Sep = "a  b"', Doc: 'public const string Doc = @"one\\n  two"' },
				),
				[RUST]: literalFixture(
					"src/literals.rs",
					['pub const SEP: &str = "a  b";', 'pub const DOC: &str = "one', '  two";', ""],
					{ SEP: 'pub const SEP: &str = "a  b"', DOC: 'pub const DOC: &str = "one\\n  two"' },
				),
				[KOTLIN]: literalFixture(
					"src/geo/Literals.kt",
					["package geo", "", 'val SEP = "a  b"', 'val DOC = """one', '  two"""', ""],
					{ SEP: 'val SEP = "a  b"', DOC: 'val DOC = """one\\n  two"""' },
				),
				[GDSCRIPT]: literalFixture(
					"literals.gd",
					['const SEP = "a  b"', 'const DOC = """one', '  two"""', ""],
					{
						SEP: 'const SEP = "a  b"',
						DOC: 'const DOC = """one\\n  two"""',
					},
				),
				[BASH]: literalFixture("literals.sh", ['SEP="a  b"', "DOC='one", "  two'", ""], {
					SEP: 'SEP="a  b"',
					DOC: "DOC='one\\n  two'",
				}),
				[XML]: literalFixture("literals.xml", ['<root id="r" title="a  b"', '\tnote="one', '  two"/>', ""], {
					r: '<root id="r" title="a  b" note="one\\n  two"/>',
				}),
				[HTML]: literalFixture(
					"literals.html",
					['<div id="main" title="a  b"', '\tdata-note="one', '  two"></div>', ""],
					{ main: '<div id="main" title="a  b" data-note="one\\n  two">' },
				),
			},
		},
		declarationFileCase(
			"a-workspace-declaration-file-signs-whole-headers",
			"A declaration file in the workspace signs each declaration with its whole header, modifiers and heritage kept.",
			"src/geo.d.ts",
		),
		declarationFileCase(
			"a-package-declaration-surface-signs-whole-headers",
			"A package's declaration file, read as a surface, signs each declaration as a workspace parse would.",
			"node_modules/geo/index.d.ts",
		),
		{
			id: "a-signature-is-the-whole-header",
			tier: "declarations",
			about: "A signature is the declaration's header on one line: first token to body, decorators and attributes kept, comments and the doc comment out, a trailing comma and terminator dropped, and a literal container in a value folded.",
			fixtures: {
				[TYPESCRIPT]: {
					files: {
						"src/header.ts": [
							"/** Adds. */",
							"export async function add(",
							"\tleft: number,",
							"\tright: number,",
							"): Promise<number> {",
							"\treturn left + right;",
							"}",
							"",
							"@sealed",
							"export class Box<T>",
							"\textends Base<T>",
							"\timplements Shape {",
							"\t@field() private readonly size: number = 3;",
							"",
							"\t/** Resizes. */",
							"\tresize(",
							"\t\twidth: number, // wide",
							"\t\theight: number,",
							"\t): void {}",
							"}",
							"",
							"export const TABLE: readonly string[] = [",
							'\t"a",',
							'\t"b",',
							"];",
							"",
							"export const handler = async (input: string): Promise<string> => {",
							"\treturn input;",
							"};",
							"",
							"export const EMPTY = {};",
							"",
						].join("\n"),
					},
					subject: "src/header.ts",
					declarations: signatures({
						add: "export async function add(left: number, right: number): Promise<number>",
						Box: "@sealed export class Box<T> extends Base<T> implements Shape",
						size: "@field() private readonly size: number = 3",
						resize: "resize(width: number, height: number): void",
						TABLE: `export const TABLE: readonly string[] = ${fold("[", "]")}`,
						handler: `export const handler = async (input: string): Promise<string> => ${fold("{", "}")}`,
						EMPTY: "export const EMPTY = {}",
					}),
				},
				[PYTHON]: {
					files: {
						"src/header.py": [
							"@dataclass",
							"class Box(Base,",
							"          Shape):",
							'    """Doc."""',
							"",
							"    size: int = 3",
							"",
							"    @property",
							"    def area(",
							"        self,",
							"        scale: int,  # wide",
							"    ) -> int:",
							"        return self.size * scale",
							"",
							"",
							"def add(left: int,",
							"        right: int) -> int:",
							"    return left + right",
							"",
							"",
							"TABLE = [",
							'    "a",',
							'    "b",',
							"]",
							"EMPTY = []",
							"",
						].join("\n"),
					},
					subject: "src/header.py",
					declarations: signatures({
						Box: "@dataclass class Box(Base, Shape):",
						size: "size: int = 3",
						area: "@property def area(self, scale: int) -> int:",
						add: "def add(left: int, right: int) -> int:",
						TABLE: `TABLE = ${fold("[", "]")}`,
						EMPTY: "EMPTY = []",
					}),
				},
				[C]: {
					files: {
						"src/header.c": [
							"/* Adds. */",
							"__attribute__((pure)) int add(int left, /* wide */",
							"\tint right)",
							"{",
							"\treturn left + right;",
							"}",
							"",
							"static const int TABLE[] = {",
							"\t1,",
							"\t2,",
							"};",
							"",
							"struct point {",
							"\tint x;",
							"\tint y;",
							"};",
							"",
							"int count(void);",
							"",
						].join("\n"),
					},
					subject: "src/header.c",
					declarations: signatures({
						add: "__attribute__((pure)) int add(int left, int right)",
						TABLE: `static const int TABLE[] = ${fold("{", "}")}`,
						point: "struct point",
						x: "int x",
						count: "int count(void)",
					}),
				},
				[CPP]: {
					files: {
						"src/header.cpp": [
							"namespace geo {",
							"/// Doc.",
							"class Box : public Base {",
							"public:",
							"\t[[nodiscard]] int area(",
							"\t\tint scale, // wide",
							"\t\tint bias) const;",
							"\tstd::vector<int> items = {1, 2};",
							"};",
							"}",
							"",
							"template <typename T>",
							"T pick(T left, T right) {",
							"\treturn left;",
							"}",
							"",
						].join("\n"),
					},
					subject: "src/header.cpp",
					declarations: signatures({
						geo: "namespace geo",
						Box: "class Box : public Base",
						area: "[[nodiscard]] int area(int scale, int bias) const",
						items: `std::vector<int> items = ${fold("{", "}")}`,
						pick: "template <typename T> T pick(T left, T right)",
					}),
				},
				[CSHARP]: {
					files: {
						"src/Header.cs": [
							"namespace Geo;",
							"",
							"/// <summary>Doc.</summary>",
							"[Serializable]",
							"public class Box<T> : Base<T>,",
							"\tIShape",
							"{",
							'\t[Obsolete("old")]',
							"\tpublic int Size { get; set; } = 3;",
							"",
							"\tpublic async Task<int> Area(",
							"\t\tint scale, // wide",
							"\t\tint bias)",
							"\t{",
							"\t\treturn scale + bias;",
							"\t}",
							"",
							"\tprivate static readonly List<int> Table = new() {",
							"\t\t1,",
							"\t\t2,",
							"\t};",
							"}",
							"",
						].join("\n"),
					},
					subject: "src/Header.cs",
					declarations: signatures({
						Geo: "namespace Geo",
						Box: "[Serializable] public class Box<T> : Base<T>, IShape",
						Size: '[Obsolete("old")] public int Size',
						Area: "public async Task<int> Area(int scale, int bias)",
						Table: `private static readonly List<int> Table = new() ${fold("{", "}")}`,
					}),
				},
				[RUST]: {
					files: {
						"src/header.rs": [
							"/// Doc.",
							"#[derive(Debug)]",
							"pub struct Point {",
							"    pub x: i32,",
							"}",
							"",
							"pub fn add(",
							"    left: i32, // wide",
							"    right: i32,",
							") -> i32 {",
							"    left + right",
							"}",
							"",
							"pub const TABLE: [&str; 2] = [",
							'    "a",',
							'    "b",',
							"];",
							"",
							"impl Point {",
							"    #[inline]",
							"    pub fn scale(&self,",
							"        by: i32) -> i32 {",
							"        self.x * by",
							"    }",
							"}",
							"",
						].join("\n"),
					},
					subject: "src/header.rs",
					declarations: signatures({
						Point: "#[derive(Debug)] pub struct Point",
						x: "pub x: i32",
						add: "pub fn add(left: i32, right: i32) -> i32",
						TABLE: `pub const TABLE: [&str; 2] = ${fold("[", "]")}`,
						scale: "#[inline] pub fn scale(&self, by: i32) -> i32",
					}),
				},
				[KOTLIN]: {
					files: {
						"src/geo/Header.kt": [
							"package geo",
							"",
							"/** Doc. */",
							"@Serializable",
							"class Box<T>(",
							"    val size: Int,",
							") : Base<T>(),",
							"    Shape {",
							"    @JvmField",
							"    val items = arrayOf(",
							"        1,",
							"        2,",
							"    )",
							"",
							"    fun area(",
							"        scale: Int, // wide",
							"        bias: Int,",
							"    ): Int {",
							"        return scale + bias",
							"    }",
							"}",
							"",
							"val handler = { value: Int ->",
							"    value + 1",
							"}",
							"",
						].join("\n"),
					},
					subject: "src/geo/Header.kt",
					declarations: signatures({
						Box: "@Serializable class Box<T>(val size: Int) : Base<T>(), Shape",
						size: "val size: Int",
						items: "@JvmField val items = arrayOf(1, 2)",
						area: "fun area(scale: Int, bias: Int): Int",
						handler: `val handler = ${fold("{", "}")}`,
					}),
				},
				[GDSCRIPT]: {
					files: {
						"header.gd": [
							"class_name Box",
							"extends Node",
							"",
							"## Doc.",
							"@export var size: int = 3",
							"",
							"const TABLE = [",
							'\t"a",',
							'\t"b",',
							"]",
							"",
							'@rpc("any_peer")',
							"func area(",
							"\tscale: int, # wide",
							"\tbias: int,",
							") -> int:",
							"\treturn scale + bias",
							"",
							"signal changed(value: int)",
							"",
						].join("\n"),
					},
					subject: "header.gd",
					declarations: signatures({
						Box: "class_name Box",
						size: "@export var size: int = 3",
						TABLE: `const TABLE = ${fold("[", "]")}`,
						area: '@rpc("any_peer") func area(scale: int, bias: int) -> int:',
						changed: "signal changed(value: int)",
					}),
				},
				[BASH]: {
					files: {
						"header.sh": [
							"#!/bin/bash",
							"# Doc.",
							"TABLE=(",
							"  a",
							"  b",
							")",
							'NAME="x"',
							"",
							"add() {",
							'  echo "$1"',
							"}",
							"",
							"function greet {",
							"  echo hi",
							"}",
							"",
						].join("\n"),
					},
					subject: "header.sh",
					declarations: signatures({
						TABLE: `TABLE=${fold("(", ")")}`,
						NAME: 'NAME="x"',
						add: "add()",
						greet: "function greet",
					}),
				},
			},
		},
		{
			id: "body-declarations-are-local",
			tier: "declarations",
			about: "A declaration written in a running body is local, however deep the body sits in an initializer, so an outline never lists it.",
			fixtures: {
				[TYPESCRIPT]: {
					files: {
						"src/locals.ts": [
							"export const CATALOG = [",
							"\t{",
							"\t\trun: async () => {",
							"\t\t\tconst result = 1;",
							"\t\t\treturn result;",
							"\t\t},",
							"\t},",
							"];",
							"",
							"export function outer() {",
							"\tconst inner = 2;",
							"\tclass Local {",
							"\t\tmethod() {}",
							"\t}",
							"\treturn inner;",
							"}",
							"",
						].join("\n"),
					},
					subject: "src/locals.ts",
					declarations: [
						...locals(["result", "inner", "Local"]),
						{ name: "CATALOG", visibility: "public" },
						{ name: "outer", visibility: "public" },
					],
				},
				[PYTHON]: {
					files: {
						"src/locals.py": [
							"def outer():",
							"    def inner():",
							"        return 1",
							"",
							"    class Local:",
							"        pass",
							"",
							"    return inner",
							"",
						].join("\n"),
					},
					subject: "src/locals.py",
					declarations: locals(["inner", "Local"]),
				},
				[C]: {
					files: { "src/locals.c": "int add(int left)\n{\n\tint sum = left + 1;\n\treturn sum;\n}\n" },
					subject: "src/locals.c",
					declarations: locals(["sum"]),
				},
				[CPP]: {
					files: { "src/locals.cpp": "int add(int left)\n{\n\tint sum = left + 1;\n\treturn sum;\n}\n" },
					subject: "src/locals.cpp",
					declarations: locals(["sum"]),
				},
				[CSHARP]: {
					files: {
						"src/Locals.cs":
							"public class Box\n{\n\tpublic int Area()\n\t{\n\t\tvar inner = 1;\n\t\treturn inner;\n\t}\n}\n",
					},
					subject: "src/Locals.cs",
					declarations: locals(["inner"]),
				},
				[RUST]: {
					files: { "src/locals.rs": "pub fn add(left: i32) -> i32 {\n    let sum = left + 1;\n    sum\n}\n" },
					subject: "src/locals.rs",
					declarations: locals(["sum"]),
				},
				[KOTLIN]: {
					files: {
						"src/geo/Locals.kt":
							"package geo\n\nfun area(): Int {\n    val inner = 1\n    return inner\n}\n",
					},
					subject: "src/geo/Locals.kt",
					declarations: locals(["inner"]),
				},
				[GDSCRIPT]: {
					files: { "locals.gd": "func area() -> int:\n\tvar inner = 1\n\treturn inner\n" },
					subject: "locals.gd",
					declarations: locals(["inner"]),
				},
				[BASH]: {
					files: { "locals.sh": 'add() {\n  local sum=1\n  echo "$sum"\n}\n' },
					subject: "locals.sh",
					declarations: locals(["sum"]),
				},
			},
		},
	];
}
