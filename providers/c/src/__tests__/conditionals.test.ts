import { describe, expect, test } from "bun:test";
import { parseC } from "../parser.js";
import { lexC } from "../tokens.js";

describe("C conditional groups", () => {
	test("selects if zero else and drops elif branches", () => {
		const text = "#if 0\nint no;\n#elif OTHER\nint alsoNo;\n#else\nint yes;\n#endif\n";
		const facts = parseC("branches.c", text);
		expect(facts.declarations.map((item) => item.name)).toEqual(["alsoNo", "yes"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("resolves nested groups and preserves later positions", () => {
		const text = "#if OUTER\n#if 0\nint hidden;\n#else\nint shown;\n#endif\n#endif\nint after;\n";
		const facts = parseC("nested.c", text);
		const after = facts.declarations.find((item) => item.name === "after");
		expect(facts.declarations.map((item) => item.name)).toEqual(["shown", "after"]);
		expect(after?.selectionRange?.start.line).toBe(7);
	});

	test("removes comments from inactive branches", () => {
		const facts = parseC("comments.c", "#if 0\n// hidden\nint hidden;\n#else\n// shown\nint shown;\n#endif\n");
		expect(facts.comments.map((item) => item.text)).toEqual(["// shown"]);
	});

	test("reports an unterminated group without dropping tokens", () => {
		const facts = parseC("open.c", "#if FEATURE\nint first;\n#else\nint second;\n");
		expect(facts.declarations.map((item) => item.name)).toEqual(["first", "second"]);
		expect(facts.diagnostics.map((item) => item.message)).toContain("Conditional directive is not closed.");
	});

	test.each([
		["long zero", "#if 0L\nint first;\n#else\nint second;\n#endif\n", ["first", "second"], 0, undefined],
		["parenthesized zero", "#if (0)\nint first;\n#else\nint second;\n#endif\n", ["first", "second"], 0, undefined],
		[
			"trailing comment zero",
			"#if 0 // trailing comment\nint first;\n#else\nint second;\n#endif\n",
			["second"],
			0,
			undefined,
		],
		["block comment zero", "#if /* c */ 0\nint first;\n#else\nint second;\n#endif\n", ["second"], 0, undefined],
		["spaced hash", "#  if X\nint first;\n# endif\n", ["first"], 0, undefined],
		["directive-like text", 'const char *s = "#if X #endif"; // #if X\nint value;\n', ["s", "value"], 0, undefined],
		["macro operators", "#define S(x) #x\n#define P(a,b) a ## b\nint value;\n", ["S", "P", "value"], 0, undefined],
		[
			"spliced condition",
			"#if A \\\n && B\nint first;\n#else\nint second;\n#endif\n",
			["first", "second"],
			0,
			undefined,
		],
		[
			"elif wins after zero",
			"#if 0\nint first;\n#elif X\nint second;\n#else\nint third;\n#endif\n",
			["second", "third"],
			0,
			undefined,
		],
		["nested dropped group", "#if 0\n#if X\nint hidden;\n#endif\n#endif\n", [], 0, undefined],
		["stray else", "#else\nint value;\n", ["value"], 1, "Unexpected #else outside a conditional."],
		["stray endif", "#endif\nint value;\n", ["value"], 1, "Unexpected #endif outside a conditional."],
	] as const)("lexical case %s", (_name, text, names, diagnosticCount, message) => {
		const facts = parseC("matrix.c", text);
		expect(facts.declarations.map((item) => item.name)).toEqual([...names]);
		expect(facts.diagnostics).toHaveLength(diagnosticCount);
		if (message !== undefined) expect(facts.diagnostics[0]?.message).toBe(message);
	});

	test("does not treat a null directive as a conditional", () => {
		const facts = parseC("null.c", "void run(void) {\n#\nif (x) { y(); }\n}\n");
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => item.name)).toEqual(["run"]);
	});

	test("drops inactive macro and include directives", () => {
		const text = '#if 0\n#define HIDDEN 1\n#include "hidden.h"\n#else\n#define KEPT 1\n#include "kept.h"\n#endif\n';
		const facts = parseC("directives.c", text);
		expect(facts.declarations.map((item) => item.name)).toContain("KEPT");
		expect(facts.declarations.map((item) => item.name)).not.toContain("HIDDEN");
		expect(facts.imports.map((item) => item.specifier)).toEqual(["kept.h"]);
		expect(lexC("directives.c", text).tokens.map((item) => item.value)).not.toContain("HIDDEN");
	});

	test("keeps the first branch when the second branch is a fragment", () => {
		const facts = parseC(
			"fragment.c",
			"void run(void) {\n#if A\nint x; x = (1\n#else\nint x; x = (2\n#endif\n);\n}\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["run", "x"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("resolves an inner fragment before judging the outer branches", () => {
		const facts = parseC(
			"nested-fragment.c",
			"#if OUTER\nvoid first(void) {\n#if INNER\nif (a\n#else\nif (b\n#endif\n) {}\n}\n#else\nvoid second(void) {}\n#endif\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["first", "second"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("ignores delimiters in directive lines when judging a branch", () => {
		const facts = parseC("define-delimiter.c", "#if A\n#define OPEN {\nint first;\n#else\nint second;\n#endif\n");
		expect(facts.declarations.map((item) => item.name)).toEqual(["OPEN", "first", "second"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("judges a branch by its punctuation, not by brackets spelled in strings or comments", () => {
		const facts = parseC(
			"content.c",
			'#if A\nconst char* open = "(";\n#else\nconst char* close = ")"; // {\n#endif\n',
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["open", "close"]);
		expect(facts.diagnostics).toEqual([]);
	});
});
