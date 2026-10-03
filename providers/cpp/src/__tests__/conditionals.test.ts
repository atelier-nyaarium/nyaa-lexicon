import { describe, expect, test } from "bun:test";
import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { CppProvider } from "../main.js";
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
			["run", "first", "second"],
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
		expect(facts.declarations.map((item) => item.name)).toEqual([...names]);
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
		expect(facts.importFacts.map((item) => item.specifier)).toEqual(["kept.h"]);
	});

	test("keeps the first branch when the second branch is a fragment", () => {
		const facts = parseCppFile(
			"fragment.cpp",
			"void run() {\n#if A\nint x; x = (1\n#else\nint x; x = (2\n#endif\n);\n}\n",
		);
		expect(facts.declarations.map((item) => item.name)).toEqual(["run", "x"]);
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

	test("ignores delimiters in directive lines when judging a branch and reading structure", () => {
		const tokens = tokenize("#if A\n#define OPEN {\nint first;\n#else\nint second;\n#endif\n").tokens;
		expect(tokens.map((item) => item.value)).toContain("first");
		expect(tokens.map((item) => item.value)).toContain("second");

		const facts = parseCppFile("directive-brace.cpp", "struct S {\n#define OPEN {\n};\nint after;\n");
		expect(facts.declarations.map((item) => [item.name, item.range.end.line])).toEqual([
			["S", 2],
			["after", 3],
		]);
		expect(facts.diagnostics).toEqual([]);
	});

	test("declares what each alternative writes after specifiers shared before the group", () => {
		const facts = parseCppFile("shared.cpp", "int\n#if A\n*p;\n#else\np;\n#endif\nint after;\n");
		expect(facts.declarations.map((item) => [item.name, item.signature])).toEqual([
			["p", "int *p"],
			["p", "int p"],
			["after", "int after"],
		]);
	});

	test("binds a name declared in every alternative to all of them, and one inside a branch to its own", () => {
		const text = [
			"#if A",
			"int x;",
			"#else",
			"int x;",
			"#endif",
			"void f() { x++; }",
			"void g() {",
			"#if A",
			"\tint y; y++;",
			"#else",
			"\tint y; y++;",
			"#endif",
			"\ty++;",
			"}",
		].join("\n");
		const provider = handlersFor(new CppProvider());
		provider.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
		const facts = provider.parseFile({ module: "alternatives.cpp", contentHash: "alternatives", text });
		const lines = (symbolId: string) =>
			facts.declarations.find((item) => item.symbolId === symbolId)?.range.start.line ?? -1;
		const bindings = facts.references
			.filter((item) => item.name === "x" || item.name === "y")
			.map((item) =>
				item.binding.status === "bound"
					? [lines(item.binding.symbolId)]
					: item.binding.status === "ambiguous"
						? item.binding.candidates.map(lines).sort((left, right) => left - right)
						: [],
			);

		expect(bindings).toEqual([[1, 3], [8], [10], [8, 10]]);
	});

	test("merges no declarations across exclusive alternatives, but a body after them completes each head", () => {
		const text = [
			"#if A",
			"int f();",
			"struct S;",
			"int g(int a)",
			"#else",
			"double f();",
			"struct S {};",
			"int g(int b)",
			"#endif",
			"{ return 0; }",
			"void use() { f(); S* p; g(1); }",
		].join("\n");
		const provider = handlersFor(new CppProvider());
		provider.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
		const facts = provider.parseFile({ module: "exclusive.cpp", contentHash: "exclusive", text });
		const lines = (symbolId: string) =>
			facts.declarations.find((item) => item.symbolId === symbolId)?.range.start.line ?? -1;
		const uses = facts.references
			.filter((item) => ["f", "S", "g"].includes(item.name) && item.range.start.line === 10)
			.map((item) => [
				item.name,
				item.binding.status === "ambiguous"
					? item.binding.candidates.map(lines).sort((left, right) => left - right)
					: item.binding.status === "bound"
						? [lines(item.binding.symbolId)]
						: item.binding.status,
			]);

		expect(facts.declarations.filter((item) => ["f", "S", "g"].includes(item.name))).toHaveLength(5);
		expect(uses).toEqual([
			["f", [1, 5]],
			["S", [2, 6]],
			["g", [7]],
		]);
	});

	test("binds a name declared in many alternatives in time linear in their count", () => {
		const timed = (count: number) => {
			const branches = Array.from(
				{ length: count },
				(_, index) => `${index === 0 ? "#if" : "#elif"} A${index}\n\tint x = ${index};\n`,
			);
			const text = `void f() {\n${branches.join("")}#endif\n${"\tx++;\n".repeat(32)}}\n`;
			let best = Number.POSITIVE_INFINITY;
			let candidates = 0;
			for (let round = 0; round < 3; round++) {
				const provider = handlersFor(new CppProvider());
				provider.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
				const started = performance.now();
				const facts = provider.parseFile({ module: "branches.cpp", contentHash: String(round), text });
				best = Math.min(best, performance.now() - started);
				const use = facts.references.at(-1)?.binding;
				candidates = use?.status === "ambiguous" ? use.candidates.length : 0;
			}
			return { best, candidates };
		};
		const small = timed(250);
		const large = timed(2_000);

		// Each alternative's local stays in view, and each use lists them all: linear reads 8x, comparing
		// every pair 64x.
		expect([small.candidates, large.candidates]).toEqual([250, 2_000]);
		expect(large.best / small.best).toBeLessThan(24);
	});

	test("resolves deeply nested groups in time linear in their depth", () => {
		const timed = (count: number) => {
			const text = `${"#if A\n".repeat(count)}int x;\n${"#else\nint y;\n#endif\n".repeat(count)}`;
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				tokenize(text, "nested.cpp");
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads 8x; rescanning each enclosing branch per group reads 64x.
		expect(timed(4_000) / timed(500)).toBeLessThan(24);
	});

	test("keeps duplicate declarations from whole alternatives", () => {
		const facts = parseCppFile(
			"duplicates.cpp",
			"#if A\nint value;\nvoid run() {}\n#else\nint value;\nvoid run() { int inner; }\n#endif\n",
		);
		expect(facts.declarations.filter((item) => item.name === "value")).toHaveLength(2);
		expect(facts.declarations.filter((item) => item.name === "run").map((item) => item.range.start.line)).toEqual([
			2, 5,
		]);
	});

	test("reads a constructor whose member initializers hold a conditional", () => {
		const facts = parseCppFile(
			"initializers.cpp",
			"Foo::Foo() : a(1)\n#if FEATURE\n, b(2)\n#endif\n{ int inner; }\nint after;\n",
		);
		const foo = facts.declarations.find((item) => item.name === "Foo");
		expect(facts.declarations.map((item) => item.name)).toEqual(["Foo", "inner", "after"]);
		expect(facts.declarations[1]?.containerId).toBe(foo?.symbolId);
		expect(foo?.range.end.line).toBe(4);
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
