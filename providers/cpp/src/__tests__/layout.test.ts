import { describe, expect, test } from "bun:test";
import { ANONYMOUS_NAMESPACE } from "@nyaa-lexicon/protocol";
import { CppProvider } from "../main.js";
import { parseCppFile } from "../parser.js";

/** Facts as the wire delivers them. */
function wire(text: string) {
	const module = "layout.cpp";
	return new CppProvider().parseFile({ module, contentHash: "hash", text }, parseCppFile(module, text));
}

describe("C++ comment trivia", () => {
	test("each comment says whether code shares its first line before it and its last line after it", () => {
		const text = [
			"// own line",
			"int a = 1; // trailing",
			"int b = /* inline */ 2;",
			"/* a */ // b",
			"/* before */ int c = 3;",
			"int d = 4; /* spans",
			"lines */ int e = 5;",
			"/* alone",
			"*/",
			'const char *r = R"(// not one)"; // after raw',
		].join("\n");

		expect(wire(text).comments.map((comment) => [comment.text, comment.codeBefore, comment.codeAfter])).toEqual([
			["// own line", false, false],
			["// trailing", true, false],
			["/* inline */", true, true],
			["/* a */", false, false],
			["// b", false, false],
			["/* before */", false, true],
			["/* spans\nlines */", true, true],
			["/* alone\n*/", false, false],
			["// after raw", true, false],
		]);
	});

	test("a byte order mark is not code before a comment", () => {
		expect(parseCppFile("bom.cpp", `${String.fromCodePoint(0xfeff)}// note\nint a;\n`).comments).toMatchObject([
			{ text: "// note", codeBefore: false, codeAfter: false },
		]);
	});
});

describe("C++ blank lines", () => {
	test("a line inside a raw string, a comment, a splice or a removed branch is not blank", () => {
		const text = [
			"int a = 1;",
			"",
			'const char *raw = R"(one',
			"",
			'two)";',
			"/* a",
			"",
			"b */",
			"#define TWO \\",
			"\\",
			"\t2",
			'const char *s = "one\\',
			'two";',
			"// note \\",
			"still note",
			"",
			"#if 0",
			"int gone;",
			"",
			"#endif",
			"int b = 2;",
			"",
		].join("\n");

		expect(wire(text).blankLines).toEqual([1, 15, 18]);
	});

	test("the empty remainder after a final line break is not a line", () => {
		expect(parseCppFile("end.cpp", "int a;\n").blankLines).toEqual([]);
		expect(parseCppFile("end.cpp", "int a;\n\n").blankLines).toEqual([1]);
		expect(parseCppFile("end.cpp", "int a;\n  ").blankLines).toEqual([1]);
		expect(parseCppFile("end.cpp", "").blankLines).toEqual([]);
	});
});

describe("C++ member insertion", () => {
	test("a container names its closing brace's line when the brace starts it, and nothing otherwise", () => {
		const text = [
			"namespace outer::inner {",
			"class Box {",
			"public:",
			"\tint a;",
			"\tint b() { return 1; }",
			"};",
			"struct Pair {",
			"\tint x;",
			"\t};",
			"union Cell {",
			"\tint i;",
			"};",
			"enum class Color {",
			"\tRed,",
			"\tGreen",
			"};",
			"struct Tight { int c; };",
			"class Shared {",
			"\tint d; };",
			"class Noted {",
			"\tint e;",
			"/* end */ };",
			"class Forward;",
			"}",
			"namespace {",
			"int hidden;",
			"}",
		].join("\n");
		const containers = wire(text).declarations.filter((declaration) =>
			["namespace", "class", "struct", "enum"].includes(declaration.kind),
		);

		expect(
			Object.fromEntries(containers.map((declaration) => [declaration.name, declaration.memberInsertLine])),
		).toEqual({
			outer: 23,
			inner: 23,
			Box: 5,
			Pair: 8,
			Cell: 11,
			Color: 15,
			Tight: undefined,
			Shared: undefined,
			Noted: undefined,
			Forward: undefined,
			[ANONYMOUS_NAMESPACE]: 26,
		});
	});
});
