import { describe, expect, test } from "bun:test";
import { CsharpParser } from "../parser.js";
import { tokenize } from "../tokens.js";

function parse(text: string) {
	return new CsharpParser("Conditionals.cs", text).parse();
}

function names(text: string): string[] {
	return parse(text).declarations.map((item) => item.name);
}

function errors(text: string): number {
	return parse(text).diagnostics.filter((item) => item.severity === "error").length;
}

describe("C# conditional groups", () => {
	test("keeps the live section of a fragment group and its method range", () => {
		const text = [
			"class C {",
			"void M() {",
			"#if A",
			"if (x > 0",
			"#else",
			"if (y",
			"#endif",
			"&& z) { }",
			"}",
			"}",
		].join("\n");
		const facts = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.find((item) => item.name === "M")).toMatchObject({
			kind: "method",
			range: { start: { line: 1 }, end: { line: 8 } },
		});
	});

	test("keeps exactly one of two whole alternatives", () => {
		const facts = parse("class C {\n#if NET20\nint a;\n#else\nint a;\n#endif\n}");
		expect(facts.declarations.filter((item) => item.name === "a").map((item) => item.range.start.line)).toEqual([
			4,
		]);
	});

	test.each([
		["#if false // dead", ["C", "yes"]],
		["#if   false  ", ["C", "yes"]],
		["#if /* c */ false", ["C", "yes"]],
		["#if (false)", ["C", "yes"]],
		["#if(false)", ["C", "yes"]],
		["#if !true", ["C", "yes"]],
		["#if false && X", ["C", "yes"]],
		["#if (X || true) == false", ["C", "yes"]],
		["#if true != true", ["C", "yes"]],
		["#if FALSE", ["C", "yes"]],
		["#if false || X", ["C", "yes"]],
		["#if true", ["C", "no"]],
		["#if !X", ["C", "no"]],
		["#if false == X", ["C", "no"]],
		["#if X == Y", ["C", "no"]],
		["#if !(X && true) || X", ["C", "no"]],
	])("reads %s with undefined symbols false", (directive, expected) => {
		expect(names(`class C {\n${directive}\nint no;\n#else\nint yes;\n#endif\n}`)).toEqual(expected);
	});

	test.each([
		["#if false X", 10],
		["#if (false", 10],
		['#if "false"', 4],
		["#if false = false", 10],
		["#if", 3],
		["#if /* open", 4],
	])("refuses the invalid condition %s at its offending token", (directive, character) => {
		const facts = parse(`class C {\n${directive}\nint no;\n#else\nint yes;\n#endif\n}`);
		expect(facts.diagnostics.map((item) => item.range?.start)).toEqual([{ line: 1, character }]);
	});

	test("reads symbols #define and #undef set above", () => {
		const text = [
			"#define A",
			"#define B",
			"#undef B",
			"#define C // note",
			"class Holder {",
			"#if A && !B",
			"int a;",
			"#endif",
			"#if B",
			"int b;",
			"#endif",
			"#if C == true",
			"int c;",
			"#endif",
			"}",
		].join("\n");
		const facts = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => item.name)).toEqual(["Holder", "a", "c"]);
	});

	test("reads a directive's symbol as an identifier, escapes decoded", () => {
		expect(names("#define \\u0041\nclass C {\n#if A && B\\u0043\nint no;\n#elif A\nint yes;\n#endif\n}")).toEqual([
			"C",
			"yes",
		]);
	});

	test("ignores a #define in a skipped section", () => {
		expect(names("#if false\n#define A\n#endif\nclass C {\n#if A\nint a;\n#endif\n}")).toEqual(["C"]);
	});

	test("evaluates #elif only while no section has been live", () => {
		const chain = (defines: string) =>
			names(`${defines}class C {\n#if A\nint a;\n#elif B\nint b;\n#elif C\nint c;\n#else\nint d;\n#endif\n}`);
		expect(chain("")).toEqual(["C", "d"]);
		expect(chain("#define B\n")).toEqual(["C", "b"]);
		expect(chain("#define B\n#define C\n")).toEqual(["C", "b"]);
		expect(chain("#define A\n#define B\n")).toEqual(["C", "a"]);
	});

	test("keeps no section of a group inside a skipped section", () => {
		const text = "class C {\n#if false\n#if true\nint a;\n#else\nint b;\n#endif\n#else\nint c;\n#endif\n}";
		expect(names(text)).toEqual(["C", "c"]);
	});

	test("drops a parenthesized false group at file scope", () => {
		const facts = parse("#if (false)\nclass Dead {}\n#endif");
		expect(facts.declarations).toEqual([]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("ends a condition directive at its line comment", () => {
		const lexed = tokenize("#if (true) // note\nint x;\n#endif");
		expect(lexed.comments.map((item) => item.raw)).toEqual(["// note"]);
		expect(lexed.tokens.find((item) => item.kind === "directive")?.raw).toBe("#if (true) ");
	});

	test("drops a skipped directive's trailing comment", () => {
		expect(tokenize("#if false // gone\nint x;\n#else // kept\n#endif").comments.map((item) => item.raw)).toEqual([
			"// kept",
		]);
	});

	test("reports an unclosed group and still keeps one section", () => {
		const skipped = parse("class C {\n#if OUTER\nint hidden;\n}");
		expect(skipped.declarations.map((item) => item.name)).toEqual(["C"]);
		expect(skipped.diagnostics.length).toBeGreaterThan(0);
		const live = parse("class C {\n#if true\nint shown;\n}");
		expect(live.declarations.map((item) => item.name)).toEqual(["C", "shown"]);
		expect(live.diagnostics.length).toBe(1);
	});

	test.each([
		["a stray #endif", "#endif\nclass C { int value; }"],
		["a stray #else", "#else\nclass C { int value; }"],
		["#elif after #else", "#if false\n#else\n#elif true\n#endif\nclass C { int value; }"],
		["#define after a token", "class C { int value; }\n#define LATE"],
		["a directive after code on its line", "class C { int value; } #if false"],
	])("reports %s", (_label, text) => {
		expect(errors(text)).toBeGreaterThan(0);
		expect(names(text)).toEqual(["C", "value"]);
	});

	test("reads a skipped section as lines, never as tokens", () => {
		const text = [
			"class C {",
			"#if false",
			"it's prose",
			'"open',
			'string s = @"',
			"#endif",
			"int kept;",
			"}",
		].join("\n");
		const facts = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "kept"]);
	});

	test("reads a directive-shaped line inside a live string as text", () => {
		const facts = parse('class C {\nstring s = @"\n#if false\n";\nint kept;\n}');
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "s", "kept"]);
	});

	test("removes nonconditional directives from a dropped branch", () => {
		const facts = parse(
			"class C {\n#if false\n#region hidden\n#pragma warning disable X\nint hidden;\n#endregion\n#else\nint visible;\n#endif\n}",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "visible"]);
	});

	test("removes comments and literals from a dropped branch", () => {
		const facts = parse(
			'class C {\n#if false\n// hidden\nstring hidden = "hidden";\n#else\nstring visible = "visible";\n#endif\n}',
		);
		expect(facts.comments.map((item) => item.text)).toEqual([]);
		expect(facts.literals.map((item) => item.value)).toEqual(["visible"]);
	});

	test("keeps positions after a removed branch", () => {
		const facts = parse("class C {\n#if false\nint hidden;\n#else\nint visible;\n#endif\nint after;\n}");
		expect(facts.declarations.find((item) => item.name === "after")?.range.start.line).toBe(6);
	});

	test("keeps one of two newtonsoft feature-gate signatures", () => {
		const text =
			"class C {\n#if HAVE_ASYNC\npublic async Task<int> Run()\n#else\npublic Task<int> Run()\n#endif\n{ return 1; }\n}";
		const kept = tokenize(text).tokens.filter((item) => item.kind === "identifier" && item.value === "Run");
		expect(kept.map((item) => item.start.line)).toEqual([4]);
		const facts = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.filter((item) => item.name === "Run").map((item) => item.signature)).toEqual([
			"public Task<int> Run()",
		]);
	});
});
