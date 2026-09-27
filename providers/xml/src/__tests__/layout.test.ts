import { describe, expect, it } from "bun:test";
import { XmlProvider } from "../main.js";

////////////////////////////////
//  Helpers

function parse(text: string, depth?: "outline") {
	return new XmlProvider().parseFile({
		module: "a.xml",
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
			'<?xml version="1.0"?> <!-- after the declaration -->',
			"<!-- own -->",
			"<root>",
			"\t<a/> <!-- trailing -->",
			"\t<b/> <!-- inline --> <c/>",
			"\t<!-- first --> <!-- second --> <d/>",
			"\t<e>words <!-- after text --></e>",
			"\t<!-- multi",
			"\tline --> <f/>",
			"\t<g>",
			"\t\t<!-- in an element -->",
			"\t</g>",
			"</root>",
			"",
		].join("\n");
		expect(trivia(text)).toEqual([
			["<!-- after the declaration -->", true, false],
			["<!-- own -->", false, false],
			["<!-- trailing -->", true, false],
			["<!-- inline -->", true, true],
			["<!-- first -->", false, true],
			["<!-- second -->", false, true],
			["<!-- after text -->", true, true],
			["<!-- multi\n\tline -->", false, true],
			["<!-- in an element -->", false, false],
		]);
	});

	it("reads a byte order mark as no code", () => {
		expect(trivia(`${String.fromCodePoint(0xfeff)}<!-- note -->\n<a/>\n`)).toEqual([
			["<!-- note -->", false, false],
		]);
	});
});

describe("blank lines", () => {
	it("counts a line inside any multi-line token as touched", () => {
		const text = [
			'<?xml version="1.0"?>',
			"",
			"<!DOCTYPE root [<!ENTITY e 'one",
			"",
			"two'>]>",
			"<root",
			"",
			'\ta="1">',
			"\t<!-- a",
			"",
			"\tb -->",
			"\t<t>one",
			"",
			"two</t>",
			"\t<![CDATA[one",
			"",
			"two]]>",
			"\t<?pi one",
			"",
			"two?>",
			"",
			"</root>",
			"",
		].join("\n");
		expect(parse(text).blankLines).toEqual([1, 20]);
	});

	it("reads white space between a document type's declarations as blank, as between elements", () => {
		expect(parse("<!DOCTYPE r [\n<!ENTITY a 'x'>\n\n<!-- b -->\n]>\n<r/>\n").blankLines).toEqual([2]);
	});

	it("counts every line of a whitespace file, and none of text that does not parse", () => {
		expect(parse("\n  \n").blankLines).toEqual([0, 1]);
		expect(parse("<a>\n\n").blankLines).toBeUndefined();
	});

	it("leaves blank lines out of an outline, which carries no comments", () => {
		expect(parse("<a/>\n\n", "outline").blankLines).toBeUndefined();
	});
});
