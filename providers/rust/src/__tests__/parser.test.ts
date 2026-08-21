import { coordinatesOf, parseSymbolId } from "@nyaa-lexicon/protocol";
import { expect, test } from "vitest";
import { RustProvider } from "../main.js";

function parse(text: string, module = "src/lib.rs") {
	const provider = new RustProvider();
	provider.initialize("/workspace");
	return { provider, facts: provider.parseFile({ module, contentHash: "test", text }) };
}

function rangeOfText(text: string, value: string) {
	const at = text.indexOf(value);
	if (at < 0) throw new Error(`missing test text ${value}`);
	return coordinatesOf(text).rangeAt(at, at + value.length);
}

function declaration(facts: ReturnType<typeof parse>["facts"], name: string) {
	const found = facts.declarations.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`missing declaration ${name}`);
	return found;
}

test("extracts Rust declarations and their ownership", () => {
	const text = `/// Packets cross the boundary.
#[derive(Debug)]
pub(crate) struct Packet {
    pub value: i32,
    hidden: bool,
}

pub enum State {
    Ready,
    Done = 1,
}

pub trait Display {
    fn show(&self) -> String;
}

impl Packet {
    pub fn new(value: i32) -> Self {
        let local: i32 = value;
        local
    }
}

impl Display for Packet {
    fn show(&self) -> String {
        String::new()
    }
}

pub const LIMIT: i32 = 1;
static ENABLED: bool = true;
pub type Alias = Packet;
pub mod nested {
    pub fn child() {}
}

macro_rules! make_item {
    ($name:ident) => { fn generated() {} };
}
`;
	const { facts } = parse(text);

	const packet = declaration(facts, "Packet");
	const value = declaration(facts, "value");
	const hidden = declaration(facts, "hidden");
	const state = declaration(facts, "State");
	const ready = declaration(facts, "Ready");
	const display = declaration(facts, "Display");
	const newMethod = declaration(facts, "new");
	const showMethods = facts.declarations.filter((candidate) => candidate.name === "show");
	const limit = declaration(facts, "LIMIT");
	const enabled = declaration(facts, "ENABLED");
	const alias = declaration(facts, "Alias");
	const nested = declaration(facts, "nested");
	const child = declaration(facts, "child");
	const macro = declaration(facts, "make_item");

	expect(packet.kind).toBe("struct");
	expect(packet.visibility).toBe("internal");
	expect(packet.exported).toBe(true);
	expect(value.kind).toBe("field");
	expect(value.visibility).toBe("public");
	expect(value.containerId).toBe(packet.symbolId);
	expect(hidden.visibility).toBe("private");
	expect(hidden.containerId).toBe(packet.symbolId);
	expect(state.kind).toBe("enum");
	expect(ready.kind).toBe("constant");
	expect(ready.containerId).toBe(state.symbolId);
	expect(display.kind).toBe("interface");
	expect(showMethods).toHaveLength(2);
	expect(
		showMethods.every(
			(candidate) => candidate.containerId === packet.symbolId || candidate.containerId === display.symbolId,
		),
	).toBe(true);
	expect(newMethod.kind).toBe("method");
	expect(newMethod.containerId).toBe(packet.symbolId);
	expect(newMethod.signature).toContain("fn new(value: i32) -> Self");
	expect(limit.kind).toBe("constant");
	expect(limit.exported).toBe(true);
	expect(enabled.languageKind).toBe("static");
	expect(alias.languageKind).toBe("typeAlias");
	expect(nested.kind).toBe("module");
	expect(child.containerId).toBe(nested.symbolId);
	expect(macro.languageKind).toBe("macroRules");
	expect(facts.declarations.some((candidate) => candidate.name === "generated")).toBe(false);

	const parsedId = parseSymbolId(packet.symbolId);
	expect(parsedId?.descriptors.map((descriptor) => `${descriptor.kind}:${descriptor.name}`)).toEqual(["type:Packet"]);
	expect(facts.diagnostics).toEqual([]);
});

test("uses UTF-16 positions and attaches literal containers", () => {
	const text = `/* 😀 */ pub struct Cart {}
pub const TEXT: &str = "line\\n";
const RAW = r#"raw"#;
static ENABLED: bool = true;
const HEX = 0xff_u32;
`;
	const { provider, facts } = parse(text);
	const cart = declaration(facts, "Cart");
	const textDeclaration = declaration(facts, "TEXT");
	const rawDeclaration = declaration(facts, "RAW");
	const enabledDeclaration = declaration(facts, "ENABLED");
	const hexDeclaration = declaration(facts, "HEX");

	expect(cart.selectionRange.start).toEqual({ line: 0, character: 20 });
	expect(facts.literals.map((literal) => [literal.kind, literal.value])).toEqual([
		["string", "line\n"],
		["string", "raw"],
		["boolean", "true"],
		["number", "0xff_u32"],
	]);
	expect(facts.literals.every((literal) => literal.containerId !== undefined)).toBe(true);
	expect(facts.literals[0]?.containerId).toBe(textDeclaration.symbolId);
	expect(facts.literals[1]?.containerId).toBe(rawDeclaration.symbolId);
	expect(facts.literals[2]?.containerId).toBe(enabledDeclaration.symbolId);
	expect(facts.literals[3]?.containerId).toBe(hexDeclaration.symbolId);
	expect(facts.literals[3]?.number).toBe(255);
	expect(provider.typeOf({ symbolId: textDeclaration.symbolId })).toMatchObject({ status: "known", display: "&str" });
	expect(provider.typeOf({ symbolId: rawDeclaration.symbolId })).toMatchObject({
		status: "inferred",
		display: "&str",
	});
	expect(provider.typeOf({ symbolId: enabledDeclaration.symbolId })).toMatchObject({
		status: "known",
		display: "bool",
	});
	expect(provider.typeOf({ symbolId: hexDeclaration.symbolId })).toMatchObject({
		status: "inferred",
		display: "i32",
	});
});

test("decodes hexadecimal f digits and typed decimal literals", () => {
	const { facts } = parse(`
const hex = 0xff;
const hexUpper = 0xFFFF_FFFF;
const unsigned: u32 = 12u32;
const signed: i64 = 13i64;
const sized: usize = 14usize;
const float: f32 = 1.5f32;
`);
	const literals = new Map(facts.literals.map((literal) => [literal.value, literal]));

	expect(literals.get("0xff")?.number).toBe(255);
	expect(literals.get("0xFFFF_FFFF")?.number).toBe(4_294_967_295);
	expect(literals.get("12u32")?.number).toBe(12);
	expect(literals.get("13i64")?.number).toBe(13);
	expect(literals.get("14usize")?.number).toBe(14);
	expect(literals.get("1.5f32")?.number).toBe(1.5);
});

test("omits unsafe numeric values without dropping their spelling", () => {
	const { facts } = parse("const exact = 0x1fffffffffffff; const large = 0xffffffffffffffff;");
	const exact = facts.literals.find((literal) => literal.value === "0x1fffffffffffff");
	const large = facts.literals.find((literal) => literal.value === "0xffffffffffffffff");

	expect(exact?.number).toBe(Number.MAX_SAFE_INTEGER);
	expect(large).toEqual(expect.objectContaining({ kind: "number", value: "0xffffffffffffffff" }));
	expect(large).not.toHaveProperty("number");
});

test("extracts reference roles and binds local symbols", () => {
	const text = `pub struct Item {}
impl Item {
    pub fn make() -> Self { Item {} }
}
fn run(mut value: Item) {
    value = Item::make();
    value;
    let item = Item {};
    println!("{}", item);
}
`;
	const { facts } = parse(text);
	const refs = facts.references;
	const run = declaration(facts, "run");
	const itemType = declaration(facts, "Item");
	const make = declaration(facts, "make");

	const valueWrites = refs.filter((reference) => reference.name === "value" && reference.role === "write");
	const valueReads = refs.filter((reference) => reference.name === "value" && reference.role === "read");
	const itemInstantiations = refs.filter(
		(reference) => reference.name === "Item" && reference.role === "instantiate",
	);
	const methodCall = refs.find((reference) => reference.name === "make" && reference.role === "call");
	const macroCall = refs.find((reference) => reference.name === "println" && reference.role === "call");

	expect(valueWrites).toHaveLength(1);
	expect(valueReads).toHaveLength(1);
	expect(valueWrites[0]?.fromId).toBe(run.symbolId);
	expect(itemInstantiations).toHaveLength(2);
	expect(
		itemInstantiations.every(
			(reference) => reference.binding.status === "bound" && reference.binding.symbolId === itemType.symbolId,
		),
	).toBe(true);
	expect(methodCall?.binding).toEqual({ status: "bound", symbolId: make.symbolId, provenance: "bound" });
	expect(macroCall?.binding).toMatchObject({ status: "unbound", reason: "RuntimeConstructed" });
});

test("reports syntax errors without rejecting valid Rust", () => {
	const broken = parse("fn add( {\n", "broken.rs").facts;
	const valid = parse("fn add() { 1 }\n", "valid.rs").facts;
	const unterminated = parse('const TEXT: &str = "broken\n', "string.rs").facts;

	expect(broken.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	expect(valid.diagnostics).toEqual([]);
	expect(unterminated.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
});

test("returns honest unknown types for nonliteral unannotated locals", () => {
	const text = `fn run() {
    let known = 1;
    let unknown = make_value();
}
`;
	const { provider, facts } = parse(text);
	const known = declaration(facts, "known");
	const unknownLocal = declaration(facts, "unknown");
	const missing = provider.typeOf({ symbolId: "not-a-rust-id" });

	expect(provider.typeOf({ symbolId: known.symbolId })).toEqual({
		status: "inferred",
		display: "i32",
		basis: "literal initializer",
	});
	expect(provider.typeOf({ symbolId: unknownLocal.symbolId })).toMatchObject({
		status: "unknown",
		reason: "NotImplemented",
	});
	expect(missing).toMatchObject({ status: "unknown", reason: "ParseError" });
});

test("keeps generic signatures and lifetimes out of delimiter diagnostics", () => {
	const text = `pub struct Ref<'a>(Option<&'a str>);
pub trait Render<T> {
    fn render<'a>(&'a self, value: T) -> &'a str;
}
impl Render<String> for Ref<'_> {
    fn render<'a>(&'a self, value: String) -> &'a str { "ok" }
}
`;
	const { facts, provider } = parse(text);
	const referenceType = declaration(facts, "Ref");
	const trait = declaration(facts, "Render");
	const methods = facts.declarations.filter((candidate) => candidate.name === "render");

	expect(facts.diagnostics).toEqual([]);
	expect(methods).toHaveLength(2);
	expect(methods[0]?.containerId).toBe(trait.symbolId);
	expect(methods[1]?.containerId).toBe(referenceType.symbolId);
	expect(methods[1]?.languageKind).toBe("traitImplMethod");
	expect(methods[1]?.signature).toContain("impl Render<String>");
	expect(methods[1]?.metrics?.parameters).toBe(2);
	expect(provider.typeOf({ symbolId: methods[1]?.symbolId ?? "" })).toMatchObject({
		status: "known",
		display: expect.stringContaining("&'a str"),
	});
});

test("parses grouped imports, aliases, globs, and import references", () => {
	const { facts } = parse(`use crate::util::{Thing, Other as Alias, *};
use self::local::Value;
use super::parent::Parent;
`);

	expect(facts.diagnostics).toEqual([]);
	expect(facts.imports).toHaveLength(3);
	expect(facts.imports[0]?.specifier).toBe("crate::util::{Thing, Other as Alias, *}");
	expect(facts.imports[0]?.imported).toEqual([
		expect.objectContaining({ name: "Thing" }),
		expect.objectContaining({ name: "Other" }),
		expect.objectContaining({ name: "*" }),
	]);
	expect(facts.imports[0]?.imported[1]?.local).toBe("Alias");
	expect(facts.references.filter((reference) => reference.role === "import")).toHaveLength(4);
	expect(facts.references.filter((reference) => reference.name === "Other")).toHaveLength(1);
});

test("owns declarations in inline modules and gives fields and variants descriptor paths", () => {
	const { facts } = parse(`pub mod outer {
    pub mod inner {
        pub struct Item { pub value: i32, hidden: bool }
        pub enum State { Ready, Done(u8) }
    }
}
`);
	const outer = declaration(facts, "outer");
	const inner = declaration(facts, "inner");
	const item = declaration(facts, "Item");
	const value = declaration(facts, "value");
	const ready = declaration(facts, "Ready");
	const done = declaration(facts, "Done");

	expect(outer.kind).toBe("module");
	expect(inner.containerId).toBe(outer.symbolId);
	expect(item.containerId).toBe(inner.symbolId);
	expect(value.containerId).toBe(item.symbolId);
	expect(ready.containerId).toBe(declaration(facts, "State").symbolId);
	expect(done.containerId).toBe(declaration(facts, "State").symbolId);
	expect(parseSymbolId(value.symbolId)?.descriptors.map((part) => `${part.kind}:${part.name}`)).toEqual([
		"namespace:outer",
		"namespace:inner",
		"type:Item",
		"term:value",
	]);
});

test("records function metrics, parameter declarations, and local pattern bindings", () => {
	const { facts, provider } = parse(`fn compute(mut input: i32, flag: bool) -> i32 {
    let (first, second): (i32, i32) = (input, 2);
    if flag { input += first; } else { input = second; }
    input
}
`);
	const compute = declaration(facts, "compute");
	const first = declaration(facts, "first");
	const second = declaration(facts, "second");
	const input = facts.declarations.filter((candidate) => candidate.name === "input");

	expect(compute.metrics?.parameters).toBe(2);
	expect(compute.metrics?.lines).toBe(5);
	expect(input).toHaveLength(1);
	expect(input.every((candidate) => candidate.kind === "variable")).toBe(true);
	expect(compute.metrics?.branches).toBeGreaterThan(1);
	expect(first.containerId).toBe(compute.symbolId);
	expect(second.containerId).toBe(compute.symbolId);
	expect(provider.typeOf({ symbolId: first.symbolId })).toMatchObject({ status: "known", display: "(i32, i32)" });
});

test("assigns roles for calls, reads, writes, type uses, construction, and trait implementation", () => {
	const { facts } = parse(`trait Service { fn run(&self); }
struct Item { field: i32 }
impl Service for Item { fn run(&self) {} }
fn call(item: Item) {
	    let mut value = Item { field: 1 };
	    value = Item { field: 2 };
    Service::run(&item);
    value;
}
`);
	const roles = new Map<string, number>();
	for (const reference of facts.references) roles.set(reference.role, (roles.get(reference.role) ?? 0) + 1);

	expect(roles.get("implements")).toBeGreaterThan(0);
	expect(roles.get("typeUse")).toBeGreaterThan(0);
	expect(roles.get("instantiate")).toBeGreaterThan(0);
	expect(roles.get("call")).toBeGreaterThan(0);
	expect(roles.get("read")).toBeGreaterThan(0);
	expect(roles.get("write")).toBeGreaterThan(0);
});

test("ignores attribute contents and macro bodies while retaining macro declarations and calls", () => {
	const { facts } = parse(`#[derive(Clone, Debug)]
#[cfg(feature = "generated")]
pub struct Item;
macro_rules! build {
    ($name:ident) => { fn generated() {} };
}
fn run() {
    build!(Item);
}
`);

	expect(facts.diagnostics).toEqual([]);
	expect(facts.declarations.some((candidate) => candidate.name === "Clone")).toBe(false);
	expect(facts.declarations.some((candidate) => candidate.name === "generated")).toBe(false);
	expect(facts.literals.some((literal) => literal.value === "generated")).toBe(false);
	expect(facts.declarations.find((candidate) => candidate.name === "build")?.languageKind).toBe("macroRules");
	expect(facts.references.find((reference) => reference.name === "build")?.binding).toMatchObject({
		status: "unbound",
		reason: "RuntimeConstructed",
	});
});

test("reports every Rust comment form as a verbatim span", () => {
	const { facts } = parse(`// line
/// outer doc
//! inner doc
/* block */
/** block doc */
/*! inner block doc */
/* outer /* nested */ still outer */
pub fn work(first: i32 /* inline */) -> i32 {
    first // trailing
}
`);

	expect(facts.comments.map((comment) => comment.text)).toEqual([
		"// line",
		"/// outer doc",
		"//! inner doc",
		"/* block */",
		"/** block doc */",
		"/*! inner block doc */",
		"/* outer /* nested */ still outer */",
		"/* inline */",
		"// trailing",
	]);
});

test("ranges a comment over exactly the text it reports", () => {
	const text = "// leading\npub fn work(first: i32 /* inline */) -> i32 {\n    first\n}\n";
	const coordinates = coordinatesOf(text);
	const { facts } = parse(text);

	expect(facts.comments.map((comment) => coordinates.sliceRange(comment.range))).toEqual(
		facts.comments.map((comment) => comment.text),
	);
	expect(facts.comments.map((comment) => comment.range)).toEqual([
		rangeOfText(text, "// leading"),
		rangeOfText(text, "/* inline */"),
	]);
});

test("leaves a comment marker inside a literal out of the comment list", () => {
	const { facts } = parse(`pub const URL: &str = "https://example.com/path";
pub const BLOCK: &str = "/* not a comment */";
pub const RAW: &str = r#"// not a comment"#;
pub const BYTES: &[u8] = b"/* not a comment */";
pub const SLASH: char = '/';
// real
`);

	expect(facts.comments.map((comment) => comment.text)).toEqual(["// real"]);
});

test("reports an unterminated block comment as one span reaching the end of file", () => {
	const { facts } = parse("pub const BEFORE: i32 = 1;\n/* opened /* nested and never closed");

	expect(facts.comments.map((comment) => comment.text)).toEqual(["/* opened /* nested and never closed"]);
	expect(facts.diagnostics.some((diagnostic) => diagnostic.message.includes("no closing delimiter"))).toBe(true);
});

test("closes an empty block comment instead of swallowing the rest of the file", () => {
	const { facts } = parse("pub const A: i32 = 1 /**/;\npub struct After;\n");

	expect(facts.comments.map((comment) => comment.text)).toEqual(["/**/"]);
	expect(facts.declarations.map((candidate) => candidate.name)).toContain("After");
});

test("reports a shebang line and leaves an inner attribute alone", () => {
	const shebang = parse("#!/usr/bin/env run-cargo-script\npub const A: i32 = 1;\n", "src/tool.rs").facts;
	const attribute = parse("#![allow(dead_code)]\n// real\n", "src/attr.rs").facts;

	expect(shebang.comments.map((comment) => comment.text)).toEqual(["#!/usr/bin/env run-cargo-script"]);
	expect(attribute.comments.map((comment) => comment.text)).toEqual(["// real"]);
});

test("ends a line comment before a CRLF terminator", () => {
	const { facts } = parse("// leading\r\npub const A: i32 = 1;\r\n");

	expect(facts.comments.map((comment) => comment.text)).toEqual(["// leading"]);
});

test("withholds comments from an outline parse, as it withholds literals", () => {
	const provider = new RustProvider();
	provider.initialize("/workspace");
	const facts = provider.parseFile({
		module: "src/lib.rs",
		contentHash: "outline",
		text: '// leading\npub const A: &str = "value";\n',
		depth: "outline",
	});

	expect(facts.comments).toEqual([]);
	expect(facts.literals).toEqual([]);
	expect(facts.declarations.map((candidate) => candidate.name)).toEqual(["A"]);
});

test("reads a string spelling a keyword as a string, not as the keyword", () => {
	const body = (inner: string) =>
		["macro_rules! m { ($($t:tt)*) => {}; }", "fn f() {", `    m!(${inner} x = 1);`, "    let y = 2;", "}"].join(
			"\n",
		);

	// Only the macro's string content differs, so the locals found must not.
	const control = parse(body('"x"'), "control.rs").facts;
	const mutated = parse(body('"let"'), "mutated.rs").facts;

	expect(mutated.declarations.map((candidate) => candidate.name)).toEqual(
		control.declarations.map((candidate) => candidate.name),
	);
});

test("reports mismatched and missing delimiters as syntax errors", () => {
	const mismatched = parse("fn broken() { let value = (1; }", "mismatch.rs").facts;
	const missing = parse("struct Broken { value: i32", "missing.rs").facts;

	expect(mismatched.diagnostics.some((diagnostic) => diagnostic.message.includes("unexpected"))).toBe(true);
	expect(missing.diagnostics.some((diagnostic) => diagnostic.message.includes("not closed"))).toBe(true);
});
