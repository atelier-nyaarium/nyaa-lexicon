import { describe, expect, test } from "bun:test";
import { composeSymbolId } from "@nyaa-lexicon/protocol";
import { parseCppFile } from "../parser.js";

const id = (module: string, descriptors: Parameters<typeof composeSymbolId>[0]["descriptors"]) =>
	composeSymbolId({ language: "cpp", module, descriptors });

function declarationIds(text: string): string[] {
	return parseCppFile("identity.cpp", text)
		.declarations.filter((item) => item.kind === "class" || item.kind === "method")
		.map((item) => item.symbolId)
		.sort();
}

describe("C++ stable declaration identity", () => {
	test("matches overload definitions by parameter signature", () => {
		const prefix = "class A { public: void f(int); void f(double); };\n";
		const first = declarationIds(`${prefix}void A::f(double) {}\nvoid A::f(int) {}\n`);
		const second = declarationIds(`${prefix}void A::f(int) {}\nvoid A::f(double) {}\n`);
		expect(first).toEqual(second);
		expect(first).toEqual([
			id("identity.cpp", [{ kind: "type", name: "A" }]),
			id("identity.cpp", [
				{ kind: "type", name: "A" },
				{ kind: "method", name: "f" },
			]),
			id("identity.cpp", [
				{ kind: "type", name: "A" },
				{ kind: "method", name: "f", disambiguator: "1" },
			]),
		]);
	});

	test("keeps a qualified definition under its namespace", () => {
		const sources = [
			"namespace N { class A { public: void f(); }; void A::f() {} }\n",
			"namespace N { class A { public: void f() {} }; }\n",
		];
		const facts = parseCppFile("identity.cpp", sources[0] as string);
		expect(facts.declarations.find((item) => item.name === "f")?.symbolId).toBe(
			id("identity.cpp", [
				{ kind: "namespace", name: "N" },
				{ kind: "type", name: "A" },
				{ kind: "method", name: "f" },
			]),
		);
		expect(
			parseCppFile("identity.cpp", sources[1] as string).declarations.find((item) => item.name === "f")?.symbolId,
		).toBe(
			id("identity.cpp", [
				{ kind: "namespace", name: "N" },
				{ kind: "type", name: "A" },
				{ kind: "method", name: "f" },
			]),
		);
	});

	test("merges template member definitions", () => {
		const sources = [
			"template<class T> class A { void f(); }; template<class T> void A<T>::f() {}\n",
			"template < class T > class A { void f(); }; template < class T > void A < T > :: f() {}\n",
		];
		const facts = parseCppFile("identity.cpp", sources[0] as string);
		expect(facts.declarations.filter((item) => item.name === "f")).toHaveLength(1);
		expect(facts.declarations.find((item) => item.name === "f")?.symbolId).toBe(
			id("identity.cpp", [
				{ kind: "type", name: "A" },
				{ kind: "method", name: "f" },
			]),
		);
		expect(
			parseCppFile("identity.cpp", sources[1] as string).declarations.filter((item) => item.name === "f"),
		).toHaveLength(1);
	});

	test("uses one constructor identity at both sites", () => {
		const sources = ["class A { A(); }; A::A() {}\n", "class A { A() {} };\n"];
		const facts = parseCppFile("identity.cpp", sources[0] as string);
		expect(facts.declarations.filter((item) => item.name === "A" && item.kind === "constructor")).toHaveLength(1);
		expect(
			parseCppFile("identity.cpp", sources[1] as string).declarations.filter(
				(item) => item.name === "A" && item.kind === "constructor",
			),
		).toHaveLength(1);
	});

	test("keeps the prototype name as the one reference, and the definition's name as the declaration", () => {
		const sources = ["class A { void f(); }; void A::f() {}\n", "class A { void f() {} };\n"];
		const facts = parseCppFile("identity.cpp", sources[0] as string);
		// The prototype's name (column 15) is the one reference; the definition's (column 31) is the declaration.
		expect(
			facts.references.filter((item) => item.name === "f").map((item) => [item.role, item.range.start.character]),
		).toEqual([["read", 15]]);
		expect(facts.declarations.find((item) => item.name === "f")?.selectionRange?.start.character).toBe(31);
		expect(parseCppFile("identity.cpp", sources[1] as string).declarations.some((item) => item.name === "f")).toBe(
			true,
		);
	});

	test("settles a written qualifier from declarations later in the file", () => {
		const facts = parseCppFile("identity.cpp", "void A::f() {}\nclass A { void f(); };\n");
		expect(facts.declarations.find((item) => item.name === "f")?.symbolId).toBe(
			id("identity.cpp", [
				{ kind: "type", name: "A" },
				{ kind: "method", name: "f" },
			]),
		);
	});

	// The store refuses a container the file never declares, so a written scope is identity only.
	test("names a container only when the file declares it", () => {
		const outOfLine = parseCppFile("identity.cpp", "void Physics::World::step() {}\n");
		const step = outOfLine.declarations.find((item) => item.name === "step");
		expect(step?.symbolId).toBe(
			id("identity.cpp", [
				{ kind: "namespace", name: "Physics" },
				{ kind: "namespace", name: "World" },
				{ kind: "method", name: "step" },
			]),
		);
		expect(step?.containerId).toBeUndefined();

		const declared = parseCppFile(
			"identity.cpp",
			"namespace Physics { class World { void step(); }; }\nvoid Physics::World::step() {}\n",
		);
		expect(declared.declarations.find((item) => item.name === "step")?.containerId).toBe(
			id("identity.cpp", [
				{ kind: "namespace", name: "Physics" },
				{ kind: "type", name: "World" },
			]),
		);
	});

	test("tells overloads apart by cv qualifiers, and one function apart from its spellings", () => {
		const method = (name: string, disambiguator?: string) =>
			id("identity.cpp", [
				{ kind: "type", name: "A" },
				{ kind: "method", name, ...(disambiguator === undefined ? {} : { disambiguator }) },
			]);
		const constOverloads = declarationIds(
			"class A { void f() const; void f(); };\nvoid A::f() const {}\nvoid A::f() {}\n",
		);
		expect(constOverloads).toEqual([
			id("identity.cpp", [{ kind: "type", name: "A" }]),
			method("f"),
			method("f", "1"),
		]);

		for (const source of [
			"class A { void f(int x = 0); };\nvoid A::f(int) {}\n",
			"class A { void f(unsigned); };\nvoid A::f(unsigned int value) {}\n",
			"class A { void f(const std::vector<std::pair<int, int>>& items); };\nvoid A::f(const std::vector<std::pair<int, int>> &) {}\n",
			// A by-value parameter's top-level const is no part of the function's type.
			"class A { void f(const int value); };\nvoid A::f(int value) {}\n",
			"class A { void f(int* const p); };\nvoid A::f(int* p) {}\n",
		]) {
			expect(declarationIds(source), source).toEqual([
				id("identity.cpp", [{ kind: "type", name: "A" }]),
				method("f"),
			]);
		}

		// A pointee's const is; so is a template head, as SFINAE overloads differ by nothing else.
		for (const source of [
			"class A { void f(const int* p); void f(int* p); };\n",
			"template <class T, enable_if_t<X<T>::value, int> = 0> void f(T);\ntemplate <class T, enable_if_t<Y<T>::value, int> = 0> void f(T);\ntemplate <class T, enable_if_t<X<T>::value, int>> void f(T) {}\n",
		]) {
			const functions = parseCppFile("identity.cpp", source).declarations.filter((item) => item.name === "f");
			expect(new Set(functions.map((item) => item.symbolId)).size, source).toBe(2);
		}
	});

	test("matches a member template's definition by its own head, apart from its class template's", () => {
		const facts = parseCppFile(
			"identity.cpp",
			[
				"struct S { template<class T> void f(T); template<int N> void f(int); void f(int); };",
				"template<int N> void S::f(int) {}",
				"void S::f(int) {}",
				"template<class U> void S::f(U) {}",
				"template<class T> struct B { template<class U> void g(U, T); };",
				"template<class X> template<class Y> void B<X>::g(Y, X) {}",
			].join("\n"),
		);
		const lines = (name: string) =>
			facts.declarations.filter((item) => item.name === name).map((item) => item.range.start.line);

		expect(lines("f").sort()).toEqual([1, 2, 3]);
		expect(lines("g")).toEqual([5]);
	});

	test("matches a definition whatever it names its template and function parameters", () => {
		for (const source of [
			"template<class T> void f(T);\ntemplate<class U> void f(U) {}\n",
			"template<class T, T N> void f(T);\ntemplate<class U, U M> void f(U) {}\n",
			"void f(void (*callback)(int));\nvoid f(void (*)(int)) {}\n",
			"void f(int values[]);\nvoid f(int items[]) {}\n",
		]) {
			const functions = parseCppFile("identity.cpp", source).declarations.filter((item) => item.name === "f");
			expect(
				functions.map((item) => item.range.start.line),
				source,
			).toEqual([1]);
		}
		// The definition's names are the ones its body and its prototype's uses see.
		const renamed = parseCppFile(
			"identity.cpp",
			"template<class T> void f(T);\ntemplate<class U> void f(U u) {}\n",
		);
		expect(renamed.declarations.map((item) => item.name)).toEqual(["f", "U", "u"]);
		expect(renamed.references.filter((item) => item.name === "T").map((item) => item.range.start.line)).toEqual([
			0,
		]);
	});

	test("gives every declaration its own id", () => {
		const text = [
			"struct A; struct A { int a; }; A* p;",
			"struct { int a; } x; struct { int b; } y;",
			"template<class T> struct Box {}; template<class T> struct Box<T*> {}; template<> struct Box<int> {};",
			"#if FEATURE",
			"int value;",
			"#else",
			"int value;",
			"#endif",
			"namespace n { int one; } namespace n { int two; }",
		].join("\n");
		const facts = parseCppFile("identity.cpp", text);
		const ids = facts.declarations.map((item) => item.symbolId);

		expect(new Set(ids).size).toBe(ids.length);
		// The forward declaration's name uses the one declaration of `A`.
		expect(
			facts.declarations.filter((item) => item.name === "A").map((item) => item.range.start.character),
		).toEqual([10]);
		expect(facts.references.filter((item) => item.name === "A").map((item) => item.range.start.character)).toEqual([
			7, 31,
		]);
		expect(facts.declarations.filter((item) => item.name === "Box")).toHaveLength(3);
		expect(facts.declarations.filter((item) => item.name === "value")).toHaveLength(2);
		expect(facts.declarations.filter((item) => item.name === "n")).toHaveLength(1);
	});

	test("declares a static member at its definition outside the class, under a template head too", () => {
		for (const source of [
			"struct S { static int count; };\nint S::count = 0;\n",
			"template<class T> struct S { static int count; };\ntemplate<class T> int S<T>::count = 0;\n",
		]) {
			const facts = parseCppFile("identity.cpp", source);
			const count = facts.declarations.filter((item) => item.name === "count");
			expect(
				count.map((item) => [item.range.start.line, item.containerId?.split(" ").at(-1)]),
				source,
			).toEqual([[1, "S#"]]);
			expect(
				facts.references.filter((item) => item.name === "count").map((item) => item.range.start.line),
			).toEqual([0]);
		}
	});
});
