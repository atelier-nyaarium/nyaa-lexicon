import { expect, test } from "bun:test";
import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { GDScriptProvider } from "../main.js";

function parsed(text: string, module = "layout.gd") {
	const handlers = handlersFor(new GDScriptProvider());
	handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: process.cwd() });
	return handlers.parseFile({ module, contentHash: module, text });
}

function lines(...text: string[]): string {
	return `${text.join("\n")}\n`;
}

function trivia(text: string) {
	return (parsed(text).comments ?? []).map((comment) => ({
		text: comment.text,
		codeBefore: comment.codeBefore,
		codeAfter: comment.codeAfter,
	}));
}

function insertLines(text: string): Record<string, number | null> {
	const containers = parsed(text).declarations.filter(
		(declaration) => declaration.kind === "class" || declaration.kind === "enum",
	);
	return Object.fromEntries(
		containers.map((declaration) => [declaration.name, declaration.memberInsertLine ?? null]),
	);
}

////////////////////////////////
//  Comment trivia

test("each comment says whether code shares its line before and after it", () => {
	const text = lines(
		"# own line # still the same comment",
		"# next own line",
		"var a = 1 # trailing",
		'var s = """one',
		'two""" # after a string that closes here',
		"var list = [",
		"\t1, # after an element",
		"\t# alone inside the list",
		"\t2,",
		"]",
		"func f():",
		"\t# alone in a body",
		"\tpass",
	);

	expect(trivia(text)).toEqual([
		{ text: "# own line # still the same comment", codeBefore: false, codeAfter: false },
		{ text: "# next own line", codeBefore: false, codeAfter: false },
		{ text: "# trailing", codeBefore: true, codeAfter: false },
		{ text: "# after a string that closes here", codeBefore: true, codeAfter: false },
		{ text: "# after an element", codeBefore: true, codeAfter: false },
		{ text: "# alone inside the list", codeBefore: false, codeAfter: false },
		{ text: "# alone in a body", codeBefore: false, codeAfter: false },
	]);
});

test("a leading byte order mark is not code before a comment", () => {
	const text = `${String.fromCharCode(0xfeff)}# a note\nvar after = 1\n`;

	expect(trivia(text)).toEqual([{ text: "# a note", codeBefore: false, codeAfter: false }]);
});

////////////////////////////////
//  Blank lines

test("a line inside any string form is not blank, whatever it holds", () => {
	const text = lines(
		"var a = 1",
		"",
		'var s = """one',
		"",
		'two"""',
		"var t = '''one",
		"",
		"two'''",
		'var r = r"""one',
		"",
		'two"""',
		'var n = &"""one',
		"",
		'two"""',
		'var p = ^"""one',
		"",
		'two"""',
		'var c = "one\\',
		"",
		'two"',
		"# a comment",
		"\t  ",
		"var b = 2",
	);

	expect(parsed(text).blankLines).toEqual([1, 21]);
});

test("the remainder after a final line break is not a line, and a carriage return is no token", () => {
	expect(parsed("var a = 1\n").blankLines).toEqual([]);
	expect(parsed("var a = 1").blankLines).toEqual([]);
	expect(parsed("var a = 1\n\n").blankLines).toEqual([1]);
	expect(parsed("var a = 1\r\n\r\nvar b = 2\r\n").blankLines).toEqual([1]);
});

test("an unterminated multi-line string leaves no blank line inside it", () => {
	expect(parsed(lines('var s = """one', "", "two")).blankLines).toEqual([]);
});

////////////////////////////////
//  Member insertion

test("an inner class names the line after its last statement's full extent", () => {
	const text = lines(
		"class Bracket:",
		"\tfunc b():",
		"\t\treturn [1,",
		"]",
		"class Text:",
		'\tvar s = """one',
		'two"""',
		"class Joined:",
		"\tvar a = 1 + \\",
		"2",
		"class Noted:",
		"\tvar a = 1",
		"\t# about a",
		"",
		"class Outer:",
		"\tclass Inner:",
		"\t\tvar a = 1",
		"\tvar b = 2",
		"class Tight: pass",
		"var x = 1",
	);

	expect(insertLines(text)).toEqual({
		layout: 20,
		Bracket: 4,
		Text: 7,
		Joined: 10,
		Noted: 13,
		Outer: 18,
		Inner: 17,
		Tight: null,
	});
});

test("a body ending on the last line with no line break leaves no safe point", () => {
	expect(insertLines("class Box:\n\tvar a = 1")).toEqual({ layout: null, Box: null });
});

test("an enum names its closing brace's line only when the brace starts it", () => {
	const text = lines(
		"enum Open {",
		"\tA,",
		"\tB,",
		"}",
		"enum Line { C, D }",
		"enum Shut {",
		"\tE,",
		"\tF}",
		"class Holder:",
		"\tenum Nested {",
		"\t\tG,",
		"\t}",
		"enum Joined \\",
		"\t{",
		"\tH,",
		"}",
	);

	expect(insertLines(text)).toEqual({
		layout: 16,
		Open: 3,
		Line: null,
		Shut: null,
		Holder: 12,
		Nested: 11,
		Joined: 15,
	});
});
