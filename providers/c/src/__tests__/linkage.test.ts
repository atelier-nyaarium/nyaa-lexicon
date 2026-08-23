import { describe, expect, test } from "vitest";
import { parseC } from "../parser.js";

describe("C linkage blocks", () => {
	test("parses the transparent block and following declaration", () => {
		const text = 'extern "C" {\nint uv_run(int mode);\nstruct uv_loop_s { int data; };\n}\nint after;\n';
		const facts = parseC("uv.h", text);
		expect(facts.declarations.map((item) => item.name)).toEqual(["uv_run", "mode", "uv_loop_s", "data", "after"]);
		expect(facts.declarations.find((item) => item.name === "uv_run")).toMatchObject({
			kind: "function",
			range: { start: { line: 1 } },
		});
		expect(facts.diagnostics).toEqual([]);
	});

	test("handles the C++ guard idiom around a header body", () => {
		const text = [
			"#ifdef __cplusplus",
			'extern "C" {',
			"#endif",
			"int first(void);",
			"int second(void);",
			"typedef struct Item { int value; } Item;",
			"#ifdef __cplusplus",
			"}",
			"#endif",
		].join("\n");
		const facts = parseC("guard.h", text);
		expect(facts.declarations.map((item) => item.name)).toEqual(["first", "second", "Item", "Item", "value"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("keeps extern storage for a declaration without a block", () => {
		const facts = parseC("storage.c", 'extern "C" int x;\n');
		expect(facts.declarations.map((item) => [item.name, item.kind])).toEqual([["x", "variable"]]);
		expect(facts.declarations[0]?.visibility).toBe("public");
		expect(facts.declarations[0]?.typeText).toBe("int");
	});

	test("reports an unclosed block and parses to end of file", () => {
		const facts = parseC("unclosed.h", 'extern "C" {\nint inside;\nint after;\n');
		expect(facts.declarations.map((item) => item.name)).toEqual(["inside", "after"]);
		expect(facts.diagnostics.map((item) => item.message)).toContain("Linkage block is not closed.");
	});

	test("nests, takes C++ linkage, and tolerates a comment before the brace", () => {
		const text = 'extern "C++" {\nextern "C" // why\n{\nint inner;\n}\nint outer;\n}\nint after;\n';
		const facts = parseC("nested-linkage.h", text);
		expect(facts.declarations.map((item) => item.name)).toEqual(["inner", "outer", "after"]);
		expect(facts.diagnostics).toEqual([]);
	});

	// Illegal there, but a block is a block; what matters is that nothing loops or vanishes.
	test("reads a block inside a function body the same way", () => {
		const facts = parseC("inner.c", 'void run(void) {\nextern "C" {\nint x;\n}\n}\nint after;\n');
		expect(facts.declarations.map((item) => item.name)).toContain("run");
		expect(facts.declarations.map((item) => item.name)).toContain("after");
		expect(facts.diagnostics).toEqual([]);
	});

	test("treats any other string as no linkage, and still reports a brace left open after a block", () => {
		const other = parseC("other.h", 'extern "Pascal" {\nint x;\n');
		expect(other.diagnostics.map((item) => item.message)).not.toContain("Linkage block is not closed.");
		expect(other.diagnostics.length).toBeGreaterThan(0);
		const open = parseC("open.h", 'extern "C" {\nint x;\n}\nstruct S {\nint y;\n');
		expect(open.diagnostics.map((item) => item.message)).not.toContain("Linkage block is not closed.");
		expect(open.diagnostics.length).toBeGreaterThan(0);
	});

	test("keeps nested struct and inline function ranges", () => {
		const text = 'extern "C" {\nstruct Box { int value; };\nstatic inline int helper(void) { return 1; }\n}\n';
		const facts = parseC("nested.h", text);
		expect(facts.declarations.map((item) => item.name)).toEqual(["Box", "value", "helper"]);
		expect(facts.declarations.find((item) => item.name === "Box")).toMatchObject({
			range: { start: { line: 1 }, end: { line: 1 } },
		});
		expect(facts.declarations.find((item) => item.name === "helper")).toMatchObject({
			kind: "function",
			range: { start: { line: 2 }, end: { line: 2 } },
		});
		expect(facts.diagnostics).toEqual([]);
	});
});
