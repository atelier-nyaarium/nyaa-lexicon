import { describe, expect, it } from "bun:test";
import { JsonProvider } from "../main.js";

////////////////////////////////
//  Helpers

function parse(module: string, text: string, depth?: "outline") {
	return new JsonProvider().parseFile({ module, contentHash: "h", text, ...(depth === undefined ? {} : { depth }) });
}

/** Comment text and code sharing its first line before and last line after. */
function trivia(module: string, text: string): Array<[string, boolean | undefined, boolean | undefined]> {
	return parse(module, text).comments.map((comment) => [comment.text, comment.codeBefore, comment.codeAfter]);
}

////////////////////////////////
//  Tests

describe("comment trivia", () => {
	it("says whether code shares each comment's lines, comments not counting as code", () => {
		const text = [
			"// own",
			"{",
			'\t"a": 1, // trailing',
			'\t"b": /* inline */ 2,',
			'\t/* first */ /* second */ "c": 3,',
			'\t"d": 4 /* x */ /* y */',
			"\t/* multi",
			'\tline */ "e": 5,',
			'\t"f": /* open',
			"\tclose */",
			"\t6",
			"}",
			"",
		].join("\n");
		expect(trivia("a.jsonc", text)).toEqual([
			["// own", false, false],
			["// trailing", true, false],
			["/* inline */", true, true],
			["/* first */", false, true],
			["/* second */", false, true],
			["/* x */", true, false],
			["/* y */", true, false],
			["/* multi\n\tline */", false, true],
			["/* open\n\tclose */", true, false],
		]);
	});

	it("reads a byte order mark as no code", () => {
		expect(trivia("a.jsonc", `${String.fromCodePoint(0xfeff)}// note\n{}\n`)).toEqual([["// note", false, false]]);
	});

	it("reads each record of a line-delimited file on its own line", () => {
		expect(trivia("log.jsonl", '{"a": 1} // one\n// two\n')).toEqual([
			["// one", true, false],
			["// two", false, false],
		]);
	});
});

describe("blank lines", () => {
	it("counts a line inside a block comment as touched", () => {
		const text = '{\n\t"a": 1,\n\n\t/* a\n\n\tb */\n\t"b": 2\n}\n';
		expect(parse("a.jsonc", text).blankLines).toEqual([2]);
	});

	it("reports blank record lines, and never the remainder after a final line break", () => {
		expect(parse("log.jsonl", '{"a": 1}\n\n  \n{"a": 2}\n').blankLines).toEqual([1, 2]);
		expect(parse("log.jsonl", '{"a": 1}\n  ').blankLines).toEqual([1]);
		expect(parse("a.json", "{}\n\n").blankLines).toEqual([1]);
		expect(parse("a.json", "").blankLines).toEqual([]);
	});

	it("leaves blank lines out of an outline, which carries no comments", () => {
		expect(parse("a.json", "{}\n\n", "outline").blankLines).toBeUndefined();
	});
});
