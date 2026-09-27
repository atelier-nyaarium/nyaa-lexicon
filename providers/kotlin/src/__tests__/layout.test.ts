import { describe, expect, test } from "bun:test";
import { parseKotlin } from "../parse.js";

/** Kotlin's template opener, stored apart from TypeScript placeholders. */
const D = "$";

function trivia(text: string): Array<[string, boolean | undefined, boolean | undefined]> {
	return parseKotlin("Trivia.kt", text).comments.map((item) => [item.text, item.codeBefore, item.codeAfter]);
}

function blank(text: string): number[] | undefined {
	return parseKotlin("Blank.kt", text).blankLines;
}

/** Every declaration's name and insertion line, null when absent. */
function insertLines(text: string): Array<[string, number | null]> {
	return parseKotlin("Members.kt", text).declarations.map((item) => [item.name, item.memberInsertLine ?? null]);
}

describe("comment trivia", () => {
	test("each comment says whether code shares its first line before it and its last line after it", () => {
		expect(
			trivia(
				[
					"// own",
					"val a = 1 // trailing",
					"val b = /* both */ 2",
					"/* before */ val c = 3",
					"/* a */ // b",
					"val d = 4 /* x */ // y",
					"/* one",
					"   two */",
					"val e = 5 /* three",
					" four */ val f = 6",
					`val s = "${D}{ 1 /* in */ }"`,
					"/** doc */",
					"fun g() = 1",
				].join("\n"),
			),
		).toEqual([
			["// own", false, false],
			["// trailing", true, false],
			["/* both */", true, true],
			["/* before */", false, true],
			["/* a */", false, false],
			["// b", false, false],
			["/* x */", true, false],
			["// y", true, false],
			["/* one\n   two */", false, false],
			["/* three\n four */", true, true],
			["/* in */", true, true],
			["/** doc */", false, false],
		]);
	});

	test("an unclosed block after code on its line has code before it and none after", () => {
		expect(trivia("val a = 1 /* open\nval b = 2\n")).toEqual([["/* open\nval b = 2\n", true, false]]);
		expect(trivia("val a = 1\n/* open\n")).toEqual([["/* open\n", false, false]]);
	});
});

describe("blank lines", () => {
	test("a line inside a raw string, a template or a nested block comment is not blank", () => {
		expect(
			blank(
				[
					"val a = 1",
					"",
					'val raw = """one',
					"",
					'two"""',
					'val t = """x',
					"",
					`${D}{a}`,
					"",
					'y"""',
					"/* outer /* inner",
					"",
					"*/ still */",
					"/**",
					"",
					" */",
					"val b = 2",
					"",
				].join("\n"),
			),
		).toEqual([1]);
	});

	test("a hidden semicolon touches its line, a final line break ends the last line, and CRLF counts once", () => {
		expect(blank("class C {\n  val b = 2\n  ;\n\n}\n")).toEqual([3]);
		expect(blank("val a = 1\r\n\r\nval b = 2\r\n")).toEqual([1]);
		expect(blank("val a = 1\n  ")).toEqual([1]);
		expect(blank("\n")).toEqual([0]);
		expect(blank("")).toEqual([]);
	});

	test("an unclosed block comment touches every line to the end", () => {
		expect(blank("val a = 1\n\n/* never\n\nclosed\n")).toEqual([1]);
	});

	test("an outline reports none", () => {
		expect(parseKotlin("Outline.kt", "val a = 1\n\nval b = 2\n", true).blankLines).toBeUndefined();
	});
});

describe("member insertion", () => {
	test("each container names its closing line when the closer starts it", () => {
		expect(
			insertLines(
				[
					"class Box {",
					"    val a = 1",
					"    fun b() {}",
					"}",
					"object Single {",
					"    val c = 1",
					"    }",
					"interface Shape {",
					"    fun area(): Int",
					"}",
					"enum class Color {",
					"    RED,",
					"    GREEN {",
					'        override fun toString() = "g"',
					"    };",
					"    fun hex() = 0",
					"}",
					"class Host {",
					"    companion object {",
					"        const val K = 1",
					"    }",
					"}",
					"",
				].join("\n"),
			),
		).toEqual([
			["Box", 3],
			["a", null],
			["b", null],
			["Single", 6],
			["c", null],
			["Shape", 9],
			["area", null],
			["Color", 16],
			["RED", null],
			["GREEN", 14],
			["toString", null],
			["hex", null],
			["Host", 21],
			["Companion", 20],
			["K", null],
		]);
	});

	test("a closer sharing its line with a member or a comment, or no body, leaves no safe point", () => {
		expect(
			insertLines(
				[
					"class Tight { val c = 1 }",
					"class Shared {",
					"    val d = 1 }",
					"class Noted {",
					"    val e = 1",
					"    /* last */ }",
					"class Empty {}",
					"class Bare",
					"",
				].join("\n"),
			),
		).toEqual([
			["Tight", null],
			["c", null],
			["Shared", null],
			["d", null],
			["Noted", null],
			["e", null],
			["Empty", null],
			["Bare", null],
		]);
	});
});
