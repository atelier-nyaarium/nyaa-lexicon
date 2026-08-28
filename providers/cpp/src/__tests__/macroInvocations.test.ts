import { describe, expect, test } from "bun:test";
import { parseCppFile } from "../parser.js";

describe("C++ declaration-scope macro invocations", () => {
	test("drops a file-scope call and keeps the following declaration", () => {
		const facts = parseCppFile("file.cpp", "SUPPRESS_WARNING(123)\nint real;\n");
		expect(facts.declarations.map((item) => [item.name, item.range.start.line])).toEqual([["real", 1]]);
	});

	test("drops calls in namespaces and class bodies", () => {
		const facts = parseCppFile(
			"scopes.cpp",
			"namespace api {\nSUPPRESS_WARNING(123)\nint value;\n}\nstruct Item {\nSUPPRESS_WARNING(123)\nint field;\n};\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["api", "value", "Item", "field"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("drops a call with a trailing semicolon", () => {
		const facts = parseCppFile("semicolon.cpp", "SUPPRESS_WARNING(123);\nint real;\n");
		expect(facts.declarations.map((item) => item.name)).toEqual(["real"]);
	});

	test("keeps a SHOUT_CASE call followed by a body", () => {
		const facts = parseCppFile("body.cpp", 'TEST_CASE("case") { int inner; }\n');
		expect(facts.declarations.map((item) => item.name)).toEqual(["TEST_CASE", "inner"]);
		expect(facts.declarations[0]?.kind).toBe("function");
	});

	test("leaves mixed-case calls unchanged", () => {
		const facts = parseCppFile("mixed.cpp", "mixedCase()\nint real;\n");
		expect(facts.declarations.map((item) => [item.name, item.range.start.line, item.range.end.line])).toEqual([
			["mixedCase", 0, 1],
		]);
	});

	test("drops a multiline macro invocation", () => {
		const facts = parseCppFile("multiline.cpp", "SUPPRESS_WARNING(\n123,\n456\n)\nint real;\n");
		expect(facts.declarations.map((item) => [item.name, item.range.start.line])).toEqual([["real", 4]]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("drops a member call after a macro invocation", () => {
		const facts = parseCppFile("member-call.cpp", "FOO(1).bar();\nint real;\n");
		expect(facts.declarations.map((item) => item.name)).toEqual(["real"]);
	});

	test("keeps uppercase type and prefix identifiers", () => {
		const cases = [
			["HRESULT WINAPI f();", ["f"], ["function"]],
			["UINT MAX_COUNT = 3;", ["MAX_COUNT"], ["variable"]],
			["DOCTEST_INTERFACE void f();", ["f"], ["function"]],
			["API_EXPORT int x;", ["x"], ["variable"]],
			["EXPORT(int) f();", ["f"], ["function"]],
			["SIZE_T size();", ["size"], ["function"]],
		] as const;
		for (const [text, names, kinds] of cases) {
			const facts = parseCppFile("prefix.cpp", text);
			expect(facts.declarations.map((item) => item.name)).toEqual([...names]);
			expect(facts.declarations.map((item) => item.kind)).toEqual([...kinds]);
		}
		expect(parseCppFile("prefix.cpp", cases[0][0]).typeAnswers.values().next().value).toMatchObject({
			display: "HRESULT WINAPI",
		});
	});

	test("keeps array bounds and declaration names", () => {
		const facts = parseCppFile("array.cpp", "struct S { int a[MAX_VALUE]; };\n");
		expect(facts.declarations.map((item) => item.name)).toEqual(["S", "a"]);
		expect(facts.declarations.map((item) => item.kind)).toEqual(["struct", "field"]);
	});

	test("drops a standalone prefix before a pragma", () => {
		const facts = parseCppFile("pragma.cpp", "PREFIX\n#pragma once\nint real;\n");
		expect(facts.declarations.map((item) => item.name)).toEqual(["real"]);
	});

	test.each([
		["const", "FOO(1) const\n", ["FOO"], ["function"]],
		["noexcept", "FOO(1) noexcept\n", ["FOO"], ["function"]],
		["override", "FOO(1) override\n", ["FOO"], ["function"]],
		["equals", "FOO(1) = 0\n", ["FOO"], ["function"]],
		["colon", "FOO(1) : Base\n", ["FOO"], ["function"]],
		["parenthesis", "FOO(1) (x)\n", ["FOO"], ["function"]],
	] as const)("preserves a call followed by %s", (_name, text, names, kinds) => {
		const facts = parseCppFile("suffix.cpp", text);
		expect(facts.declarations.map((item) => item.name)).toEqual([...names]);
		expect(facts.declarations.map((item) => item.kind)).toEqual([...kinds]);
	});

	// The doctest idiom: pragma macros stacked one per line, then a call or a directive.
	test.each([
		["a chain ending in a call", "PUSH\nWARN(1)\nint real;\n", ["real"]],
		["a chain with a trailing comment", "PUSH // why\nWARN(1)\nint real;\n", ["real"]],
		["a chain at end of file", "int real;\nPUSH\nWARN(1)", ["real"]],
		["a chain in a CRLF file", "PUSH\r\nWARN(1)\r\nint real;\r\n", ["real"]],
	] as const)("drops %s", (_name, text, names) => {
		const facts = parseCppFile("chain.cpp", text);
		expect(facts.declarations.map((item) => item.name)).toEqual([...names]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("keeps a prefix whose chain is broken by a token sharing a line", () => {
		const facts = parseCppFile("broken.cpp", "PREFIX\nTYPE OTHER()\nint real;\n");
		const other = facts.declarations.find((item) => item.name === "OTHER");
		expect(other?.range.start.line).toBe(0);
	});
});
