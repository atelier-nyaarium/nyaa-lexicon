import { describe, expect, test } from "bun:test";
import { lexGdscript, quoteGdscriptString } from "../lexer.js";

////////////////////////////////
//  Helpers

function strings(text: string): string[] {
	return lexGdscript(text).strings.map((span) => span.value);
}

function comments(text: string): string[] {
	return lexGdscript(text).comments.map((comment) => comment.text);
}

function symbols(text: string): string[] {
	return lexGdscript(text)
		.tokens.filter((token) => token.kind !== "newline")
		.map((token) => `${token.kind}:${token.value}`);
}

////////////////////////////////
//  Tests

describe("the GDScript lexer", () => {
	test("a raw string keeps every backslash, and one still keeps a quote or backslash from ending it", () => {
		const text = [
			'var a = r"C:\\dir\\n" # one',
			'var b = r"\\"" # two',
			"var c = r'\\\\' # three",
			'var d = r"""a\\"""" # four',
			'var e = r"\\" # never closed',
		].join("\n");
		const lexed = lexGdscript(text);

		expect(strings(text)).toEqual(["C:\\dir\\n", '\\"', "\\\\", 'a\\"']);
		expect(comments(text)).toEqual(["# one", "# two", "# three", "# four"]);
		expect(lexed.unterminatedStrings).toEqual([{ line: 4, character: 8 }]);
	});

	test("a regular string spans lines, an escaped line break joins them, and each line knows it", () => {
		const text = 'var a = "one\n# inside\ntwo" # after\nvar b = "x\\\r\ny"\n';
		const lexed = lexGdscript(text);

		expect(strings(text)).toEqual(["one\n# inside\ntwo", "xy"]);
		expect(comments(text)).toEqual(["# after"]);
		expect(lexed.lines.map((line) => [line.hasString, line.endsInString, line.end])).toEqual([
			[true, true, 12],
			[true, true, 8],
			[true, false, 12],
			[true, true, 11],
			[true, false, 2],
		]);
	});

	// A second lead drops both, leaving the trail after it unpaired, as Godot's tokenizer does.
	test("escapes decode as Godot's, and one it refuses adds nothing and is reported", () => {
		const deseret = String.fromCodePoint(0x10400);
		const text = [
			String.raw`var a = "\t\"\'\\ \u00e9 \U01F600 \uD83D\uDE00"`,
			String.raw`var b = "a\qb\0c\ed"`,
			String.raw`var c = "\u12"`,
			String.raw`var d = "\uD83Dx"`,
			String.raw`var e = "\uDE00"`,
			String.raw`var f = "\U110000"`,
			String.raw`var g = "\uD800\uD801\uDC00"`,
			`var h = "\\uD800${deseret}"`,
		].join("\n");
		const emoji = String.fromCodePoint(0x1f600);

		expect(strings(text)).toEqual([
			`\t"'\\ ${String.fromCodePoint(0xe9)} ${emoji} ${emoji}`,
			"abcd",
			"",
			"x",
			"",
			"",
			"",
			deseret,
		]);
		expect(lexGdscript(text).invalidEscapes).toEqual([
			{ line: 1, character: 10 },
			{ line: 1, character: 13 },
			{ line: 1, character: 16 },
			{ line: 2, character: 9 },
			{ line: 3, character: 9 },
			{ line: 4, character: 9 },
			{ line: 5, character: 9 },
			{ line: 6, character: 15 },
			{ line: 6, character: 21 },
			{ line: 7, character: 9 },
		]);
	});

	test("quoting a value and lexing it back returns the value", () => {
		const values = [
			"",
			'a "quoted" \\ path',
			"line\nbreak\r\ttab",
			`${String.fromCharCode(1)}${String.fromCodePoint(0x1f600)}`,
		];

		expect(values.map((value) => strings(`var a = ${quoteGdscriptString(value)}`)[0])).toEqual(values);
	});

	test("numbers, prefixes and operators are whole tokens, at their offsets", () => {
		expect(symbols('x = 0x_FF + 1_000.5e-3 + .5 ... a..b &&&"n" ^=^"p" **= 2 # c\r\n')).toEqual([
			"identifier:x",
			"symbol:=",
			"number:0x_FF",
			"symbol:+",
			"number:1_000.5e-3",
			"symbol:+",
			"number:.5",
			"symbol:...",
			"identifier:a",
			"symbol:..",
			"identifier:b",
			"symbol:&&",
			'string:&"n"',
			"symbol:^=",
			'string:^"p"',
			"symbol:**=",
			"number:2",
		]);
		expect(lexGdscript('\ny = "a\nb" + 1').tokens.map((token) => token.offset)).toEqual([0, 1, 3, 5, 11, 13]);
	});

	test("a carriage return ends a comment and a line only before a line break; alone it is content", () => {
		const text = "x = 1 # c\r\n# d\r";

		expect(comments(text)).toEqual(["# c", "# d\r"]);
		expect(lexGdscript(text).lines.map((line) => line.end)).toEqual([9, 4]);
	});
});
