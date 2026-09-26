import { expect, test } from "bun:test";
import { FOLD_MARK } from "@nyaa-lexicon/protocol";
import { parseRustFile } from "../parser.js";

function fold(open: string, close: string): string {
	return `${open}${FOLD_MARK}${close}`;
}

function declarations(text: string) {
	return parseRustFile("src/lib.rs", text).declarations;
}

/** Signatures by name; a repeated name keeps the last. */
function signatures(text: string): Record<string, string | undefined> {
	return Object.fromEntries(declarations(text).map((declaration) => [declaration.name, declaration.signature]));
}

test("reads a function header from its attributes to its body, without moving its range", () => {
	const found = declarations(`#![allow(dead_code)]

/// Runs.
#[must_use]
pub async unsafe fn run<T: Send>(
    items: Vec<T>, // each
    /* count */ limit: usize,
) -> Result<(), Error>
where
    T: 'static,
{
    Ok(())
}
`);
	const run = found.find((declaration) => declaration.name === "run");

	expect(run?.signature).toBe(
		"#[must_use] pub async unsafe fn run<T: Send>(items: Vec<T>, limit: usize) -> Result<(), Error> where T: 'static",
	);
	expect(run?.range.start).toEqual({ line: 4, character: 0 });
	expect(found.find((declaration) => declaration.name === "items")?.signature).toBeUndefined();
});

test("keeps a trait method's return type and gives a trait impl method only its own header", () => {
	const text = `pub trait Render<T>: Clone
where
    T: Default,
{
    const MAX: u32;
    type Output;
    fn render(&self, value: T) -> String;
}

impl Render<u8> for Meters {
    #[inline]
    fn render(&self, value: u8) -> String {
        String::new()
    }
}
`;
	const renders = declarations(text).filter((declaration) => declaration.name === "render");

	expect(signatures(text)).toMatchObject({
		Render: "pub trait Render<T>: Clone where T: Default",
		MAX: "const MAX: u32",
		Output: "type Output",
	});
	expect(renders.map((declaration) => declaration.signature)).toEqual([
		"fn render(&self, value: T) -> String",
		"#[inline] fn render(&self, value: u8) -> String",
	]);
});

test("folds literal containers written as values and keeps calls, indexing and types", () => {
	expect(
		signatures(`pub const TABLE: [&str; 2] = [
    "a",
    "b",
];
const NAMES: Vec<&str> = vec!["a", "b"];
const PAIR: (i32, i32) = (1, 2);
const POINT: Point = Point { x: 1, y: 2 };
const ADD: fn(i32) -> i32 = |x| {
    x + 1
};
static mut BUFFER: &mut [u8] = &mut [0; 4];
const EMPTY: [u8; 0] = [];
const GROUPED: i32 = (1 + 2) * 3;
const INDEXED: u8 = TABLE[0];
const CALLED: Option<Vec<u8>> = Some(vec![1]);
const SIZE: usize = size_of::<[u8; 4]>();
const VERSION: &str = env!("VERSION");
`),
	).toEqual({
		TABLE: `pub const TABLE: [&str; 2] = ${fold("[", "]")}`,
		NAMES: `const NAMES: Vec<&str> = vec!${fold("[", "]")}`,
		PAIR: `const PAIR: (i32, i32) = ${fold("(", ")")}`,
		POINT: `const POINT: Point = Point ${fold("{", "}")}`,
		ADD: `const ADD: fn(i32) -> i32 = |x| ${fold("{", "}")}`,
		BUFFER: `static mut BUFFER: &mut [u8] = &mut ${fold("[", "]")}`,
		EMPTY: "const EMPTY: [u8; 0] = []",
		GROUPED: "const GROUPED: i32 = (1 + 2) * 3",
		INDEXED: "const INDEXED: u8 = TABLE[0]",
		CALLED: `const CALLED: Option<Vec<u8>> = Some(vec!${fold("[", "]")})`,
		SIZE: "const SIZE: usize = size_of::<[u8; 4]>()",
		VERSION: 'const VERSION: &str = env!("VERSION")',
	});
});

test("gives types, fields, variants, aliases, modules and macros their headers", () => {
	expect(
		signatures(`#[derive(Debug)]
/// Meters.
pub(crate) struct Meters(pub f64);

pub struct Unit;

pub struct Wrapper<T>
where
    T: Clone,
{
    pub value: T,
    hidden: /* inline */ bool,
}

#[repr(u8)]
pub enum State {
    Ready,
    Move { x: i32 },
    Write(String),
    Done = 1 << 2,
}

pub type Pair = (i32, [u8; 2]);

pub mod nested {}

mod external;

#[macro_export]
macro_rules! make {
    () => {};
}
`),
	).toMatchObject({
		Meters: "#[derive(Debug)] pub(crate) struct Meters(pub f64)",
		Unit: "pub struct Unit",
		Wrapper: "pub struct Wrapper<T> where T: Clone",
		value: "pub value: T",
		hidden: "hidden: bool",
		State: "#[repr(u8)] pub enum State",
		Ready: "Ready",
		Move: "Move",
		Write: "Write(String)",
		Done: "Done = 1 << 2",
		Pair: "pub type Pair = (i32, [u8; 2])",
		nested: "pub mod nested",
		external: "mod external",
		make: "#[macro_export] macro_rules! make",
	});
});

test("reads a single binding's let to its semicolon or block, and a pattern's bindings alone", () => {
	expect(
		signatures(`pub fn run(items: Vec<i32>) {
    let (mut first, ref second) = (1, 2);
    let values: Vec<[u8; 2]> = vec![[1, 2]];
    let adder = |x: &[i32]| -> [i32; 2] {
        [x[0], 1]
    };
    let make = move || -> [u8; 2] { [0; 2] };
    let total: i32 = items
        .iter() // each
        .sum();
    if let [only] = items.as_slice() {
        drop(only);
    }
}
`),
	).toMatchObject({
		first: "let mut first",
		second: "let ref second",
		values: `let values: Vec<[u8; 2]> = vec!${fold("[", "]")}`,
		adder: `let adder = |x: &[i32]| -> [i32; 2] ${fold("{", "}")}`,
		make: `let make = move || -> [u8; 2] ${fold("{", "}")}`,
		total: "let total: i32 = items.iter().sum()",
		only: "let [only] = items.as_slice()",
	});
});

test("keeps a pattern's headers linear in its binding count", () => {
	const rendered = (count: number) => {
		const names = Array.from({ length: count }, (_, index) => `a${index}`).join(", ");
		const found = declarations(`fn run() {\n    let (${names}) = pair;\n}\n`);
		return found.reduce((total, declaration) => total + (declaration.signature?.length ?? 0), 0);
	};
	// Linear reads 8x; the whole pattern per binding read 64x.
	expect(rendered(4_000) / rendered(500)).toBeLessThan(24);
});

test("keeps a literal's spacing and escapes its line breaks", () => {
	expect(
		signatures(`pub const SEP: &str = "a  b";
pub const DOC: &str = "one
  two";
const RAW: &str = r#"x  "y"
z"#;
const BYTES: &[u8] = b"a  b";
const TAB: char = '\t';
const LIST: [&str; 1] = ["a  b"];
#[deprecated(note = "use  g")]
pub fn f() {}
`),
	).toEqual({
		SEP: 'pub const SEP: &str = "a  b"',
		DOC: 'pub const DOC: &str = "one\\n  two"',
		RAW: 'const RAW: &str = r#"x  "y"\\nz"#',
		BYTES: 'const BYTES: &[u8] = b"a  b"',
		TAB: "const TAB: char = '\\t'",
		LIST: `const LIST: [&str; 1] = ${fold("[", "]")}`,
		f: '#[deprecated(note = "use  g")] pub fn f()',
	});
});
