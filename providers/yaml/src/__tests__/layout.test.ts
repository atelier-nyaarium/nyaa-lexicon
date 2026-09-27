import { describe, expect, it } from "bun:test";
import { YamlProvider } from "../main.js";

////////////////////////////////
//  Helpers

function parse(text: string, depth?: "outline") {
	return new YamlProvider().parseFile({
		module: "a.yml",
		contentHash: "h",
		text,
		...(depth === undefined ? {} : { depth }),
	});
}

/** Each comment's text with whether code shares its first line before it and its last line after it. */
function trivia(text: string): Array<[string, boolean | undefined, boolean | undefined]> {
	return parse(text).comments.map((comment) => [comment.text, comment.codeBefore, comment.codeAfter]);
}

////////////////////////////////
//  Tests

describe("comment trivia", () => {
	it("says whether code shares each comment's line", () => {
		const text = [
			"# own",
			"--- # after a marker",
			"a: 1 # trailing",
			"b:",
			"  # indented",
			"  c: [1, # in a flow",
			"    2]",
			"s: | # after a header",
			"  # content, not a comment",
			"",
		].join("\n");
		expect(trivia(text)).toEqual([
			["# own", false, false],
			["# after a marker", true, false],
			["# trailing", true, false],
			["# indented", false, false],
			["# in a flow", true, false],
			["# after a header", true, false],
		]);
	});

	it("reads a byte order mark as no code", () => {
		expect(trivia(`${String.fromCodePoint(0xfeff)}# note\na: 1\n`)).toEqual([["# note", false, false]]);
	});
});

describe("blank lines", () => {
	it("counts a line inside any multi-line scalar as touched", () => {
		const text = [
			"a: 1",
			"",
			"literal: |",
			"  one",
			"",
			"  two",
			"folded: >",
			"  one",
			"",
			"  two",
			"single: 'one",
			"",
			"  two'",
			'double: "one',
			"",
			'  two"',
			"plain: one",
			"",
			"  two",
			"",
			"b: 2",
			"",
		].join("\n");
		expect(parse(text).blankLines).toEqual([1, 19]);
	});

	it("counts a comment's line as touched, and never the remainder after a final line break", () => {
		expect(parse("# a\n\nb: 1\n\n").blankLines).toEqual([1, 3]);
		expect(parse("").blankLines).toEqual([]);
	});

	it("leaves blank lines out of an outline, which carries no comments", () => {
		expect(parse("a: 1\n\n", "outline").blankLines).toBeUndefined();
	});
});
