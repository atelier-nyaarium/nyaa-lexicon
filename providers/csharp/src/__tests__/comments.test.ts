import { describe, expect, test } from "bun:test";
import { coordinatesOf, FileFactsSchema } from "@nyaa-lexicon/protocol";
import { CsharpProvider, TIERS } from "../main.js";
import { CsharpParser } from "../parser.js";
import { parseThroughKit, startProvider } from "./harness.js";

function parseCsharp(module: string, text: string) {
	return new CsharpParser(module, text).parse();
}

function commentTexts(text: string, module = "Comments.cs"): string[] {
	return parseCsharp(module, text).comments.map((comment) => comment.text);
}

describe("C# comment spans", () => {
	test("reports every comment form the language has, in source order", () => {
		const text = [
			"// leading",
			"/// doc line",
			"/** doc block */",
			"public class Comments {",
			"\tpublic int Work(int first /* inline */, int second) {",
			"\t\treturn first + second; // trailing",
			"\t}",
			"}",
			"",
			"/* standalone */",
			"",
		].join("\n");

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
		expect(commentTexts("//  padded  \npublic class C { }\n")).toEqual(["//  padded  "]);
		expect(commentTexts("///   padded doc\npublic class C { }\n")).toEqual(["///   padded doc"]);
		expect(commentTexts("/*\n\tindented body\n*/\npublic class C { }\n")).toEqual(["/*\n\tindented body\n*/"]);
	});

	test("does not report a marker inside a string, a character, a verbatim, interpolated or raw string", () => {
		const text = [
			"public class Markers {",
			'\tpublic string Url = "https://example.com/path";',
			'\tpublic string Block = "/* not a comment */";',
			'\tpublic string Verbatim = @"C:\\temp//path /* nor this */";',
			'\tpublic string Interpolated = $"value // {Url}";',
			'\tpublic string Raw = """// not a comment""";',
			'\tpublic string Longer = """"holds """ inside // not a comment"""";',
			"\tpublic char Slash = '/';",
			"}",
			"// real",
			"",
		].join("\n");
		const facts = parseCsharp("Markers.cs", text);

		expect(facts.diagnostics).toEqual([]);
		expect(facts.comments.map((comment) => comment.text)).toEqual(["// real"]);
	});

	test("reads a raw interpolated string's holes as code, as many braces deep as its dollars", () => {
		const text = [
			"public class Holes {",
			'\tpublic string One = $"""x {F(/* one */ 1)} y""";',
			'\tpublic string Two = $$"""{not a hole /* text */} {{G(/* two */ 2)}}""";',
			'\tpublic string Nested = $"""{H("""quoted // text""")} z""";',
			"}",
			"// real",
			"",
		].join("\n");
		const facts = parseCsharp("Holes.cs", text);

		expect(facts.diagnostics).toEqual([]);
		expect(facts.comments.map((comment) => comment.text)).toEqual(["/* one */", "/* two */", "// real"]);
		expect(facts.literals.map((literal) => literal.value)).toEqual([
			"x {F(/* one */ 1)} y",
			"1",
			"{not a hole /* text */} {{G(/* two */ 2)}}",
			"2",
			'{H("""quoted // text""")} z',
			"quoted // text",
		]);
	});

	test("reads a hole's format as text", () => {
		const text = [
			"public class Formats {",
			'\tpublic string Date = $"{when:yyyy//MM}";',
			'\tpublic string Raw = $"""{when:dd/*x*/}""";',
			'\tpublic string Grouped = $"{(a ? b : c) /* code */:N0}";',
			'\tpublic string Global = $"{global::System.Math.PI /* after alias */:F2}";',
			'\tpublic string Nested = $"{M(x: global::A.B) /* nested */}";',
			"}",
			"",
		].join("\n");
		const facts = parseCsharp("Formats.cs", text);

		expect(facts.diagnostics).toEqual([]);
		expect(facts.comments.map((comment) => comment.text)).toEqual([
			"/* code */",
			"/* after alias */",
			"/* nested */",
		]);
	});

	test("drops a hole's comment with the conditional branch that drops its string", () => {
		const text = [
			"public class Dropped {",
			"#if false",
			'\tpublic string Gone = $"{1 /* gone */}";',
			"#endif",
			'\tpublic string Kept = $"{2 /* kept */}";',
			"}",
			"",
		].join("\n");

		expect(commentTexts(text)).toEqual(["/* kept */"]);
	});

	test("reports a trailing comment on a directive whose body is tokens, never the directive", () => {
		const text = [
			"#define TRACE // why",
			'#line 5 "C:/gen//file.cs" // mapped',
			"#pragma warning disable CS0649 // never assigned",
			"#if TRACE // build only",
			"public class Debugged { }",
			"#endif",
			"",
		].join("\n");
		const facts = parseCsharp("Directives.cs", text);

		expect(facts.comments.map((comment) => comment.text)).toEqual([
			"// why",
			"// mapped",
			"// never assigned",
			"// build only",
		]);
		expect(facts.declarations.map((declaration) => declaration.name)).toContain("Debugged");
	});

	test("reports nothing from a directive whose body runs to the line end as text", () => {
		const text = [
			"#region Named // not a comment",
			"public class Region { }",
			"#endregion Named // nor this",
			"#warning stop at // this too",
			"",
		].join("\n");
		const facts = parseCsharp("Regions.cs", text);

		expect(facts.comments).toEqual([]);
		expect(facts.declarations.map((declaration) => declaration.name)).toContain("Region");
	});

	test("reports an unterminated block comment as one span running to end of file", () => {
		const facts = parseCsharp("Open.cs", "public class Open { }\n/* opened and never closed");

		expect(facts.comments.map((comment) => comment.text)).toEqual(["/* opened and never closed"]);
		expect(facts.declarations.some((declaration) => declaration.name === "Open")).toBe(true);
	});

	test("ends an unnested block at the first close and lets code resume after it", () => {
		const facts = parseCsharp("Nest.cs", "/* outer /* inner */\npublic class Nest { }\n");

		expect(facts.comments.map((comment) => comment.text)).toEqual(["/* outer /* inner */"]);
		expect(facts.declarations.some((declaration) => declaration.name === "Nest")).toBe(true);
	});

	test("carries a range that slices back to the same text past an astral character", () => {
		const text = 'public class Emoji { string Face = "\u{1F600}"; } // after emoji\n/* second\r\n  line */\n';
		const coordinates = coordinatesOf(text);
		const comments = parseCsharp("Emoji.cs", text).comments;

		expect(comments.map((comment) => comment.text)).toEqual(["// after emoji", "/* second\r\n  line */"]);
		for (const comment of comments) {
			expect(coordinates.sliceRange(comment.range)).toBe(comment.text);
		}
	});

	test("declares the comments tier and answers parseFile with the spans", () => {
		const provider = new CsharpProvider();
		startProvider(provider);
		const text = "// header\npublic class Value { }\n";
		const facts = FileFactsSchema.parse(
			parseThroughKit(provider, { module: "Value.cs", contentHash: "value", text }),
		);

		expect(TIERS.comments).toBe(true);
		expect(facts.comments).toEqual([
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
				text: "// header",
				codeBefore: false,
				codeAfter: false,
			},
		]);
		expect(facts.blankLines).toEqual([]);
	});

	test("holds comments back at outline depth, as literals are", () => {
		const provider = new CsharpProvider();
		startProvider(provider);
		const text = '// header\npublic class Value { string Name = "x"; }\n';
		const facts = parseThroughKit(provider, { module: "Value.cs", contentHash: "value", text, depth: "outline" });

		expect(facts.depth).toBe("outline");
		expect(facts.comments).toEqual([]);
		expect(facts.literals).toEqual([]);
	});

	test("reports no comments for a file that has none", () => {
		expect(commentTexts('public class C { string Text = "no markers here"; }\n')).toEqual([]);
	});
});

describe("C# comment trivia and blank lines", () => {
	test("says whether code shares a comment's first line before it and its last line after it", () => {
		const text = [
			"#define DEBUG",
			"// own line",
			"public class Trivia { // trailing",
			"\tint a = /* inline */ 1;",
			"\t/* first */ // second",
			"\t/* spans",
			"\t   lines */ int b;",
			"\tint c; /* opens",
			"\t   here */",
			"#if DEBUG // directive",
			"\t/// doc",
			"\tint d;",
			"#endif",
			'\tstring e = $"{d /* hole */}";',
			'\tstring f = $@"{',
			"\t\t// hole line",
			'\t\td}";',
			"}",
			"",
		].join("\n");
		const expected = {
			"// own line": [false, false],
			"// trailing": [true, false],
			"/* inline */": [true, true],
			"/* first */": [false, false],
			"// second": [false, false],
			"/* spans\n\t   lines */": [false, true],
			"/* opens\n\t   here */": [true, false],
			"// directive": [true, false],
			"/// doc": [false, false],
			"/* hole */": [true, true],
			"// hole line": [false, false],
		};
		const trivia = (source: string) =>
			Object.fromEntries(
				parseCsharp("Trivia.cs", source).comments.map((comment) => [
					comment.text.replaceAll("\r\n", "\n"),
					[comment.codeBefore, comment.codeAfter],
				]),
			);

		expect(trivia(text)).toEqual(expected);
		expect(trivia(text.replaceAll("\n", "\r\n"))).toEqual(expected);
	});

	test("counts a line blank only when no token touches it", () => {
		const text = [
			"public class Blank {",
			"",
			'\tstring a = @"one',
			"",
			'two";',
			'\tstring b = """',
			"",
			'\t\t""";',
			'\tstring c = $"{',
			"",
			'\t\tb}";',
			"\t/* a",
			"",
			"\tb */",
			"   \t",
			"#if false",
			"",
			"\tint dropped;",
			"#endif",
			"}",
			"",
		].join("\n");
		const blank = (source: string) => parseCsharp("Blank.cs", source).blankLines;

		expect(blank(text)).toEqual([1, 14, 16]);
		expect(blank(text.replaceAll("\n", "\r\n"))).toEqual([1, 14, 16]);
		expect(blank("")).toEqual([]);
		expect(blank("\n")).toEqual([0]);
		expect(blank("class C {}\n  ")).toEqual([1]);
	});
});
