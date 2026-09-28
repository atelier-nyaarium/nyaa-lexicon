import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatesOf, handlersFor, PROTOCOL_VERSION, parseSymbolId } from "@nyaa-lexicon/protocol";
import { RustProvider } from "../main.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parse(text: string, module = "src/lib.rs", depth?: "outline" | undefined) {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-rust-parser-"));
	roots.push(root);
	const file = path.join(root, ...module.split("/"));
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	const provider = new RustProvider();
	const handlers = handlersFor(provider);
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return {
		provider: handlers,
		facts: handlers.parseFile({ module, contentHash: "test", text, ...(depth === undefined ? {} : { depth }) }),
	};
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
	const impls = facts.declarations.filter((candidate) => candidate.languageKind === "impl");
	expect(impls.map((candidate) => candidate.name)).toEqual(["impl Packet", "impl Display for Packet"]);
	expect(showMethods.map((candidate) => candidate.containerId)).toEqual([display.symbolId, impls[1]?.symbolId]);
	expect(newMethod.kind).toBe("method");
	expect(newMethod.containerId).toBe(impls[0]?.symbolId);
	expect(parseSymbolId(newMethod.symbolId)?.descriptors.map((descriptor) => descriptor.name)).toEqual([
		"Packet",
		"new",
	]);
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
	const text = `/* ${String.fromCodePoint(0x1f600)} */ pub struct Cart {}
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

	expect(cart.selectionRange?.start).toEqual({ line: 0, character: 20 });
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
		display: "u32",
	});
});

test("types a literal initializer from the number the lexer read", () => {
	const { provider, facts } = parse(`fn run() {
    let hex = 0x1e;
    let sum = 0x1e+2;
    let float = 1e3;
    let small = 7u8;
    let single = 2.5f32;
    let byte = b'a';
    let space = ' ';
    let bytes = b"a\\x00c";
    let raw_bytes = br#"ab"#;
    let c_text = c"text";
    let annotated: u64 = 5;
}
`);
	const typeOf = (name: string) => provider.typeOf({ symbolId: declaration(facts, name).symbolId });

	expect(typeOf("bytes")).toMatchObject({ status: "inferred", display: "&[u8; 3]" });
	expect(typeOf("raw_bytes")).toMatchObject({ status: "inferred", display: "&[u8; 2]" });
	expect(typeOf("c_text")).toMatchObject({ status: "inferred", display: "&CStr" });
	expect(typeOf("annotated")).toMatchObject({ status: "known", display: "u64" });
	expect(typeOf("hex")).toMatchObject({ status: "inferred", display: "i32" });
	expect(typeOf("float")).toMatchObject({ status: "inferred", display: "f64" });
	expect(typeOf("small")).toMatchObject({ status: "inferred", display: "u8" });
	expect(typeOf("single")).toMatchObject({ status: "inferred", display: "f32" });
	expect(typeOf("byte")).toMatchObject({ status: "inferred", display: "u8" });
	expect(typeOf("space")).toMatchObject({ status: "inferred", display: "char" });
	expect(facts.literals.map((literal) => [literal.value, literal.number])).toEqual([
		["0x1e", 30],
		["0x1e", 30],
		["2", 2],
		["1e3", 1000],
		["7u8", 7],
		["2.5f32", 2.5],
		["a\u0000c", undefined],
		["ab", undefined],
		["text", undefined],
		["5", 5],
	]);
	expect(facts.references.some((reference) => reference.name === "b")).toBe(false);
});

test("reads a method called on a tuple field or an integer", () => {
	const { facts } = parse("fn run(pair: (Vec<u8>, u8)) -> usize { pair.0.len() + 1.max(2) }\n");
	const calls = facts.references.filter((reference) => reference.role === "call").map((reference) => reference.name);

	expect(calls).toEqual(["len", "max"]);
});

test("indexes a CRLF file whose string literal spans lines", () => {
	const { facts } = parse('pub const S: &str = "a\r\nb";\r\npub fn after() {}\r\n');

	expect(facts.diagnostics).toEqual([]);
	expect(facts.declarations.map((candidate) => candidate.name)).toEqual(["S", "after"]);
});

test("keeps a trait impl method id free of comments in the impl header", () => {
	const header = (between: string) => `pub struct S;
pub trait A { fn f(&self); }
pub trait B { fn f(&self); }
impl A for S { fn f(&self) {} }
impl crate::${between}B for S { fn f(&self) {} }
`;
	const ids = (text: string) =>
		parse(text)
			.facts.declarations.filter((candidate) => candidate.name === "f" && candidate.kind === "method")
			.map((candidate) => candidate.symbolId);

	expect(ids(header("/* note */"))).toEqual(ids(header("")));
});

test("reports a format! string as one literal, its captured-identifier braces left verbatim", () => {
	// Rust has no string-interpolation syntax at the lexer level: `{name}` is plain text the
	// `format!` macro reads later, so the literal carries it unchanged and at its own range.
	const text = 'fn main() {\n    let cmd = format!("install {name}@{marketplace}");\n}\n';
	const { facts } = parse(text);

	expect(facts.literals.map((literal) => literal.value)).toEqual(["install {name}@{marketplace}"]);
	const literal = facts.literals[0];
	if (literal === undefined) throw new Error("missing literal");
	expect(coordinatesOf(text).sliceRange(literal.range)).toBe('"install {name}@{marketplace}"');
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
	expect(methods[1]?.containerId).toBe(declaration(facts, "impl Render<String> for Ref<'_>").symbolId);
	expect(methods[1]?.symbolId.startsWith(referenceType.symbolId)).toBe(true);
	expect(methods[1]?.languageKind).toBe("traitImplMethod");
	expect(methods[1]?.signature).toBe("fn render<'a>(&'a self, value: String) -> &'a str");
	expect(methods[1]?.metrics?.parameters).toBe(2);
	expect(provider.typeOf({ symbolId: methods[1]?.symbolId ?? "" })).toMatchObject({
		status: "known",
		display: expect.stringContaining("&'a str"),
	});
});

test("marks member accesses and later path segments qualified, and bare names not", () => {
	const text = `use crate::util::helper;
pub struct Item { count: i32 }
impl Item {
    fn make() -> Self { Item { count: 0 } }
    fn bump(&mut self) -> Option<i32> {
        self.count += 1;
        helper();
        crate::util::run();
        let other = Item::make();
        let got = other.value()?.total;
        std::dbg!(got);
        println!("{}", got);
        let list = Vec::<u8>::new();
        match got { LOW...HIGH => {} _ => {} }
        None
    }
}
`;
	const { facts } = parse(text);
	const qualifiedAt = (snippet: string, name: string) => {
		const at = text.indexOf(snippet) + snippet.indexOf(name);
		const start = coordinatesOf(text).rangeAt(at, at + name.length)?.start;
		if (start === undefined) throw new Error(`missing test text ${snippet}`);
		const found = facts.references.filter(
			(reference) =>
				reference.range.start.line === start.line && reference.range.start.character === start.character,
		);
		if (found.length === 0) throw new Error(`no reference ${name} in ${snippet}`);
		return [...new Set(found.map((reference) => reference.qualified))];
	};

	expect(facts.references.every((reference) => typeof reference.qualified === "boolean")).toBe(true);
	expect(qualifiedAt("use crate::util::helper", "helper")).toEqual([false]);
	expect(qualifiedAt("helper();", "helper")).toEqual([false]);
	expect(qualifiedAt("-> Option", "Option")).toEqual([false]);
	expect(qualifiedAt("{ count: 0 }", "count")).toEqual([true]);
	expect(qualifiedAt("self.count", "count")).toEqual([true]);
	expect(qualifiedAt("crate::util::run", "util")).toEqual([true]);
	expect(qualifiedAt("crate::util::run", "run")).toEqual([true]);
	expect(qualifiedAt("Item::make()", "Item")).toEqual([false]);
	expect(qualifiedAt("Item::make()", "make")).toEqual([true]);
	expect(qualifiedAt("other.value()", "other")).toEqual([false]);
	expect(qualifiedAt("other.value()", "value")).toEqual([true]);
	expect(qualifiedAt("?.total", "total")).toEqual([true]);
	expect(qualifiedAt("std::dbg!", "dbg")).toEqual([true]);
	expect(qualifiedAt("println!", "println")).toEqual([false]);
	expect(qualifiedAt("Vec::<u8>::new", "Vec")).toEqual([false]);
	expect(qualifiedAt("Vec::<u8>::new", "new")).toEqual([true]);
	expect(qualifiedAt("LOW...HIGH", "HIGH")).toEqual([false]);
});

test("names the innermost declaration a reference sits in as its origin, none past its last token", () => {
	const { facts } = parse(`struct Inner;
struct Pair(Inner);
impl Pair {
    fn make() -> Pair {
        fn helper() -> Inner { Inner }
        Pair(helper())
    }
}
fn local() {}Inner;
`);
	const fromOf = (name: string, line: number) =>
		facts.declarations.find(
			(candidate) =>
				candidate.symbolId ===
				facts.references.find((reference) => reference.name === name && reference.range.start.line === line)
					?.fromId,
		)?.name;

	expect(fromOf("Inner", 1)).toBe("Pair");
	expect(fromOf("Pair", 2)).toBe("impl Pair");
	expect(fromOf("Inner", 4)).toBe("helper");
	expect(fromOf("helper", 5)).toBe("make");
	expect(facts.references.find((reference) => reference.range.start.line === 8)).toMatchObject({ name: "Inner" });
	expect(fromOf("Inner", 8)).toBeUndefined();
});

test("imports each use-tree leaf by its whole path, an alias alone writing a local name", () => {
	const { facts } = parse(`use crate::util::{Thing, Other as Alias, *};
use self::local::Value;
use super::parent::{Parent, deep::{self, Leaf}};
extern crate alloc as heap;
fn run() { use std::mem::drop;drop(1); }
`);

	expect(facts.diagnostics).toEqual([]);
	expect(facts.imports.map((entry) => entry.specifier)).toEqual([
		"crate::util::Thing",
		"crate::util::Other",
		"crate::util::*",
		"self::local::Value",
		"super::parent::Parent",
		"super::parent::deep",
		"super::parent::deep::Leaf",
		"alloc",
		"std::mem::drop",
	]);
	expect(facts.imports.map((entry) => entry.imported.map((name) => `${name.name}>${name.local ?? ""}`))).toEqual([
		["Thing>"],
		["Other>Alias"],
		["*>"],
		["Value>"],
		["Parent>"],
		["deep>"],
		["Leaf>"],
		["alloc>heap"],
		["drop>"],
	]);
	expect(facts.references.filter((reference) => reference.role === "import")).toHaveLength(8);
	expect(facts.references.filter((reference) => reference.name === "Other")).toHaveLength(1);
	expect(
		facts.references.filter((reference) => reference.name === "drop").map((reference) => reference.role),
	).toEqual(["import", "call"]);
});

test("owns declarations in inline modules and gives fields and variants descriptor paths, a repeat its occurrence", () => {
	const { facts } = parse(`pub mod outer {
    pub mod inner {
        pub struct Item { pub value: i32, hidden: bool }
        pub enum State { Ready, Done(u8) }
    }
}
#[cfg(unix)]
struct Twin;
#[cfg(windows)]
struct Twin;
use A as B;
use B as A;
impl A { fn cyclic() {} }
`);
	const twins = facts.declarations.filter((candidate) => candidate.name === "Twin");

	expect(twins.map((twin) => parseSymbolId(twin.symbolId)?.descriptors.at(-1)?.occurrence)).toEqual([undefined, 2]);
	expect(declaration(facts, "cyclic").kind).toBe("method");
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

test("hangs an impl's items from the type its path names from the impl's module, and binds a path by every segment", () => {
	const { facts } = parse(`mod a { pub struct T; impl T { pub fn f() {} } }
mod b { pub struct T; impl T { pub fn f() {} } }
mod c { use super::a::T; impl T { pub fn g() {} } }
struct Root;
mod d { impl super::Root { fn h() {} } }
mod inner { pub struct N { pub field: u8 } }
use crate::inner::N;
fn run(n: N) -> u8 { b::T::f(); a::T::f(); crate::a::T::g(); n.field }
`);
	const bindingsOf = (name: string) =>
		facts.references
			.filter((reference) => reference.name === name && reference.range.start.line === 7)
			.map((reference) => reference.binding);
	const idOf = (id: string) => facts.declarations.find((candidate) => candidate.symbolId.endsWith(id))?.symbolId;

	expect(bindingsOf("f")).toMatchObject([{ symbolId: idOf("b/T#f().") }, { symbolId: idOf("a/T#f().") }]);
	expect(bindingsOf("g")).toMatchObject([{ symbolId: idOf("a/T#g().") }]);
	expect(bindingsOf("N")).toMatchObject([{ symbolId: idOf("inner/N#") }]);
	expect(bindingsOf("field")).toMatchObject([{ symbolId: idOf("inner/N#field.") }]);
	const members = facts.declarations
		.filter((candidate) => candidate.kind === "method")
		.map((candidate) => {
			const owner = facts.declarations.find((impl) => impl.symbolId === candidate.containerId);
			return `${parseSymbolId(candidate.symbolId)
				?.descriptors.map((part) => part.name)
				.join("/")}@${owner?.range.start.line}`;
		});

	expect(members).toEqual(["a/T/f@0", "b/T/f@1", "a/T/g@2", "Root/h@4"]);
});

test("names attributed fields and variants, and a struct variant's fields", () => {
	const { facts } = parse(`pub enum Shape {
    #[default]
    Unit,
    Named { width: u32 },
}
struct Entry {
    #[cfg(unix)]
    ino: u64,
    default: u8,
}
`);
	const width = declaration(facts, "width");

	expect(facts.declarations.map((candidate) => candidate.name)).toEqual([
		"Shape",
		"Unit",
		"Named",
		"width",
		"Entry",
		"ino",
		"default",
	]);
	expect(declaration(facts, "Unit").range.start).toEqual({ line: 1, character: 4 });
	expect(width.containerId).toBe(declaration(facts, "Named").symbolId);
	expect(width.visibility).toBe("public");
	expect(facts.references.some((reference) => reference.name === "width")).toBe(false);
});

test("reads every item past brackets, macro invocations and foreign blocks, and each item a body holds", () => {
	const { facts } = parse(`const A: [u8; 2] = [1; 2];
static S: u32 = { let x = 1; x };
struct Pair<F: Fn(u8) -> u8>(F);
lazy_static! { static ref HIDDEN: u8 = 0; }
extern "C" { fn c_abs(x: i32) -> i32; }
fn map<F: FnOnce(u8)>(f: F) {
    #[cfg(unix)]
    use std::os::unix::ffi::OsStrExt;
    const LOCAL: u8 = 1;
    fn helper(y: u8) -> u8 { y }
    struct Inner;
    let r#type = helper(LOCAL);
}
union r#type { a: u32 }
fn after() {}
`);
	const names = facts.declarations.map((candidate) => `${candidate.name}@${candidate.containerId ?? ""}`);
	const map = declaration(facts, "map").symbolId;

	expect(facts.diagnostics).toEqual([]);
	expect(names).toEqual([
		"A@",
		"S@",
		`x@${declaration(facts, "S").symbolId}`,
		"Pair@",
		"c_abs@",
		`x@${declaration(facts, "c_abs").symbolId}`,
		"map@",
		`f@${map}`,
		`LOCAL@${map}`,
		`helper@${map}`,
		`y@${declaration(facts, "helper").symbolId}`,
		`Inner@${map}`,
		`type@${map}`,
		"type@",
		`a@${facts.declarations.find((candidate) => candidate.languageKind === "union")?.symbolId}`,
		"after@",
	]);
	expect(declaration(facts, "Pair").range.end).toEqual({ line: 2, character: 32 });
	expect(facts.imports.map((entry) => entry.specifier)).toEqual(["std::os::unix::ffi::OsStrExt"]);
	expect(facts.references.some((reference) => reference.name === "cfg" || reference.name === "unix")).toBe(false);
	expect(facts.references.find((reference) => reference.name === "LOCAL")?.binding).toMatchObject({
		symbolId: declaration(facts, "LOCAL").symbolId,
	});
});

test("names the line a member after a container's last one goes on, or none without a safe point", () => {
	const { facts } = parse(`pub struct Point {
    pub x: i32,
    pub y: i32,
}
pub union Bits {
    pub int: u32,
    pub float: f32,
}
pub enum State {
    Ready,
    Done(u8),
}
pub trait Shape {
    fn area(&self) -> f64;
}
pub mod nested {
    pub fn inner() {}
    }
pub struct Empty {
}
pub struct Tight { pub c: i32 }
pub struct Unended {
    pub a: i32
}
pub enum Crowded { A,
    B,
}
pub mod noted {
    pub fn f() {}
    /* note */ }
pub trait Spanned {
    fn f(&self); /* opens
    closes */ }
pub struct Unit;
pub struct Pair(i32, i32);
pub struct Inline {}
`);
	const lines = Object.fromEntries(
		facts.declarations
			.filter((candidate) => candidate.containerId === undefined)
			.map((candidate) => [candidate.name, candidate.memberInsertLine ?? null]),
	);

	expect(lines).toEqual({
		Point: 3,
		Bits: 7,
		State: 11,
		Shape: 14,
		nested: 17,
		Empty: 19,
		Tight: null,
		Unended: null,
		Crowded: 26,
		noted: null,
		Spanned: null,
		Unit: null,
		Pair: null,
		Inline: null,
	});
	expect(declaration(facts, "Bits")).toMatchObject({
		kind: "struct",
		languageKind: "union",
		signature: "pub union Bits",
	});
	expect(declaration(facts, "float").containerId).toBe(declaration(facts, "Bits").symbolId);
	expect(facts.references.some((reference) => reference.name === "union")).toBe(false);
});

test("counts only type brackets as angle depth, so a comparison or a shift ends nothing early", () => {
	const { facts } = parse(`pub struct Grid {
    pub cells: [u8; 1 << 2],
    pub rows: Vec<Vec<u8>>,
}
fn run(x: u8, y: u8) {
    let less = x < y;
    let shifted = x >> 1;
    let after = 2;
}
`);

	expect(facts.declarations.map((candidate) => candidate.name)).toEqual([
		"Grid",
		"cells",
		"rows",
		"run",
		"x",
		"y",
		"less",
		"shifted",
		"after",
	]);
	expect(declaration(facts, "cells").signature).toBe("pub cells: [u8; 1 << 2]");
});

test("reports each comment's trivia and the blank lines on the wire, and withholds both from an outline", () => {
	const text = 'pub const A: &str = "one\n\ntwo"; // trailing\n\n/* own */\npub const B: i32 = 1;\n';
	const full = parse(text).facts;
	const outline = parse(text, "src/lib.rs", "outline").facts;

	expect(full.comments).toEqual([
		expect.objectContaining({ text: "// trailing", codeBefore: true, codeAfter: false }),
		expect.objectContaining({ text: "/* own */", codeBefore: false, codeAfter: false }),
	]);
	expect(full.blankLines).toEqual([3]);
	expect(outline.blankLines).toBeUndefined();
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

test("declares only a pattern's bindings: never a constructor, path, field label or wildcard", () => {
	const { facts } = parse(`fn patterns(opt: Option<u8>, p: Point) {
    let Some(x) = opt else { return };
    let Point { x: px, y, .. } = p;
    let Wrapper(inner) = wrap;
    let N = 3;
    let _ = x;
    if let None = opt {}
    while let Some(Kind::Deep(v)) | Some(Kind::Other(v)) = next() {}
    match opt { Some(found) if found > 1 => {} LIMIT => {} rest @ _ => {} }
    for (index, value) in pairs {}
}
`);
	const locals = facts.declarations
		.filter((candidate) => candidate.visibility === "local" && candidate.languageKind !== "parameter")
		.map((candidate) => `${candidate.languageKind}:${candidate.name}`);

	expect(locals).toEqual([
		"let:x",
		"let:px",
		"let:y",
		"let:inner",
		"let:N",
		"let:v",
		"matchBinding:found",
		"matchBinding:rest",
		"forBinding:index",
		"forBinding:value",
	]);
	expect(facts.references.some((reference) => reference.name === "_")).toBe(false);
	expect(facts.references.find((reference) => reference.name === "Some")?.role).toBe("call");
});

test("reads an or-pattern's later sites of a binding as writes of that one binding", () => {
	const { facts } = parse(`fn pick(value: Option<u8>, pair: Pair) -> u8 {
    let total = match value { Some(x) | Other(x) => x, _ => 0 };
    let (A(y) | B(y)) = pair;
    total + y
}
`);
	const binding = (name: string) => declaration(facts, name).symbolId;
	const uses = (name: string) =>
		facts.references
			.filter((reference) => reference.name === name)
			.map(
				(reference) =>
					`${reference.role}:${reference.binding.status === "bound" && reference.binding.symbolId}`,
			);

	expect(facts.declarations.filter((candidate) => ["x", "y"].includes(candidate.name))).toHaveLength(2);
	expect(uses("x")).toEqual([`write:${binding("x")}`, `read:${binding("x")}`]);
	expect(uses("y")).toEqual([`write:${binding("y")}`, `read:${binding("y")}`]);
});

test("decides a let-else from the statement, past an initializer's own `if` chain", () => {
	const { facts } = parse(`const N: u8 = 1;
fn run(opt: Option<u8>, flag: bool) {
    let Some(N) = match opt { x => Some(x) } else { return; };
    let v = if flag { 1 } else if !flag { 2 } else { 3 };
}
`);
	const locals = facts.declarations
		.filter((candidate) => candidate.visibility === "local" && candidate.languageKind !== "parameter")
		.map((candidate) => candidate.name);

	expect(locals).toEqual(["x", "v"]);
	expect(declaration(facts, "v").range.end).toEqual({ line: 3, character: 56 });
	expect(facts.references.find((reference) => reference.name === "N")?.binding).toMatchObject({
		symbolId: declaration(facts, "N").symbolId,
	});
});

test("binds each of many shadowing `let`s to the one before it", () => {
	const lets = Array.from({ length: 4000 }, () => "    let x = x;").join("\n");
	const { facts } = parse(`fn run(x: u8) {\n${lets}\n}\n`);
	const locals = facts.declarations.filter((candidate) => candidate.name === "x");
	const reads = facts.references.filter((reference) => reference.name === "x");

	expect(reads).toHaveLength(4000);
	expect(reads.map((reference) => reference.binding)).toMatchObject(
		locals.slice(0, -1).map((local) => ({ symbolId: local.symbolId })),
	);
}, 5_000);

test("scopes each local to where Rust sees it, so a use binds the nearest and a closure's parameters shadow", () => {
	const text = `fn shadow(x: u8, items: Vec<u8>) -> u8 {
    let early = x;
    let x = x + 1;
    {
        let x = x * 2;
        let inner = x;
    }
    let add = |x: u8, step| x + step;
    let doubled = items.iter().map(|x| x * 2);
    let sum = add(x, 1);
    fn nested(x: u8) -> u8 { x }
    let caught = match x { value => value, };
    sum + caught
}
`;
	const { facts } = parse(text);
	const at = (line: number, character: number) =>
		facts.references.find(
			(reference) => reference.range.start.line === line && reference.range.start.character === character,
		)?.binding;
	const local = (line: number, name: string) =>
		facts.declarations.find((candidate) => candidate.name === name && candidate.range.start.line === line)
			?.symbolId;
	const parameter = facts.declarations.find((candidate) => candidate.symbolId.endsWith("shadow().(x)"))?.symbolId;

	expect(at(1, 16)).toMatchObject({ symbolId: parameter });
	expect(at(2, 12)).toMatchObject({ symbolId: parameter });
	expect(at(4, 16)).toMatchObject({ symbolId: local(2, "x") });
	expect(at(5, 20)).toMatchObject({ symbolId: local(4, "x") });
	expect(at(7, 28)).toMatchObject({ symbolId: local(7, "x") });
	expect(at(7, 32)).toMatchObject({ symbolId: local(7, "step") });
	expect(at(8, 39)).toMatchObject({ symbolId: local(8, "x") });
	expect(at(9, 14)).toMatchObject({ symbolId: local(7, "add") });
	expect(at(9, 18)).toMatchObject({ symbolId: local(2, "x") });
	expect(at(10, 29)).toMatchObject({ symbolId: local(10, "x") });
	expect(at(11, 36)).toMatchObject({ symbolId: local(11, "value") });
	expect(
		facts.declarations
			.filter((candidate) => candidate.languageKind === "closureParameter")
			.map((candidate) => candidate.containerId),
	).toEqual(Array(3).fill(declaration(facts, "shadow").symbolId));
});

test("confines an item or `use` in a body to the block holding it, where it shadows the scopes around", () => {
	const { facts } = parse(`enum Kind { First }
mod other { pub struct First; }
use other::First;
fn run() {
    {
        use Kind::*;
        fn inner() {}
        let a = First;
        inner();
    }
    let b = First;
    inner();
}
fn helper() {}
struct Unit;
impl Unit {
    fn helper() {}
    fn go() { helper(); }
}
`);
	const bindingOf = (name: string, line: number) =>
		facts.references.find((reference) => reference.name === name && reference.range.start.line === line)?.binding;
	const idOf = (id: string) => facts.declarations.find((candidate) => candidate.symbolId.endsWith(id))?.symbolId;

	expect(bindingOf("First", 7)).toMatchObject({ symbolId: idOf("Kind#First.") });
	expect(bindingOf("inner", 8)).toMatchObject({ symbolId: declaration(facts, "inner").symbolId });
	expect(bindingOf("First", 10)).toMatchObject({ symbolId: idOf("other/First#") });
	expect(bindingOf("inner", 11)).toMatchObject({ status: "unbound" });
	expect(bindingOf("helper", 17)).toMatchObject({ symbolId: idOf(" helper().") });
});

test("binds a field only through `.` or a label, a method or tuple variant as a call, and a segment before `::` as a module or type", () => {
	const text = `struct Size { width: u32, len: u32 }
impl Size {
    fn len(&self) -> u32 { self.len }
    fn grow(&self, width: u32) -> Size {
        let total = self.len();
        Size { width: width + total, len: width }
    }
}
mod shapes { pub fn area() {} }
enum Shape { Circle(u8) }
struct Circle;
fn draw(shapes: u8) { Shape::Circle(1); shapes::area(); }
trait Named { fn named() -> u8; }
impl Named for Size { fn named() -> u8 { 0 } } struct Pair<T>(T); impl<T> Pair<T> { fn make() {} }
fn names() { <Size as Named>::named(); <Size>::grow; Pair::<Size>::make(); }
`;
	const { facts } = parse(text);
	const named = (name: string, line: number, character: number) =>
		facts.references.find(
			(reference) =>
				reference.name === name &&
				reference.range.start.line === line &&
				reference.range.start.character === character,
		);
	const field = (name: string) =>
		facts.declarations.find((candidate) => candidate.name === name && candidate.kind === "field")?.symbolId;

	expect(named("len", 2, 32)?.binding).toMatchObject({ symbolId: field("len") });
	expect(named("len", 4, 25)?.binding).toMatchObject({
		symbolId: facts.declarations.find((candidate) => candidate.name === "len" && candidate.kind === "method")
			?.symbolId,
	});
	expect(named("width", 5, 15)).toMatchObject({ qualified: true, binding: { symbolId: field("width") } });
	expect(named("width", 5, 22)?.binding).toMatchObject({ symbolId: expect.stringContaining("grow().(width)") });
	expect(named("width", 5, 22)?.role).toBe("read");
	expect(named("Circle", 11, 29)?.binding).toMatchObject({ symbolId: declaration(facts, "Circle").symbolId });
	expect(declaration(facts, "Circle").containerId).toBe(declaration(facts, "Shape").symbolId);
	expect(named("shapes", 11, 40)?.binding).toMatchObject({ symbolId: declaration(facts, "shapes").symbolId });
	expect(named("area", 11, 48)?.binding).toMatchObject({ symbolId: declaration(facts, "area").symbolId });
	expect(named("named", 14, 30)?.binding).toMatchObject({ symbolId: expect.stringContaining(" Named#named().") });
	expect(named("grow", 14, 47)?.binding).toMatchObject({ symbolId: declaration(facts, "grow").symbolId });
	expect(named("make", 14, 67)?.binding).toMatchObject({ symbolId: declaration(facts, "make").symbolId });
});

test("binds `.name` only through its receiver's established type: an annotation, a constructor, `self` or a label", () => {
	const { facts } = parse(`struct B { size: u8 }
impl B { fn ping(&self) -> u8 { self.size } }
struct C;
impl C { fn ping(&self) {} fn make() -> Self { Self } fn call(&self, other: Unknown) { other.ping(); self.inner.ping(); } }
enum E { V { x: u8 } } impl E { fn describe(&self) {} }
struct S { y: u8 }
impl S { fn new() -> Self { Self { y: 1 } } } fn make_s() -> S { S::new() }
fn call(b: &B, c: C, other: Box<B>) -> E {
    b.ping();
    let d: B = make();
    d.size;
    c.ping();
    other.ping();
    let s = S::new(); s.y; let t = S { y: 2 }; t.y; let f = |r: S| r.y; let e = E::V { x: 3 }; e.describe(); let m = make_s(); m.y;
    E::V { x: 1 }
}
`);
	const bindingsOf = (name: string, line: number) =>
		facts.references
			.filter((reference) => reference.name === name && reference.range.start.line === line)
			.map((reference) => reference.binding);
	const bindingOf = (name: string, line: number) => bindingsOf(name, line)[0];
	const idOf = (id: string) => facts.declarations.find((candidate) => candidate.symbolId.endsWith(id))?.symbolId;

	expect(bindingOf("size", 1)).toMatchObject({ symbolId: idOf("B#size.") });
	expect(bindingsOf("ping", 3)).toMatchObject([{ status: "unbound" }, { status: "unbound" }]);
	expect(bindingOf("ping", 8)).toMatchObject({ symbolId: idOf("B#ping().") });
	expect(bindingOf("size", 10)).toMatchObject({ symbolId: idOf("B#size.") });
	expect(bindingOf("ping", 11)).toMatchObject({ symbolId: idOf("C#ping().") });
	expect(bindingOf("ping", 12)).toMatchObject({ status: "unbound" });
	expect(bindingsOf("y", 13)).toMatchObject(Array(5).fill({ symbolId: idOf("S#y.") }));
	expect(bindingOf("describe", 13)).toMatchObject({ symbolId: idOf("E#describe().") });
	expect(bindingOf("x", 14)).toMatchObject({ symbolId: idOf("E#V.x.") });
	expect(bindingOf("y", 6)).toMatchObject({ symbolId: idOf("S#y.") });
});

test("names a receiver's type from where its annotation is written: the nearest import or a glob, or a generic's bounds", () => {
	const { facts } = parse(`mod a { pub struct T; impl T { pub fn hit(&self) {} } }
mod b { pub struct U; impl U { pub fn hit(&self) {} } }
mod g { pub struct G { pub w: u8 } }
use a::T;
use g::*;
struct Item;
impl Item { fn ping(&self) {} }
fn read(x: T, y: G) -> u8 {
    x.hit();
    { use b::U as T; let z: T = make(); z.hit(); }
    y.w
}
fn invoke<Item: Ping>(value: Item) { value.ping(); Item::ping(&value); }
impl<Item: Ping> Wrap for Item { fn go(&self) { self.ping(); self.go(); } }
trait Ping { fn ping(&self); }
trait Pong { fn ping(&self); }
fn both<P>(pair: P) where P: Ping + Pong { pair.ping(); }
fn plain<Q>(bare: Q) { bare.ping(); }
`);
	const bindingOf = (name: string, line: number) =>
		facts.references.find((reference) => reference.name === name && reference.range.start.line === line)?.binding;
	const idOf = (id: string) => facts.declarations.find((candidate) => candidate.symbolId.endsWith(id))?.symbolId;

	expect(bindingOf("hit", 8)).toMatchObject({ symbolId: idOf("a/T#hit().") });
	expect(bindingOf("T", 9)).toMatchObject({ symbolId: idOf("b/U#") });
	expect(bindingOf("hit", 9)).toMatchObject({ symbolId: idOf("b/U#hit().") });
	expect(bindingOf("w", 10)).toMatchObject({ symbolId: idOf("g/G#w.") });
	const ping = idOf("Ping#ping().");
	const bindingsOf = (name: string, line: number) =>
		facts.references
			.filter((reference) => reference.name === name && reference.range.start.line === line)
			.map((reference) => reference.binding);

	expect(bindingOf("Item", 12)).toMatchObject({ status: "unbound" });
	expect(bindingsOf("ping", 12)).toMatchObject([{ symbolId: ping }, { symbolId: ping }]);
	expect(bindingOf("ping", 13)).toMatchObject({ symbolId: ping });
	expect(bindingOf("go", 13)).toMatchObject({ symbolId: declaration(facts, "go").symbolId });
	expect(bindingOf("ping", 16)).toMatchObject({ status: "ambiguous", candidates: [ping, idOf("Pong#ping().")] });
	expect(bindingOf("ping", 17)).toMatchObject({ status: "unbound" });
	expect(parseSymbolId(declaration(facts, "go").symbolId)?.descriptors.map((part) => part.kind)).toEqual([
		"meta",
		"method",
	]);
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

test("reads a name in type brackets or tuple fields as a type use and a turbofish call as a call", () => {
	const { facts } = parse(`fn run(items: Vec<Item>) -> HashMap<Key, Iter<Item = Value>> {
    let parsed = items.iter().collect::<Vec<Item>>();
    size_of::<Item>();
}
struct Pair(Item, Key);
enum Either { Left(Item) }
`);
	const roles = (name: string) =>
		facts.references.filter((reference) => reference.name === name).map((reference) => reference.role);

	expect(roles("Item")).toEqual(["typeUse", "typeUse", "typeUse", "typeUse", "typeUse", "typeUse"]);
	expect(roles("Key")).toEqual(["typeUse", "typeUse"]);
	expect(roles("Value")).toEqual(["typeUse"]);
	expect(roles("collect")).toEqual(["call"]);
	expect(roles("size_of")).toEqual(["call"]);
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

	expect((facts.comments ?? []).map((comment) => comment.text)).toEqual([
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

	expect((facts.comments ?? []).map((comment) => coordinates.sliceRange(comment.range))).toEqual(
		(facts.comments ?? []).map((comment) => comment.text),
	);
	const leadingRange = rangeOfText(text, "// leading");
	const inlineRange = rangeOfText(text, "/* inline */");
	if (leadingRange === undefined || inlineRange === undefined) throw new Error("comment range missing");
	expect((facts.comments ?? []).map((comment) => comment.range)).toEqual([leadingRange, inlineRange]);
});

test("leaves a comment marker inside a literal out of the comment list", () => {
	const { facts } = parse(`pub const URL: &str = "https://example.com/path";
pub const BLOCK: &str = "/* not a comment */";
pub const RAW: &str = r#"// not a comment"#;
pub const BYTES: &[u8] = b"/* not a comment */";
pub const SLASH: char = '/';
// real
`);

	expect((facts.comments ?? []).map((comment) => comment.text)).toEqual(["// real"]);
});

test("reports an unterminated block comment as one span reaching the end of file", () => {
	const { facts } = parse("pub const BEFORE: i32 = 1;\n/* opened /* nested and never closed");

	expect((facts.comments ?? []).map((comment) => comment.text)).toEqual(["/* opened /* nested and never closed"]);
	expect(facts.diagnostics.some((diagnostic) => diagnostic.message.includes("no closing delimiter"))).toBe(true);
});

test("closes an empty block comment instead of swallowing the rest of the file", () => {
	const { facts } = parse("pub const A: i32 = 1 /**/;\npub struct After;\n");

	expect((facts.comments ?? []).map((comment) => comment.text)).toEqual(["/**/"]);
	expect(facts.declarations.map((candidate) => candidate.name)).toContain("After");
});

test("reports a shebang line and leaves an inner attribute alone", () => {
	const shebang = parse("#!/usr/bin/env run-cargo-script\npub const A: i32 = 1;\n", "src/tool.rs").facts;
	const attribute = parse("#![allow(dead_code)]\n// real\n", "src/attr.rs").facts;
	const spaced = parse("#! [allow(dead_code)]\n// real\n", "src/spaced.rs").facts;

	expect((shebang.comments ?? []).map((comment) => comment.text)).toEqual(["#!/usr/bin/env run-cargo-script"]);
	expect((attribute.comments ?? []).map((comment) => comment.text)).toEqual(["// real"]);
	expect((spaced.comments ?? []).map((comment) => comment.text)).toEqual(["// real"]);
});

test("ends a line comment before a CRLF terminator", () => {
	const { facts } = parse("// leading\r\npub const A: i32 = 1;\r\n");

	expect((facts.comments ?? []).map((comment) => comment.text)).toEqual(["// leading"]);
});

test("withholds comments from an outline parse, as it withholds literals", () => {
	const { facts } = parse('// leading\npub const A: &str = "value";\n', "src/lib.rs", "outline");

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
