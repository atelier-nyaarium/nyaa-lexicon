import { expect, test } from "vitest";
import { tokenize } from "../tokens.js";

function values(text: string) {
	return tokenize(text).tokens.map((token) => ({ kind: token.kind, value: token.value }));
}

test("recognizes the Rust literal families without splitting their delimiters", () => {
	const result = tokenize(`
const empty = "";
const text = "hello";
const bytes = b"bytes";
const ctext = c"c text";
const raw = r#"raw " text"#;
const rawBytes = br##"raw # bytes"##;
const rawC = cr###"raw ## c"###;
const character = '\\n';
const byte = b'\\x41';
`);

	expect(result.diagnostics).toEqual([]);
	expect(result.tokens.filter((token) => token.kind === "string").map((token) => token.value)).toEqual([
		"",
		"hello",
		"bytes",
		"c text",
		'raw " text',
		"raw # bytes",
		"raw ## c",
	]);
	expect(result.tokens.filter((token) => token.kind === "char").map((token) => token.value)).toEqual(["\n", "A"]);
});

test("accepts LF in strings and removes a string continuation", () => {
	const text = ['const text = "first\\', "second", 'third";', 'const bytes = b"one', 'two";'].join("\n");
	const result = tokenize(text);

	expect(result.diagnostics).toEqual([]);
	expect(result.tokens.filter((token) => token.kind === "string").map((token) => token.value)).toEqual([
		"firstsecond\nthird",
		"one\ntwo",
	]);
});

test("treats lifetimes as distinct from character literals", () => {
	const result = tokenize(`struct Ref<'a>(Option<&'a str>);
fn label<'a>(value: &'a str) -> &'a str { value }
let open = '{';
let quote = '\\'';
`);

	expect(result.diagnostics).toEqual([]);
	expect(result.tokens.filter((token) => token.kind === "lifetime").map((token) => token.value)).toEqual([
		"'a",
		"'a",
		"'a",
		"'a",
		"'a",
	]);
	expect(result.tokens.filter((token) => token.kind === "char").map((token) => token.value)).toEqual(["{", "'"]);
	expect(result.tokens.some((token) => token.kind === "lifetime" && token.value.includes("Option"))).toBe(false);
});

test("decodes Rust escapes and preserves unknown escape spelling", () => {
	const result = tokenize(`const value = "\\0\\a\\b\\f\\n\\r\\t\\v\\\\\\"\\'\\u{1f600}\\q";`);

	expect(result.diagnostics).toEqual([]);
	expect(result.tokens[3]?.value).toBe(`\0\x07\b\f\n\r\t\v\\"'😀\\q`);
});

test("handles nested block comments and reports an incomplete one", () => {
	const valid = tokenize("/* outer /* inner */ outer */ struct Item;");
	const invalid = tokenize("/* outer /* inner */ struct Item;");

	expect(valid.diagnostics).toEqual([]);
	expect(valid.tokens.map((token) => token.value)).toEqual(["struct", "Item", ";"]);
	expect(valid.comments.map((comment) => comment.text)).toEqual(["/* outer /* inner */ outer */"]);
	expect(invalid.diagnostics).toHaveLength(1);
	expect(invalid.diagnostics[0]?.message).toBe("block comment has no closing delimiter");
	expect(invalid.comments.map((comment) => comment.text)).toEqual(["/* outer /* inner */ struct Item;"]);
});

test("keeps comment markers inside string and character literals out of the comments", () => {
	const result = tokenize(`const url = "https://example.com/path";
const block = "/* not a comment */";
const raw = r#"// not a comment"#;
const slash = '/';
// real
`);

	expect(result.diagnostics).toEqual([]);
	expect(result.comments.map((comment) => comment.text)).toEqual(["// real"]);
});

test("scans numbers, suffixes, raw identifiers, and operators", () => {
	expect(values("let r#type = 0xff_u32 + 1.5e-2; value >>= 1;")).toEqual([
		{ kind: "identifier", value: "let" },
		{ kind: "identifier", value: "type" },
		{ kind: "symbol", value: "=" },
		{ kind: "number", value: "0xff_u32" },
		{ kind: "symbol", value: "+" },
		{ kind: "number", value: "1.5e-2" },
		{ kind: "symbol", value: ";" },
		{ kind: "identifier", value: "value" },
		{ kind: "symbol", value: ">>=" },
		{ kind: "number", value: "1" },
		{ kind: "symbol", value: ";" },
	]);
});

test("reports an unclosed string and leaves a valid prefix usable", () => {
	const result = tokenize(`const first = "ok";
const second = "missing
`);

	expect(result.tokens.some((token) => token.value === "ok")).toBe(true);
	expect(result.diagnostics).toHaveLength(1);
	expect(result.diagnostics[0]?.message).toBe("string or character literal has no closing delimiter");
});
