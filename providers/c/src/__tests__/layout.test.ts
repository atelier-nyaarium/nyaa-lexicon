import { describe, expect, test } from "bun:test";
import { CProvider } from "../main.js";
import { parseC } from "../parser.js";

/** Facts as the wire delivers them. */
function wire(text: string) {
	const module = "layout.c";
	return new CProvider().parseFile({ module, contentHash: "hash", text }, parseC(module, text));
}

describe("C comment trivia", () => {
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
			"int f; // spliced \\",
			"int g;",
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
			["// spliced \\\nint g;", true, false],
		]);
	});

	test("a byte order mark is not code before a comment", () => {
		expect(parseC("bom.c", `${String.fromCodePoint(0xfeff)}// note\nint a;\n`).comments).toMatchObject([
			{ text: "// note", codeBefore: false, codeAfter: false },
		]);
	});
});

describe("C blank lines", () => {
	test("a line inside a comment, a spliced string or a removed branch is not blank", () => {
		const text = [
			"int a = 1;",
			"",
			"/* a",
			"",
			"b */",
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

		expect(wire(text).blankLines).toEqual([1, 9, 12]);
	});

	test("the empty remainder after a final line break is not a line", () => {
		expect(parseC("end.c", "int a;\n").blankLines).toEqual([]);
		expect(parseC("end.c", "int a;\n\n").blankLines).toEqual([1]);
		expect(parseC("end.c", "int a;\n  ").blankLines).toEqual([1]);
		expect(parseC("end.c", "").blankLines).toEqual([]);
	});
});

describe("C member insertion", () => {
	test("an aggregate names its closing brace's line when the brace starts it, and nothing otherwise", () => {
		const text = [
			"struct Box {",
			"\tint a;",
			"\tint b;",
			"};",
			"union Cell {",
			"\tint i;",
			"\tfloat f;",
			"\t};",
			"enum Color {",
			"\tRED,",
			"\tGREEN",
			"};",
			"typedef struct {",
			"\tint x;",
			"} Point;",
			"struct Tight { int c; };",
			"struct Shared {",
			"\tint d; };",
			"struct Noted {",
			"\tint e;",
			"/* end */ };",
			"struct Forward;",
		].join("\n");
		const lines = new Map(
			wire(text)
				.declarations.filter((declaration) => declaration.containerId === undefined)
				.map((declaration) => [declaration.name, declaration.memberInsertLine]),
		);

		expect(Object.fromEntries(lines)).toEqual({
			Box: 3,
			Cell: 7,
			Color: 11,
			Point: 14,
			Tight: undefined,
			Shared: undefined,
			Noted: undefined,
			Forward: undefined,
		});
	});
});
