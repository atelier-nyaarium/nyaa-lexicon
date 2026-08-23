import { describe, expect, test } from "vitest";
import { parseCppFile } from "../parser.js";

describe("C++ declaration attributes", () => {
	test.each([
		["__declspec(dllexport) int x;", "x"],
		["__attribute__((unused)) int y;", "y"],
		["alignas(16) int z;", "z"],
		["[[nodiscard]] int w;", "w"],
	])("declares a variable after %s", (text, name) => {
		const facts = parseCppFile("variables.cpp", `\n${text}\n`);
		const declaration = facts.declarations.find((item) => item.name === name);
		expect(declaration).toMatchObject({ name, kind: "variable", range: { start: { line: 1 } } });
		expect(facts.references.map((item) => item.name)).not.toContain("dllexport");
		expect(facts.diagnostics).toEqual([]);
	});

	test("declares functions after declaration specifiers", () => {
		const facts = parseCppFile("functions.cpp", "__declspec(dllexport) int f();\n[[nodiscard]] int g();\n");
		expect(facts.declarations.map((item) => [item.name, item.kind])).toEqual([
			["f", "function"],
			["g", "function"],
		]);
	});

	test("accepts multiple specifiers and modifiers", () => {
		const facts = parseCppFile(
			"modifiers.cpp",
			"[[nodiscard]] __attribute__((warn_unused_result)) int h();\nstatic [[nodiscard]] inline int i();\ninline static __declspec(dllexport) int j();\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["h", "i", "j"]);
		expect(facts.declarations.every((item) => item.kind === "function")).toBe(true);
	});

	test("declares an attributed field", () => {
		const facts = parseCppFile("class.cpp", "class Item {\n__declspec(property(get=x)) int p;\n};\n");
		expect(facts.declarations.map((item) => [item.name, item.kind])).toContainEqual(["p", "field"]);
	});

	test("keeps literals and balanced strings inside specifiers", () => {
		const facts = parseCppFile(
			"literal.cpp",
			'__attribute__((deprecated("use b"))) int b;\n[[deprecated("])" )]] int c;\n',
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["b", "c"]);
		expect(facts.literals.map((item) => item.value)).toContain("use b");
		expect(facts.diagnostics).toEqual([]);
	});

	test("handles the doctest declaration shape", () => {
		const facts = parseCppFile("doctest.h", 'extern "C" __declspec(dllimport) void __stdcall DebugBreak();\n');
		expect(facts.declarations.map((item) => [item.name, item.kind])).toEqual([["DebugBreak", "function"]]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("starts a function's range at its first specifier", () => {
		const facts = parseCppFile("range.cpp", "[[nodiscard]]\nstatic int f();\n");
		expect(facts.declarations.find((item) => item.name === "f")?.range.start.line).toBe(0);
	});

	test("reports an unterminated specifier instead of looping", () => {
		for (const text of ["__declspec(dllexport int x;", "[[nodiscard int y;", "__declspec("]) {
			const facts = parseCppFile("open.cpp", text);
			expect(facts.diagnostics.map((item) => item.message)).toContain("Attribute specifier is not closed.");
		}
	});

	// A C header wrapped whole in `extern "C" {` used to lose everything in it and after it.
	test("reads a linkage block as part of the scope around it", () => {
		const facts = parseCppFile(
			"linkage.cpp",
			'namespace api {\nextern "C" {\nint inside;\nvoid f();\n}\nint after;\n}\nextern "C" {\nint open;\n',
		);
		expect(facts.declarations.map((item) => [item.name, item.containerId === undefined ? "top" : "held"])).toEqual([
			["api", "top"],
			["inside", "held"],
			["f", "held"],
			["after", "held"],
			["open", "top"],
		]);
		expect(facts.diagnostics.map((item) => item.message)).toContain("Linkage block is not closed.");
	});

	// A type named inside a specifier is not reported as a reference; the arguments are opaque.
	test("leaves a parameter attribute and a linkage string to their own readers", () => {
		const facts = parseCppFile(
			"others.cpp",
			'void f([[maybe_unused]] int x);\nextern "C" int linked;\nextern "C" {\nint inside;\n}\nalignas(Type) int aligned;\n',
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["f", "x", "linked", "inside", "aligned"]);
		expect(facts.references.map((item) => item.name)).not.toContain("Type");
		expect(facts.diagnostics).toEqual([]);
	});
});
