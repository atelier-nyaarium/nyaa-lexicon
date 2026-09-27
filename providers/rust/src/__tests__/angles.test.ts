import { expect, test } from "bun:test";
import { typeBrackets } from "../angles.js";
import { tokenize } from "../tokens.js";

/** The text with each type bracket's `<` and `>` swapped for `[` and `]`; operators stay. */
function bracketed(text: string): string {
	const offsets = new Set(typeBrackets(tokenize(text).tokens).offsets);
	return [...text].map((character, at) => (offsets.has(at) ? (character === "<" ? "[" : "]") : character)).join("");
}

test("reads every angle in an item header as a bracket, however many a token closes", () => {
	expect(bracketed("pub fn f<T: Into<Vec<u8>>>(x: T) -> Option<T> where T: Ord {}")).toBe(
		"pub fn f[T: Into[Vec[u8]]](x: T) -> Option[T] where T: Ord {}",
	);
	expect(bracketed("impl<T> From<T> for Box<T> {}")).toBe("impl[T] From[T] for Box[T] {}");
	expect(bracketed("pub type A<T> = Box<dyn Fn(T) -> Vec<T>>;")).toBe("pub type A[T] = Box[dyn Fn(T) -> Vec[T]];");
	expect(bracketed("struct S<const N: usize = 3, T = Vec<u8>>;")).toBe("struct S[const N: usize = 3, T = Vec[u8]];");
});

test("reads a comparison or a shift in a value as an operator", () => {
	expect(bracketed("const A: u32 = 1 << 2 >> 1;")).toBe("const A: u32 = 1 << 2 >> 1;");
	expect(bracketed("const B: bool = X < Y && Z > W;")).toBe("const B: bool = X < Y && Z > W;");
	expect(bracketed("fn f() { let v: Vec<u8> = a < b; x >>= 1; y >= 2; }")).toBe(
		"fn f() { let v: Vec[u8] = a < b; x >>= 1; y >= 2; }",
	);
	expect(bracketed("enum E { A = 1 << 2, B { x: Vec<u8> }, C(Vec<u8>) }")).toBe(
		"enum E { A = 1 << 2, B { x: Vec[u8] }, C(Vec[u8]) }",
	);
});

test("reads an array length and a const block as expressions inside a type", () => {
	expect(bracketed("struct S { a: [u8; 1 << 2], b: Vec<u8> }")).toBe("struct S { a: [u8; 1 << 2], b: Vec[u8] }");
	expect(bracketed("fn f() -> Foo<{ 1 << 2 }> {}")).toBe("fn f() -> Foo[{ 1 << 2 }] {}");
});

test("opens a bracket in an expression only for a turbofish, a qualified path or a cast's type", () => {
	expect(bracketed("fn f() { let n = size_of::<u8>() << 1; }")).toBe("fn f() { let n = size_of::[u8]() << 1; }");
	expect(bracketed("fn f() { let d = <u8 as Default>::default() < 3; }")).toBe(
		"fn f() { let d = [u8 as Default]::default() < 3; }",
	);
	expect(bracketed("fn f() { let c = x as u64 > 2; let t = y as Box<u8>; }")).toBe(
		"fn f() { let c = x as u64 > 2; let t = y as Box[u8]; }",
	);
	expect(bracketed("fn f() { v.iter().collect::<Vec<Vec<u8>>>(); }")).toBe(
		"fn f() { v.iter().collect::[Vec[Vec[u8]]](); }",
	);
});

test("reads a closure's parameter and return types as types and its body as an expression", () => {
	expect(bracketed("fn f() { let g = |v: Vec<u8>| v.len() < 3; }")).toBe(
		"fn f() { let g = |v: Vec[u8]| v.len() < 3; }",
	);
	expect(bracketed("fn f() { let g = move |a| -> Option<u8> { a < 1 }; }")).toBe(
		"fn f() { let g = move |a| -> Option[u8] { a < 1 }; }",
	);
});

test("ends a condition's let at its body and reads items and macros inside a body", () => {
	expect(bracketed("fn f() { if let Some(x) = m.get::<u8>(&k) { x < 3 } else { a > b } }")).toBe(
		"fn f() { if let Some(x) = m.get::[u8](&k) { x < 3 } else { a > b } }",
	);
	expect(bracketed("fn f() { fn g<T>() {} struct L<T>(T); assert!(a < b); }")).toBe(
		"fn f() { fn g[T]() {} struct L[T](T); assert!(a < b); }",
	);
	expect(bracketed("#[cfg(x)] fn f() { let v: Vec<Vec<u8>>= w; }")).toBe(
		"#[cfg(x)] fn f() { let v: Vec[Vec[u8]]= w; }",
	);
});
