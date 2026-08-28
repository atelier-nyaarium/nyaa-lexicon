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
		]) {
			expect(declarationIds(source), source).toEqual([
				id("identity.cpp", [{ kind: "type", name: "A" }]),
				method("f"),
			]);
		}
	});
});
