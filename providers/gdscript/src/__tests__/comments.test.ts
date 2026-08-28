import { expect, test } from "bun:test";
import { GDScriptProvider, TIERS } from "../main.js";

function commentsOf(text: string, module = "comments.gd") {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	return provider.parseFile({ module, contentHash: module, text }).comments;
}

test("declares the comments tier it now answers", () => {
	expect(TIERS.comments).toBe(true);
});

test("reports every GDScript comment shape as a verbatim span", () => {
	const text = `# leading
func work(first, second):
	# inline
	return first + second

var total = 42 # trailing

# standalone
`;

	expect(commentsOf(text)).toEqual([
		{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, text: "# leading" },
		{ range: { start: { line: 2, character: 1 }, end: { line: 2, character: 9 } }, text: "# inline" },
		{ range: { start: { line: 5, character: 15 }, end: { line: 5, character: 25 } }, text: "# trailing" },
		{ range: { start: { line: 7, character: 0 }, end: { line: 7, character: 12 } }, text: "# standalone" },
	]);
});

// GDScript spells doc comments, region markers and the interpreter line with the same `#`, so all
// three are one span each. Whether a span is PROSE is core's question, not the lexer's.
test("reports doc comments, region markers and a shebang like any other comment", () => {
	const text = `#!/usr/bin/env godot
## Documents the value.
#region setup
var total = 42
#endregion
`;

	expect(commentsOf(text, "tool.gd").map((comment) => comment.text)).toEqual([
		"#!/usr/bin/env godot",
		"## Documents the value.",
		"#region setup",
		"#endregion",
	]);
});

test("keeps the marker text unaltered rather than stripping or trimming it", () => {
	const text = "var total = 42 #\tspaced   \n";

	expect(commentsOf(text)[0]).toEqual({
		range: { start: { line: 0, character: 15 }, end: { line: 0, character: 26 } },
		text: "#\tspaced   ",
	});
});

test("does not report a marker written inside a string literal", () => {
	const text = `var url = "https://example.com/path"
var hashed = "# not a comment"
var single = '# not a comment either'
# real
`;

	expect(commentsOf(text, "markers.gd").map((comment) => comment.text)).toEqual(["# real"]);
});

// The GDScript idiom for a block comment is a triple-quoted string, which is a LITERAL. Reporting
// its contents would be the same defect as reporting a marker inside any other string.
test("does not report markers inside a multiline string", () => {
	const text = `var block = """
# not a comment
still inside the string
"""
# real
`;

	expect(commentsOf(text, "block.gd").map((comment) => comment.text)).toEqual(["# real"]);
});

// GDScript has no block comment, so an unclosed triple quote is an unterminated STRING. Nothing
// may run to end of file as a comment.
test("an unterminated multiline string swallows no comment span", () => {
	const text = `var block = """
# opened and never closed
`;

	expect(commentsOf(text, "open.gd")).toEqual([]);
});

test("does not report a marker written after an unterminated string on the same line", () => {
	const text = 'var broken = "open # inside\n# real\n';

	expect(commentsOf(text, "broken.gd").map((comment) => comment.text)).toEqual(["# real"]);
});

test("measures the comment range in UTF-16 code units", () => {
	const text = 'var emoji = "\u{1F600}" # after\n';

	expect(commentsOf(text)[0]?.range).toEqual({
		start: { line: 0, character: 17 },
		end: { line: 0, character: 24 },
	});
});

test("treats a carriage return as the line terminator rather than comment text", () => {
	const text = "var total = 42 # trailing\r\n# next\r\n";

	expect(commentsOf(text).map((comment) => comment.text)).toEqual(["# trailing", "# next"]);
});

test("reports no comments for a file that has none", () => {
	expect(commentsOf("var total = 42\n")).toEqual([]);
});
