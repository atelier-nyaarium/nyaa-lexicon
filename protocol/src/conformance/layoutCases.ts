// Per-language layout facts for comment adjacency, blank lines, and member insertion.
// Core uses them without reading nearby source text.

import type { ConformanceCase, ConformanceFixture, ExpectedTrivia } from "./types.js";

////////////////////////////////
//  Constants

const REFERENCE = "reference";
const TYPESCRIPT = "typescript";
const PYTHON = "python";
const GDSCRIPT = "gdscript";
const C = "c";
const CPP = "cpp";
const CSHARP = "csharp";
const RUST = "rust";
const KOTLIN = "kotlin";
const JSON_LANG = "json";
const YAML = "yaml";
const XML = "xml";
const HTML = "html";
const BASH = "bash";
const POWERSHELL = "powershell";

////////////////////////////////
//  Functions & Helpers

function lines(...text: string[]): string {
	return `${text.join("\n")}\n`;
}

function file(subject: string, text: string): Pick<ConformanceFixture, "files" | "subject"> {
	return { files: { [subject]: text }, subject };
}

/** Comment cases: standalone and trailing; block comments may also precede or sit between code. */
function trivia(own: string, trailing: string, both?: string, before?: string): ExpectedTrivia[] {
	const found: ExpectedTrivia[] = [
		{ comment: own, codeBefore: false, codeAfter: false },
		{ comment: trailing, codeBefore: true, codeAfter: false },
	];
	if (both !== undefined) found.push({ comment: both, codeBefore: true, codeAfter: true });
	if (before !== undefined) found.push({ comment: before, codeBefore: false, codeAfter: true });
	return found;
}

const SLASH = trivia("// own line", "// trailing", "/* both */", "/* before */");
const HASH = trivia("# own line", "# trailing");
const HASH_BLOCK = trivia("# own line", "# trailing", "<# both #>", "<# before #>");
const MARKUP = trivia("<!-- own line -->", "<!-- trailing -->", "<!-- both -->", "<!-- before -->");

////////////////////////////////
//  Cases

export function layoutCases(): ConformanceCase[] {
	return [
		{
			id: "a-comment-says-whether-code-shares-its-lines",
			tier: "comments",
			about: "Each comment says whether code shares its first line before it and its last line after it. Core attaches a leading comment from these alone.",
			fixtures: {
				[TYPESCRIPT]: {
					...file(
						"src/trivia.ts",
						lines(
							"// own line",
							"export const a = 1; // trailing",
							"export const b = /* both */ 2;",
							"/* before */ export const c = 3;",
						),
					),
					commentTrivia: SLASH,
				},
				[REFERENCE]: {
					...file(
						"src/trivia.ref",
						lines(
							"// own line",
							"export const a = 1; // trailing",
							"export const b = /* both */ 2;",
							"/* before */ export const c = 3;",
						),
					),
					commentTrivia: SLASH,
				},
				[C]: {
					...file(
						"src/trivia.c",
						lines(
							"// own line",
							"int a = 1; // trailing",
							"int b = /* both */ 2;",
							"/* before */ int c = 3;",
						),
					),
					commentTrivia: SLASH,
				},
				[CPP]: {
					...file(
						"src/trivia.cpp",
						lines(
							"// own line",
							"int a = 1; // trailing",
							"int b = /* both */ 2;",
							"/* before */ int c = 3;",
						),
					),
					commentTrivia: SLASH,
				},
				[CSHARP]: {
					...file(
						"src/Trivia.cs",
						lines(
							"// own line",
							"public class Trivia {",
							"\tpublic int A = 1; // trailing",
							"\tpublic int B = /* both */ 2;",
							"\t/* before */ public int C = 3;",
							"}",
						),
					),
					commentTrivia: SLASH,
				},
				[RUST]: {
					...file(
						"src/trivia.rs",
						lines(
							"// own line",
							"pub const A: i32 = 1; // trailing",
							"pub const B: i32 = /* both */ 2;",
							"/* before */ pub const C: i32 = 3;",
						),
					),
					commentTrivia: SLASH,
				},
				[KOTLIN]: {
					...file(
						"src/Trivia.kt",
						lines("// own line", "val a = 1 // trailing", "val b = /* both */ 2", "/* before */ val c = 3"),
					),
					commentTrivia: SLASH,
				},
				[JSON_LANG]: {
					...file(
						"trivia.jsonc",
						lines(
							"// own line",
							"{",
							'\t"a": 1, // trailing',
							'\t"b": /* both */ 2,',
							'\t/* before */ "c": 3',
							"}",
						),
					),
					commentTrivia: SLASH,
				},
				[PYTHON]: { ...file("src/trivia.py", lines("# own line", "a = 1  # trailing")), commentTrivia: HASH },
				[GDSCRIPT]: {
					...file("src/trivia.gd", lines("# own line", "var a = 1 # trailing")),
					commentTrivia: HASH,
				},
				[BASH]: { ...file("src/trivia.sh", lines("# own line", "a=1 # trailing")), commentTrivia: HASH },
				[POWERSHELL]: {
					...file(
						"src/trivia.ps1",
						lines("# own line", "$a = 1 # trailing", "$b = <# both #> 2", "<# before #> $c = 3"),
					),
					commentTrivia: HASH_BLOCK,
				},
				[YAML]: { ...file("trivia.yml", lines("# own line", "a: 1 # trailing")), commentTrivia: HASH },
				[XML]: {
					...file(
						"trivia.xml",
						lines(
							"<!-- own line -->",
							"<root>",
							"\t<a/> <!-- trailing -->",
							"\t<b/> <!-- both --> <c/>",
							"\t<!-- before --> <d/>",
							"</root>",
						),
					),
					commentTrivia: MARKUP,
				},
				[HTML]: {
					...file(
						"trivia.html",
						lines(
							"<!-- own line -->",
							"<div>",
							"\t<a></a> <!-- trailing -->",
							"\t<b></b> <!-- both --> <i></i>",
							"\t<!-- before --> <p></p>",
							"</div>",
						),
					),
					commentTrivia: MARKUP,
				},
			},
		},
		{
			id: "a-blank-line-is-one-no-token-touches",
			tier: "comments",
			about: "A blank line is one no token touches. A line inside a string, a block comment, a here-document or a block scalar is not blank, whatever it holds.",
			fixtures: {
				[TYPESCRIPT]: {
					...file(
						"src/blank.ts",
						lines(
							"export const a = 1;",
							"",
							"export const s = `one",
							"",
							"two`;",
							"/* a",
							"",
							"b */",
							"export const b = 2;",
						),
					),
					blankLines: [1],
				},
				[REFERENCE]: {
					...file(
						"src/blank.ref",
						lines(
							"export const a = 1;",
							"",
							"export const s = `one",
							"",
							"two`;",
							"/* a",
							"",
							"b */",
							"export const b = 2;",
						),
					),
					blankLines: [1],
				},
				[PYTHON]: {
					...file("src/blank.py", lines("a = 1", "", 's = """one', "", 'two"""', "b = 2")),
					blankLines: [1],
				},
				[GDSCRIPT]: {
					...file("src/blank.gd", lines("var a = 1", "", 'var s = """one', "", 'two"""', "var b = 2")),
					blankLines: [1],
				},
				[C]: {
					...file("src/blank.c", lines("int a = 1;", "", "/* a", "", "b */", "int b = 2;")),
					blankLines: [1],
				},
				[CPP]: {
					...file(
						"src/blank.cpp",
						lines(
							"int a = 1;",
							"",
							'const char *s = R"(one',
							"",
							'two)";',
							"/* a",
							"",
							"b */",
							"int b = 2;",
						),
					),
					blankLines: [1],
				},
				[CSHARP]: {
					...file(
						"src/Blank.cs",
						lines(
							"public class Blank {",
							"\tpublic int A = 1;",
							"",
							'\tpublic string S = @"one',
							"",
							'two";',
							"\t/* a",
							"",
							"\tb */",
							"\tpublic int B = 2;",
							"}",
						),
					),
					blankLines: [2],
				},
				[RUST]: {
					...file(
						"src/blank.rs",
						lines(
							"pub const A: i32 = 1;",
							"",
							'pub const S: &str = "one',
							"",
							'two";',
							"/* a",
							"",
							"b */",
							"pub const B: i32 = 2;",
						),
					),
					blankLines: [1],
				},
				[KOTLIN]: {
					...file(
						"src/Blank.kt",
						lines("val a = 1", "", 'val s = """one', "", 'two"""', "/* a", "", "b */", "val b = 2"),
					),
					blankLines: [1],
				},
				[BASH]: {
					...file(
						"src/blank.sh",
						lines("a=1", "", "s='one", "", "two'", "cat <<EOF", "x", "", "y", "EOF", "b=2"),
					),
					blankLines: [1],
				},
				[POWERSHELL]: {
					...file(
						"src/blank.ps1",
						lines(
							"$a = 1",
							"",
							"$s = 'one",
							"",
							"two'",
							'$h = @"',
							"x",
							"",
							"y",
							'"@',
							"<# a",
							"",
							"b #>",
							"$b = 2",
						),
					),
					blankLines: [1],
				},
				[JSON_LANG]: {
					...file("blank.jsonc", lines("{", '\t"a": 1,', "", "\t/* a", "", "\tb */", '\t"b": 2', "}")),
					blankLines: [2],
				},
				[YAML]: {
					...file("blank.yml", lines("a: 1", "", "s: |", "  one", "", "  two", "b: 2")),
					blankLines: [1],
				},
				[XML]: {
					...file(
						"blank.xml",
						lines("<root>", "\t<a/>", "", "\t<!-- a", "", "\tb -->", "\t<b>one", "", "two</b>", "</root>"),
					),
					blankLines: [2],
				},
				[HTML]: {
					...file(
						"blank.html",
						lines("<div>", "\t<a></a>", "", "\t<!-- a", "", "\tb -->", "\t<p>one", "", "two</p>", "</div>"),
					),
					blankLines: [2],
				},
			},
		},
		{
			id: "a-container-names-where-a-member-after-its-last-goes",
			tier: "declarations",
			about: "A container names the line a member after its last one goes on: its closing token's line when that token starts the line, or the line after its last statement. A closer sharing a line with a member leaves no safe point.",
			fixtures: {
				[TYPESCRIPT]: {
					...file(
						"src/members.ts",
						lines("export class Box {", "\ta = 1;", "\tb(): void {}", "}", "export class Tight { c = 1; }"),
					),
					declarations: [
						{ name: "Box", memberInsertLine: 3 },
						{ name: "Tight", memberInsertLine: null },
					],
				},
				[PYTHON]: {
					...file(
						"src/members.py",
						lines(
							"class Box:",
							"    a = 1",
							"",
							"    def b(self):",
							"        return register(b,",
							"        )",
							"",
							"x = 1",
						),
					),
					declarations: [{ name: "Box", memberInsertLine: 6 }],
				},
				[GDSCRIPT]: {
					...file(
						"src/members.gd",
						lines("class Box:", "\tvar a = 1", "\tfunc b():", "\t\treturn [1,", "\t\t]", "", "var x = 1"),
					),
					declarations: [{ name: "Box", memberInsertLine: 5 }],
				},
				[C]: {
					...file(
						"src/members.c",
						lines("struct Box {", "\tint a;", "\tint b;", "};", "struct Tight { int c; };"),
					),
					declarations: [
						{ name: "Box", memberInsertLine: 3 },
						{ name: "Tight", memberInsertLine: null },
					],
				},
				[CPP]: {
					...file(
						"src/members.cpp",
						lines(
							"class Box {",
							"public:",
							"\tint a;",
							"\tint b() { return 1; }",
							"};",
							"struct Tight { int c; };",
						),
					),
					declarations: [
						{ name: "Box", memberInsertLine: 4 },
						{ name: "Tight", memberInsertLine: null },
					],
				},
				[CSHARP]: {
					...file(
						"src/Members.cs",
						lines(
							"public class Box {",
							"\tpublic int A;",
							"\tpublic void B() {",
							"\t}",
							"}",
							"public class Tight { public int C; }",
						),
					),
					declarations: [
						{ name: "Box", memberInsertLine: 4 },
						{ name: "Tight", memberInsertLine: null },
					],
				},
				[RUST]: {
					...file(
						"src/members.rs",
						lines(
							"pub struct Box {",
							"\tpub a: i32,",
							"\tpub b: i32,",
							"}",
							"pub struct Tight { pub c: i32 }",
						),
					),
					declarations: [
						{ name: "Box", memberInsertLine: 3 },
						{ name: "Tight", memberInsertLine: null },
					],
				},
				[KOTLIN]: {
					...file(
						"src/Members.kt",
						lines("class Box {", "\tval a = 1", "\tfun b() {}", "}", "class Tight { val c = 1 }"),
					),
					declarations: [
						{ name: "Box", memberInsertLine: 3 },
						{ name: "Tight", memberInsertLine: null },
					],
				},
			},
		},
	];
}
