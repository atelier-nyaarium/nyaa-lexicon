import { describe, expect, test } from "bun:test";
import { CsharpParser } from "../parser.js";

/** Insert lines by name, at both depths. */
function insertLines(text: string): Record<string, number | undefined> {
	const read = (outline: boolean) =>
		Object.fromEntries(
			new CsharpParser("Members.cs", text, outline)
				.parse()
				.declarations.map((item) => [item.name, item.memberInsertLine]),
		);
	const full = read(false);
	expect(read(true)).toEqual(full);
	return full;
}

describe("C# member insert lines", () => {
	test("a container names its closer's line when the closer starts it", () => {
		const text = [
			"namespace Outer {",
			"\tpublic class Box {",
			"\t\tpublic int A;",
			"\t}",
			"\tinterface IShape {",
			"\t\tint Area();",
			"\t\t}",
			"\tstruct Point",
			"\t{",
			"\t}",
			"\tenum Color {",
			"\t\tRed,",
			"\t\tGreen",
			"\t}",
			"\trecord Pair(int X) {",
			"\t}",
			"}",
			"",
		].join("\n");

		expect(insertLines(text)).toMatchObject({
			Outer: 16,
			Box: 3,
			IShape: 6,
			Point: 9,
			Color: 13,
			Pair: 15,
			A: undefined,
			Area: undefined,
			Red: undefined,
		});
	});

	test("a closer sharing its line with anything leaves no safe point", () => {
		const text = [
			"class Tight { int c; }",
			"class Empty {}",
			"class Noted {",
			"\tint d; /* c */ }",
			"class Spanned {",
			"\tint e; /* a",
			"\tb */ }",
			"record Bare(int Y);",
			"",
		].join("\n");

		expect(insertLines(text)).toMatchObject({
			Tight: undefined,
			Empty: undefined,
			Noted: undefined,
			Spanned: undefined,
			Bare: undefined,
		});
	});

	test("a file-scoped namespace names the line after its last code", () => {
		expect(
			insertLines(["namespace Flat;", "", "class A {", "\tint x;", "}", "// tail", ""].join("\n")),
		).toMatchObject({ Flat: 5, A: 4 });
		expect(insertLines(["namespace Flat;", "class A {} /* a", "b */", ""].join("\n"))).toMatchObject({ Flat: 3 });
		expect(insertLines(["namespace Flat;", "#if false", "class Dead {}", "#endif", ""].join("\n"))).toMatchObject({
			Flat: 4,
		});
		expect(insertLines(["namespace Flat;", "class A {}"].join("\n"))).toMatchObject({ Flat: undefined });
	});
});
