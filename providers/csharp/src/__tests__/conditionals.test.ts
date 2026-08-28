import { describe, expect, test } from "bun:test";
import { CsharpParser } from "../parser.js";
import { tokenize } from "../tokens.js";

function parse(text: string) {
	return new CsharpParser("Conditionals.cs", text).parse();
}

describe("C# conditional groups", () => {
	test("keeps the first fragment branch and its method range", () => {
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

	test("keeps whole alternatives", () => {
		const facts = parse("class C {\n#if NET20\nint a;\n#else\nint a;\n#endif\n}");
		expect(facts.declarations.filter((item) => item.name === "a").map((item) => item.range.start.line)).toEqual([
			2, 4,
		]);
	});

	test("selects the branch after #if false", () => {
		const facts = parse("class C {\n#if false\nint no;\n#else\nint yes;\n#endif\n}");
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "yes"]);
	});

	// Only the bare word is the comment idiom; anything else is a condition nobody here can evaluate.
	test.each([
		["#if false // dead", ["C", "yes"]],
		["#if   false  ", ["C", "yes"]],
		["#if FALSE", ["C", "no", "yes"]],
		["#if false || X", ["C", "no", "yes"]],
		["#if (false)", ["C", "no", "yes"]],
	])("reads %s exactly", (directive, names) => {
		const facts = parse(`class C {\n${directive}\nint no;\n#else\nint yes;\n#endif\n}`);
		expect(facts.declarations.map((item) => item.name)).toEqual(names);
	});

	test("leaves a closed inner group alone under an unclosed outer one", () => {
		const facts = parse("class C {\n#if OUTER\n#if false\nint hidden;\n#else\nint shown;\n#endif\nint after;\n}");
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "hidden", "shown", "after"]);
		expect(facts.diagnostics.map((item) => item.message)).toContain("Conditional directive is not closed.");
	});

	test("keeps the elif branch after #if false", () => {
		const facts = parse("class C {\n#if false\nint no;\n#elif OTHER\nint maybe;\n#else\nint yes;\n#endif\n}");
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "maybe", "yes"]);
	});

	test("resolves a nested fragment inside both outer branches", () => {
		const facts = parse(
			"class C {\n#if OUTER\nint one;\n#if INNER\nif (x\n#else\nif (y\n#endif\n&& z) { }\n#else\nint two;\n#endif\n}",
		);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => item.name)).toContain("one");
		expect(facts.declarations.map((item) => item.name)).toContain("two");
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

	test("reports an unclosed group without dropping its contents", () => {
		const facts = parse("class C {\n#if false\nint value;\n}");
		expect(facts.declarations.map((item) => item.name)).toContain("value");
		expect(facts.diagnostics.map((item) => item.message)).toContain("Conditional directive is not closed.");
	});

	test("reports and ignores a stray endif", () => {
		const facts = parse("#endif\nclass C { int value; }");
		expect(facts.declarations.map((item) => item.name)).toEqual(["C", "value"]);
		expect(facts.diagnostics.map((item) => item.message)).toEqual(["Unexpected #endif outside a conditional."]);
	});

	test("judges punctuation without reading strings or comments", () => {
		const facts = parse('class C {\n#if A\nstring text = "{"; // }\n#else\nint kept;\n#endif\n}');
		expect(facts.declarations.map((item) => item.name)).toContain("text");
		expect(facts.declarations.map((item) => item.name)).toContain("kept");
	});

	test("keeps positions after a removed branch", () => {
		const facts = parse("class C {\n#if false\nint hidden;\n#else\nint visible;\n#endif\nint after;\n}");
		expect(facts.declarations.find((item) => item.name === "after")?.range.start.line).toBe(6);
	});

	// Both signatures stay in the stream; the parser reads them as one method, which is pinned here.
	test("keeps both whole newtonsoft feature-gate alternatives", () => {
		const text =
			"class C {\n#if HAVE_ASYNC\npublic async Task<int> Run()\n#else\npublic Task<int> Run()\n#endif\n{ return 1; }\n}";
		const kept = tokenize(text).tokens.filter((item) => item.kind === "identifier" && item.value === "Run");
		expect(kept.map((item) => item.start.line)).toEqual([2, 4]);
		const facts = parse(text);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.filter((item) => item.name === "Run").map((item) => item.kind)).toEqual(["method"]);
	});
});
