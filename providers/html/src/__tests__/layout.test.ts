import { describe, expect, it } from "bun:test";
import { HtmlProvider } from "../main.js";

////////////////////////////////
//  Helpers

function parse(text: string, depth?: "outline") {
	return new HtmlProvider().parseFile({
		module: "a.html",
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
	it("reads tags and non-whitespace text as code, and whitespace text and comments as none", () => {
		const text = [
			"<!DOCTYPE html> <!-- after the doctype -->",
			"<!-- own -->",
			"<div>",
			"\t<a></a> <!-- trailing -->",
			"\t<b></b> <!-- inline --> <i></i>",
			"\t<!-- first --> <!-- second --> <p></p>",
			"\t<span>words <!-- after text --></span>",
			"\t<!-- multi",
			"\tline --> <p></p>",
			"</div>",
			"",
		].join("\n");
		expect(trivia(text)).toEqual([
			["<!-- after the doctype -->", true, false],
			["<!-- own -->", false, false],
			["<!-- trailing -->", true, false],
			["<!-- inline -->", true, true],
			["<!-- first -->", false, true],
			["<!-- second -->", false, true],
			["<!-- after text -->", true, true],
			["<!-- multi\n\tline -->", false, true],
		]);
	});

	it("cuts whitespace text that parse5 merged across later tags and comments", () => {
		const text = "<html><body><p>x</p>\n</body>\n</html>\n<!-- after -->\n";
		expect(trivia(text)).toEqual([["<!-- after -->", false, false]]);
		expect(parse(text).blankLines).toEqual([]);
	});

	it("reports neither template comments nor CDATA read as one, yet touches their lines", () => {
		const text = "<template><!-- a\n\nb --></template>\n<div><![CDATA[x\n\ny]]></div>\n";
		const facts = parse(text);
		expect(facts.comments).toEqual([]);
		expect(facts.blankLines).toEqual([]);
	});
});

describe("blank lines", () => {
	it("counts a line inside any multi-line token as touched", () => {
		const text = [
			"<div",
			"",
			'\tid="d">',
			"\t<!-- a",
			"",
			"\tb -->",
			"\t<p>one",
			"",
			"two</p>",
			"\t<script>",
			"let a = 1;",
			"",
			"let b;",
			"</script>",
			"\t<style>a {}",
			"",
			"b {}</style>",
			"\t<textarea>one",
			"",
			"two</textarea>",
			"\t<template><p>one",
			"",
			"two</p></template>",
			"",
			"</div>",
			"",
		].join("\n");
		expect(parse(text).blankLines).toEqual([23]);
	});

	it("leaves blank lines out of an outline, which carries no comments", () => {
		expect(parse("<p></p>\n\n", "outline").blankLines).toBeUndefined();
	});
});
