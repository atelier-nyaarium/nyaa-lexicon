import { describe, expect, test } from "vitest";
import { parseCppFile } from "../parser.js";
import { tokenize } from "../tokens.js";

describe("C++ conditional groups", () => {
	test("parses alternative parentheses as one selected branch", () => {
		const facts = parseCppFile(
			"doctest.hpp",
			"void run() {\n#if defined(X)\n if(std::uncaught_exceptions() > 0\n#else\n if(std::uncaught_exception()\n#endif\n && ready) {}\n}\n",
		);
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.find((item) => item.name === "run")?.range.end.line).toBe(7);
	});

	test("selects if zero else and drops elif branches", () => {
		const facts = parseCppFile(
			"branches.cpp",
			"#if 0\nint no;\n#elif OTHER\nint alsoNo;\n#else\nint yes;\n#endif\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["alsoNo", "yes"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("resolves nested groups and preserves later positions", () => {
		const facts = parseCppFile(
			"nested.cpp",
			"#if OUTER\n#if 0\nint hidden;\n#else\nint shown;\n#endif\n#endif\nint after;\n",
		);
		const after = facts.declarations.find((item) => item.name === "after");
		expect(facts.declarations.map((item) => item.name)).toEqual(["shown", "after"]);
		expect(after?.selectionRange?.start.line).toBe(7);
	});

	test("removes comments from inactive branches", () => {
		const facts = parseCppFile(
			"comments.cpp",
			"#if 0\n// hidden\nint hidden;\n#else\n// shown\nint shown;\n#endif\n",
		);
		expect(facts.comments.map((item) => item.text)).toEqual(["// shown"]);
	});

	test("reports an unterminated group without dropping tokens", () => {
		const facts = parseCppFile("open.cpp", "#if FEATURE\nint first;\n#else\nint second;\n");
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
		["macro operators", "#define S(x) #x\n#define P(a,b) a ## b\nint value;\n", ["value"], 0, undefined],
		[
			"spliced condition",
			"void run() {\n#if A \\\n && B\nint first;\n#else\nint second;\n#endif\n}\n",
			["run"],
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
		const facts = parseCppFile("matrix.cpp", text);
		expect(facts.declarations.map((item) => item.name)).toEqual(names);
		expect(facts.diagnostics).toHaveLength(diagnosticCount);
		if (message !== undefined) expect(facts.diagnostics[0]?.message).toBe(message);
	});

	test("does not treat a null directive as a conditional", () => {
		const facts = parseCppFile("null.cpp", "void run() {\n#\nif (x) { y(); }\n}\n");
		expect(facts.diagnostics).toEqual([]);
		expect(facts.declarations.map((item) => item.name)).toEqual(["run"]);
	});

	test("drops inactive macro and include directives", () => {
		const text = '#if 0\n#define HIDDEN 1\n#include "hidden.h"\n#else\n#define KEPT 1\n#include "kept.h"\n#endif\n';
		const facts = parseCppFile("directives.cpp", text);
		const values = tokenize(text, "directives.cpp").tokens.map((item) => item.value);
		expect(values).toContain("KEPT");
		expect(values).not.toContain("HIDDEN");
		expect(facts.imports.map((item) => item.specifier)).toEqual(["kept.h"]);
	});

	test("keeps the first branch when the second branch is a fragment", () => {
		const facts = parseCppFile(
			"fragment.cpp",
			"void run() {\n#if A\nint x; x = (1\n#else\nint x; x = (2\n#endif\n);\n}\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["run"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("resolves an inner fragment before judging the outer branches", () => {
		const facts = parseCppFile(
			"nested-fragment.cpp",
			"#if OUTER\nvoid first() {\n#if INNER\nif (a\n#else\nif (b\n#endif\n) {}\n}\n#else\nvoid second() {}\n#endif\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["first", "second"]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("ignores delimiters in directive lines when judging a branch", () => {
		const tokens = tokenize("#if A\n#define OPEN {\nint first;\n#else\nint second;\n#endif\n").tokens;
		expect(tokens.map((item) => item.value)).toContain("first");
		expect(tokens.map((item) => item.value)).toContain("second");
	});

	test("keeps duplicate declarations from whole alternatives", () => {
		const facts = parseCppFile("duplicates.cpp", "#if A\nint value;\n#else\nint value;\n#endif\n");
		const values = facts.declarations.filter((item) => item.name === "value");
		expect(values).toHaveLength(2);
	});

	// doctest.h lost its whole implementation namespace to a `"("` in a reporter string.
	test("judges a branch by its punctuation, not by brackets spelled in strings or comments", () => {
		const facts = parseCppFile(
			"content.cpp",
			'#if A\nconst char* open = "(";\n#else\nconst char* close = ")"; // {\n#endif\n',
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["open", "close"]);
		expect(facts.diagnostics).toEqual([]);
	});
});
