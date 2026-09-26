import { describe, expect, test } from "bun:test";
import { FOLD_MARK } from "@nyaa-lexicon/protocol";
import { parseC } from "../parser.js";

const FOLDED = `{${FOLD_MARK}}`;

function signatures(text: string): Map<string, string | undefined> {
	return new Map(
		parseC("header.c", text).declarations.map((declaration) => [declaration.name, declaration.signature]),
	);
}

describe("C declaration headers", () => {
	test("a function reads from its attributes to its body on one line, comments out", () => {
		const read = signatures(
			[
				"/** Adds. */",
				"__attribute__((pure)) static const char *",
				"add(int left, /* wide */",
				"\tint right) // after",
				"{",
				"\treturn 0;",
				"}",
				"int count(void);",
				"int stop(void) __attribute__((noreturn)), later(void);",
			].join("\n"),
		);

		expect(read.get("add")).toBe("__attribute__((pure)) static const char * add(int left, int right)");
		expect(read.get("count")).toBe("int count(void)");
		expect(read.get("stop")).toBe("int stop(void) __attribute__((noreturn))");
		expect(read.has("left")).toBe(true);
		expect(read.get("left")).toBeUndefined();
	});

	test("a value folds its brace initializers and compound literals, never its type", () => {
		const read = signatures(
			[
				"static const int TABLE[2][2] = {",
				"\t{ 1, 2 },",
				"\t{ 3, 4 },",
				"};",
				"struct point *origin = &(struct point){ .x = 0 };",
				"int empty[1] = {};",
				"int size = sizeof(int[3]);",
			].join("\n"),
		);

		expect(Object.fromEntries(read)).toEqual({
			TABLE: `static const int TABLE[2][2] = ${FOLDED}`,
			origin: `struct point *origin = &(struct point)${FOLDED}`,
			empty: "int empty[1] = {}",
			size: "int size = sizeof(int[3])",
		});
	});

	test("each declarator keeps the specifiers and leaves out the ones before it", () => {
		const read = signatures("static int first, *second = 0,\n\tthird[2] = { 1, 2 };\n");

		expect(Object.fromEntries(read)).toEqual({
			first: "static int first",
			second: "static int *second = 0",
			third: `static int third[2] = ${FOLDED}`,
		});
	});

	test("an aggregate stops before its body, and its declarators fold it", () => {
		const read = signatures(
			[
				"typedef struct point /* tag */ {",
				"\tint x, // across",
				"\t\ty : 4;",
				"} Point, *PointRef;",
				"struct counter { int n; } tally = { 0 };",
				"enum color { RED = 1 << 0, GREEN /* last */ };",
				"struct later;",
			].join("\n"),
		);

		expect(Object.fromEntries(read)).toEqual({
			point: "struct point",
			Point: `typedef struct point ${FOLDED} Point`,
			PointRef: `typedef struct point ${FOLDED} *PointRef`,
			x: "int x",
			y: "int y : 4",
			counter: "struct counter",
			tally: `struct counter ${FOLDED} tally = ${FOLDED}`,
			n: "int n",
			color: "enum color",
			RED: "RED = 1 << 0",
			GREEN: "GREEN",
			later: "struct later",
		});
	});

	test("a macro reads as its whole directive across line splices", () => {
		const read = signatures("#define MAX(a, b) \\\n\t((a) > (b) ? (a) : (b)) /* larger */\n#define LIMIT 3\n");

		expect(Object.fromEntries(read)).toEqual({
			MAX: "#define MAX(a, b) ((a) > (b) ? (a) : (b))",
			LIMIT: "#define LIMIT 3",
		});
	});

	test("a header holds the tokens the parser read: no removed branch, Ghidra's warning suffix kept", () => {
		const read = signatures(
			[
				"int pick(",
				"#if 0",
				"\tint dropped",
				"#else",
				"\tint kept",
				"#endif",
				") { return 0; }",
				"int flag = (seed",
				"// WARNING: Load size is inaccurate);",
			].join("\n"),
		);

		expect(read.get("pick")).toContain("int kept");
		expect(read.get("pick")).not.toContain("dropped");
		expect(read.get("flag")).toBe("int flag = (seed)");
	});

	test("a literal keeps its spacing and escapes its line break and tab", () => {
		const read = signatures(
			['static const char *SEP = "a  b",', '\t*DOC = "one\\', '  two";', "char tab = '\t';"].join("\n"),
		);

		expect(Object.fromEntries(read)).toEqual({
			SEP: 'static const char *SEP = "a  b"',
			DOC: 'static const char *DOC = "one\\\\n  two"',
			tab: "char tab = '\\t'",
		});
	});

	test("renders a statement of many declarators in time linear in their count", () => {
		const timed = (count: number) => {
			const text = `int ${Array.from({ length: count }, (_, index) => `a${index} = ${index}`).join(", ")};\n`;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				parseC("many.c", text);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads 8x; a walk of every sibling per declarator reads 64x.
		expect(timed(4_000) / timed(500)).toBeLessThan(24);
	});
});
