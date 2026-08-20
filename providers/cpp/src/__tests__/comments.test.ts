import { coordinatesOf, FileFactsSchema } from "@nyaa-lexicon/protocol";
import { describe, expect, test } from "vitest";
import { CppProvider, TIERS } from "../main.js";
import { parseCppFile } from "../parser.js";

function commentTexts(text: string, module = "comments.cpp"): string[] {
	return parseCppFile(module, text).comments.map((comment) => comment.text);
}

describe("C++ comment spans", () => {
	test("reports every comment form the language has, in source order", () => {
		const text =
			"// leading\n/// doc line\n/** doc block */\nint work(int first /* inline */, int second) {\n\treturn first + second; // trailing\n}\n\n/* standalone */\n";

		expect(commentTexts(text)).toEqual([
			"// leading",
			"/// doc line",
			"/** doc block */",
			"/* inline */",
			"// trailing",
			"/* standalone */",
		]);
	});

	test("keeps the text verbatim, without trimming or stripping markers", () => {
		expect(commentTexts("//  padded  \nint value = 1;\n")).toEqual(["//  padded  "]);
		expect(commentTexts("/*\n\tindented body\n*/\nint value = 1;\n")).toEqual(["/*\n\tindented body\n*/"]);
	});

	test("reports a comment on a preprocessor line and still reports the include", () => {
		const facts = parseCppFile("include.cpp", '#include "api.hpp" // needed\nint value = 1;\n');

		expect(facts.comments.map((comment) => comment.text)).toEqual(["// needed"]);
		expect(facts.imports.map((item) => item.specifier)).toEqual(["api.hpp"]);
	});

	test("does not report a marker inside a string, a character, or a raw string", () => {
		const text =
			'const char *url = "https://example.com/path";\nconst char *block = "/* not a comment */";\nchar slash = \'/\';\nconst char *raw = R"(// not a comment)";\n// real\n';

		expect(commentTexts(text, "markers.cpp")).toEqual(["// real"]);
	});

	test("does not report a marker inside a delimited raw string", () => {
		const text = 'const char *raw = R"tag(/* not a comment */ // nor this)tag";\n/* real */\n';

		expect(commentTexts(text)).toEqual(["/* real */"]);
	});

	test("reports an unterminated block comment as one span running to end of file", () => {
		const facts = parseCppFile("open.cpp", "int before = 1;\n/* opened and never closed");

		expect(facts.comments.map((comment) => comment.text)).toEqual(["/* opened and never closed"]);
		expect(facts.declarations.some((declaration) => declaration.name === "before")).toBe(true);
	});

	test("ends an unnested block at the first close and lets code resume after it", () => {
		const facts = parseCppFile("nest.cpp", "/* outer /* inner */\nint after = 1;\n");

		expect(facts.comments.map((comment) => comment.text)).toEqual(["/* outer /* inner */"]);
		expect(facts.declarations.some((declaration) => declaration.name === "after")).toBe(true);
	});

	test("carries a range that slices back to the same text past an astral character", () => {
		const text = 'const char *emoji = "\u{1F600}"; // after emoji\n/* second\n  line */\n';
		const coordinates = coordinatesOf(text);
		const comments = parseCppFile("astral.cpp", text).comments;

		expect(comments.map((comment) => comment.text)).toEqual(["// after emoji", "/* second\n  line */"]);
		for (const comment of comments) {
			expect(coordinates.sliceRange(comment.range)).toBe(comment.text);
		}
	});

	test("leaves a CRLF carriage return out of a line comment, so the range still addresses the text", () => {
		const text = "// first\r\nint value = 1; /* second */\r\n";
		const coordinates = coordinatesOf(text);
		const comments = parseCppFile("crlf.cpp", text).comments;

		expect(comments.map((comment) => comment.text)).toEqual(["// first", "/* second */"]);
		for (const comment of comments) {
			expect(coordinates.sliceRange(comment.range)).toBe(comment.text);
		}
	});

	test("keeps a lone carriage return, which no line terminator claims", () => {
		expect(commentTexts("// first\rsecond\nint value = 1;\n")).toEqual(["// first\rsecond"]);
	});

	test("declares the comments tier and answers parseFile with the spans", () => {
		const provider = new CppProvider();
		const text = "// header\nint value = 1;\n";
		const facts = FileFactsSchema.parse(provider.parseFile({ module: "source.cpp", contentHash: "source", text }));

		expect(TIERS.comments).toBe(true);
		expect(facts.comments).toEqual([
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, text: "// header" },
		]);
	});

	test("reports no comments for a file that has none", () => {
		expect(commentTexts('int value = 1;\nconst char *text = "no markers here";\n')).toEqual([]);
	});
});
