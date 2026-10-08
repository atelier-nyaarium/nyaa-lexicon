import { describe, expect, test } from "bun:test";
import { CsharpParser } from "../parser.js";

function parse(text: string) {
	return new CsharpParser("Angles.cs", text).parse();
}

function names(text: string, languageKind: string): string[] {
	return parse(text)
		.declarations.filter((item) => item.languageKind === languageKind)
		.map((item) => item.name);
}

function roles(text: string, name: string): string[] {
	return parse(text)
		.references.filter((item) => item.name === name)
		.map((item) => item.role);
}

describe("C# splitters read only the angles the walk read as type brackets", () => {
	test("a comparison in a default value or an initializer splits like any other value", () => {
		const text = [
			"class C",
			"{",
			"    void Less(int x = a < b, int y = 2) { }",
			"    void More(int x = a > b, int y = 2) { }",
			"    void Tagged([A(1 < 2)] int x = 5, int y = 6) { }",
			"    void Typed(Dictionary<int, List<int>> x, int y) { }",
			"    private int f = p < q, g = 2;",
			"    private int h = p > q, i = 2;",
			"    private object j = F<A, B>(1), k = 2;",
			"}",
			"",
		].join("\n");

		expect(names(text, "parameter")).toEqual(["x", "y", "x", "y", "x", "y", "x", "y"]);
		expect(names(text, "field")).toEqual(["f", "g", "h", "i", "j", "k"]);
	});

	test("a comparison in base constructor arguments ends neither the base list nor the where clause", () => {
		const text = [
			"interface IShape { }",
			"class Base { public Base(bool b) { } }",
			"class G<T>(int a, int b) : Base(a < b), IShape where T : unmanaged { }",
			"",
		].join("\n");

		expect(roles(text, "Base")).toContain("extends");
		expect(roles(text, "IShape")).toEqual(["implements"]);
		expect(roles(text, "unmanaged")).toEqual([]);
	});

	test("reads a long run of comparisons with work linear in its length", () => {
		const work = (count: number) => {
			const text = `class C { static bool[] f = { ${Array.from({ length: count }, () => "a < b").join(", ")} }; }\n`;
			const meter = { steps: 0 };
			new CsharpParser("Many.cs", text, false, [], meter).parse();
			return meter.steps;
		};
		// Repeated suffix walks would revisit each comparison.
		const small = work(500);
		const large = work(4_000);
		expect(large / small).toBeLessThan(12);
	});

	test("a where clause with no constraint yet ends the parse", () => {
		for (const clause of ["where", "where T"]) {
			const facts = parse(`class H<T> ${clause}\n{\n    int x;\n}\n`);
			expect(facts.declarations.map((item) => item.name)).toEqual(["H", "T", "x"]);
		}
	});
});
