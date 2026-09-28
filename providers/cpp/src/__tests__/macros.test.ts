import { describe, expect, test } from "bun:test";
import { parseCppFile } from "../parser.js";
import { tokenize } from "../tokens.js";

describe("C++ translation phase two", () => {
	test("splices macro and conditional continuations before parsing", () => {
		const text =
			"#define DECL(x) \\\n    struct x { int a; }; \\\n    int f(x);\nint real;\n#if A \\\n    && B\nint first;\n#else\nint second;\n#endif\n";
		const facts = parseCppFile("phase-two.cpp", text);
		expect(facts.declarations.map((item) => [item.name, item.range.start.line])).toEqual([
			["real", 3],
			["first", 6],
			["second", 8],
		]);
		expect(facts.diagnostics).toEqual([]);
		// A directive's own word names nothing.
		expect(facts.references.map((item) => item.name)).not.toContain("define");
	});

	test("splices CRLF in directives and macro bodies", () => {
		const text =
			"#define DECL(x) \\\r\nstruct x { int a; };\r\nint real;\r\n#if A \\\r\n && B\r\nint first;\r\n#endif\r\n";
		const facts = parseCppFile("crlf.cpp", text);
		expect(facts.declarations.map((item) => [item.name, item.range.start.line])).toEqual([
			["real", 2],
			["first", 5],
		]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("keeps a terminal backslash and a backslash followed by space", () => {
		const end = tokenize("int value;\\", "end.cpp").tokens.map((item) => item.text);
		const spaced = tokenize("int value;\\ \nint after;\n", "spaced.cpp").tokens;
		expect(end.at(-1)).toBe("\\");
		expect(spaced.some((item) => item.text === "\\")).toBe(true);
		expect(spaced.find((item) => item.text === "after")?.start.line).toBe(1);
	});

	// A carriage return is a splice only as half of a CRLF.
	test("keeps a backslash before a bare carriage return, at the end and mid-line", () => {
		expect(tokenize("int value;\\\r", "cr-end.cpp").tokens.map((item) => item.text)).toEqual([
			"int",
			"value",
			";",
			"\\",
		]);
		const texts = tokenize("int value;\\\rint after;\n", "cr-mid.cpp").tokens.map((item) => item.text);
		expect(texts).toContain("\\");
		expect(texts).toContain("after");
	});

	test("leaves a splice inside a raw string as text", () => {
		const raw = tokenize('const char* s = R"(a\\\nb)";\n', "raw.cpp").tokens.find((item) => item.kind === "string");
		expect(raw?.value).toBe("a\\\nb");
	});

	test("gives the token after a splice its physical position", () => {
		const tokens = tokenize("int \\\n  value;\n", "position.cpp").tokens;
		const value = tokens.find((item) => item.text === "value");
		expect(tokens.map((item) => item.text)).toEqual(["int", "value", ";", "\n"]);
		expect(value?.start).toEqual({ line: 1, character: 2 });
	});

	test("reads a name, a number and an operator through a splice inside them, at their physical span", () => {
		const text = "int fo\\\no = 1\\\n2;\nint x = a -\\\n> b;\n";
		expect(tokenize(text, "inside.cpp").tokens.map((item) => item.text)).toEqual([
			"int",
			"foo",
			"=",
			"12",
			";",
			"\n",
			"int",
			"x",
			"=",
			"a",
			"->",
			"b",
			";",
			"\n",
		]);
		const foo = parseCppFile("inside.cpp", text).declarations[0];
		expect(foo).toMatchObject({
			name: "foo",
			signature: "int foo = 12",
			selectionRange: { start: { line: 0, character: 4 }, end: { line: 1, character: 1 } },
		});
	});

	test("removes a splice before reading an escape, a literal's prefix or a number's leading dot", () => {
		for (const newline of ["\n", "\r\n"]) {
			const text = [
				`const char* spliced = "\\\\${newline}bar";`,
				`const char* escaped = "a\\\\\\${newline}b";`,
				`auto prefixed = u8\\${newline}"hello";`,
				`auto raw = R\\${newline}"(x)";`,
				`double dotted = .\\${newline}5;`,
			].join("\n");
			const tokens = tokenize(text, "splices.cpp").tokens.filter(
				(item) => item.kind === "string" || item.kind === "number",
			);
			// A splice's backslash never starts an escape: `"\<splice>bar"` is `"\bar"`.
			expect(
				tokens.map((item) => [item.kind, item.value]),
				JSON.stringify(newline),
			).toEqual([
				["string", "\bar"],
				["string", "a\\b"],
				["string", "hello"],
				["string", "x"],
				["number", ".5"],
			]);
		}
	});

	test("keeps line comment continuation behavior", () => {
		const facts = parseCppFile("comment.cpp", "// first \\\nsecond\nint after;\n");
		expect(facts.comments.map((item) => item.text)).toEqual(["// first \\\nsecond"]);
		expect(facts.declarations.find((item) => item.name === "after")?.range.start.line).toBe(2);
	});
});
