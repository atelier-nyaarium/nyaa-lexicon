import { describe, expect, test } from "bun:test";
import { coordinatesOf, FileFactsSchema } from "@nyaa-lexicon/protocol";
import { CsharpProvider, TIERS } from "../main.js";
import { CsharpParser } from "../parser.js";

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

	test("reports a trailing comment on a directive whose body is tokens, never the directive", () => {
		const text = [
			"#define TRACE // why",
			'#line 5 "C:/gen//file.cs" // mapped',
			"#pragma warning disable CS0649 // never assigned",
			"#if DEBUG // build only",
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
		const text = "// header\npublic class Value { }\n";
		const facts = FileFactsSchema.parse(provider.parseFile({ module: "Value.cs", contentHash: "value", text }));

		expect(TIERS.comments).toBe(true);
		expect(facts.comments).toEqual([
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, text: "// header" },
		]);
	});

	test("holds comments back at outline depth, as literals are", () => {
		const provider = new CsharpProvider();
		const text = '// header\npublic class Value { string Name = "x"; }\n';
		const facts = provider.parseFile({ module: "Value.cs", contentHash: "value", text, depth: "outline" });

		expect(facts.depth).toBe("outline");
		expect(facts.comments).toEqual([]);
		expect(facts.literals).toEqual([]);
	});

	test("reports no comments for a file that has none", () => {
		expect(commentTexts('public class C { string Text = "no markers here"; }\n')).toEqual([]);
	});
});
