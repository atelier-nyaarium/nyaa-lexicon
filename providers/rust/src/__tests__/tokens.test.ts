import { expect, test } from "bun:test";
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
	expect(result.tokens.some((token) => token.kind === "identifier" && token.value === "b")).toBe(false);
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

test("says whether a code token shares each comment's first and last lines", () => {
	const result = tokenize(`// own line
const A: i32 = 1; // trailing
const B: i32 = /* both */ 2;
/* before */ const C: i32 = 3;
/* first */ // second
const D: i32 = /* opens
closes */ 4;
    /* alone
    still alone */
const E: &str = "text
"; /* after a string */
`);
	const trivia = result.comments.map((comment) => [comment.text, comment.codeBefore, comment.codeAfter]);

	expect(trivia).toEqual([
		["// own line", false, false],
		["// trailing", true, false],
		["/* both */", true, true],
		["/* before */", false, true],
		["/* first */", false, false],
		["// second", false, false],
		["/* opens\ncloses */", true, true],
		["/* alone\n    still alone */", false, false],
		["/* after a string */", true, false],
	]);
});

test("reports the lines no token or comment touches", () => {
	const blank = (text: string) => tokenize(text).blankLines;

	expect(blank('const A: &str = "one\n\ntwo";\n\nconst B: i32 = 1;\n')).toEqual([3]);
	expect(blank('const R: &str = r#"one\n\n"two"\n"#;\nconst S: &[u8] = b"x\n\ny";\n')).toEqual([]);
	expect(blank('const T: &[u8] = br##"a\n  \nb"##;\nconst U: &str = "a\\\n\n  b";\n')).toEqual([]);
	expect(blank("/* outer /* inner\n\n */\n\n still outer */\nconst C: i32 = 1;\n\n")).toEqual([6]);
	expect(blank("/// doc\n\n//! inner\n   \nfn f() {}")).toEqual([1, 3]);
	expect(blank("fn f() {}\r\n\r\nfn g() {}\r\n")).toEqual([1]);
	expect(blank("")).toEqual([]);
	expect(blank("\n")).toEqual([0]);
});

test("scans numbers, suffixes, raw identifiers, and operators", () => {
	expect(values("A...B")).toEqual([
		{ kind: "identifier", value: "A" },
		{ kind: "symbol", value: "..." },
		{ kind: "identifier", value: "B" },
	]);
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

test("ends a number where rustc's lexer ends it", () => {
	const spelled = (text: string) => tokenize(text).tokens.map((token) => `${token.kind}:${token.value}`);

	expect(spelled("0x1e+2")).toEqual(["number:0x1e", "symbol:+", "number:2"]);
	expect(spelled("1e+2 1.0e-3_f64 2.")).toEqual(["number:1e+2", "number:1.0e-3_f64", "number:2."]);
	expect(spelled("t.0.len()")).toEqual([
		"identifier:t",
		"symbol:.",
		"number:0",
		"symbol:.",
		"identifier:len",
		"symbol:(",
		"symbol:)",
	]);
	expect(spelled("1.max(2)")).toEqual(["number:1", "symbol:.", "identifier:max", "symbol:(", "number:2", "symbol:)"]);
	expect(spelled("1.e5 1.5.3")).toEqual([
		"number:1",
		"symbol:.",
		"identifier:e5",
		"number:1.5",
		"symbol:.",
		"number:3",
	]);
});

test("reads byte and one-symbol character literals as one token", () => {
	const result = tokenize("let c = b'a'; if c == ' '||c=='x' {}");

	expect(result.diagnostics).toEqual([]);
	expect(result.tokens.map((token) => `${token.kind}:${token.value}`)).toEqual([
		"identifier:let",
		"identifier:c",
		"symbol:=",
		"char:a",
		"symbol:;",
		"identifier:if",
		"identifier:c",
		"symbol:==",
		"char: ",
		"symbol:||",
		"identifier:c",
		"symbol:==",
		"char:x",
		"symbol:{",
		"symbol:}",
	]);
});

test("reads a CRLF inside a string as string content", () => {
	const result = tokenize('const S: &str = "a\r\nb";\r\nconst T: &str = "c\\\r\n    d";\r\nfn after() {}\r\n');

	expect(result.diagnostics).toEqual([]);
	expect(result.tokens.filter((token) => token.kind === "string").map((token) => token.value)).toEqual([
		"a\r\nb",
		"cd",
	]);
	expect(result.tokens.some((token) => token.value === "after")).toBe(true);
});

test("reads a leading #! as an inner attribute when its next token is [", () => {
	const spaced = tokenize("#! /* note */\n[allow(dead_code)]\nfn f() {}");
	const shebang = tokenize("#!/usr/bin/env run-cargo-script\nfn f() {}");

	expect(spaced.tokens.slice(0, 3).map((token) => token.value)).toEqual(["#", "!", "["]);
	expect(spaced.comments.map((comment) => comment.text)).toEqual(["/* note */"]);
	expect(shebang.tokens[0]?.value).toBe("fn");
	expect(shebang.comments.map((comment) => comment.text)).toEqual(["#!/usr/bin/env run-cargo-script"]);
});

test("reports an unclosed string and leaves a valid prefix usable", () => {
	const result = tokenize(`const first = "ok";
const second = "missing
`);

	expect(result.tokens.some((token) => token.value === "ok")).toBe(true);
	expect(result.diagnostics).toHaveLength(1);
	expect(result.diagnostics[0]?.message).toBe("string or character literal has no closing delimiter");
});
