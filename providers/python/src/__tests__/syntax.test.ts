import { describe, expect, it } from "bun:test";
import { coordinatesOf, MAX_NESTING, type Position, TOO_DEEP } from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { walk } from "../syntax/ast.js";
import { parseExpression, parseFunctionType, parsePython } from "../syntax/parser.js";
import { tokenize } from "../syntax/tokenizer.js";

function accepts(text: string): boolean {
	return parsePython(text).module !== undefined;
}

function module(text: string): A.Module {
	const parsed = parsePython(text);
	if (parsed.module === undefined) throw new Error(parsed.error?.message);
	return parsed.module;
}

describe("Python tokenizer", () => {
	it("places every token on its source text, line and column", () => {
		const text = "def f(a):\r\n    return f'{a!r:>{w}}' + '''x\ny'''  # c\n";
		const { tokens, error } = tokenize(text);
		const coordinates = coordinatesOf(text);
		expect(error).toBeUndefined();
		for (const token of tokens) {
			expect(text.slice(token.pos, token.end)).toBe(token.string);
			expect({ line: token.line, character: token.column }).toEqual(
				coordinates.positionAt(token.pos) as Position,
			);
		}
	});

	it("keeps a backslash's next character in an f-string's text, raw or not, a brace aside", () => {
		expect(accepts(`rf"\\"x" + f"a\\"b"\n`)).toBe(true);
		expect(tokenize(`f"\\{x}"\n`).tokens.some((token) => token.string === "x")).toBe(true);
	});

	it("nests fields in format specs three deep", () => {
		expect(accepts("f'{x:{y:{z}}}'\n")).toBe(true);
		expect(tokenize("f'{x:{y:{z:{w}}}}'\n").error?.message).toBe("f-string: expressions nested too deeply");
	});
});

describe("Python parser", () => {
	it("spans a parenthesized child without its parentheses, and a block to its trailing `;`", () => {
		const text = "if a:\n    x = (b + c);\n";
		const statement = module(text).body[0] as A.If;
		const assign = statement.body[0] as A.Assign;
		expect(text.slice(assign.value.pos, assign.value.end)).toBe("b + c");
		expect(text.slice(assign.pos, assign.end)).toBe("x = (b + c)");
		expect(text.slice(statement.pos, statement.end)).toBe("if a:\n    x = (b + c);");
	});

	it("refuses what CPython 3.12's grammar refuses", () => {
		for (const text of [
			"del\n",
			"del *x\n",
			"def f(*, **k): pass\n",
			"def f(**k, a): pass\n",
			"f(**a, *b)\n",
			"[*x for x in y]\n",
			"x[a := 1:2]\n",
			"{a := 1: 2}\n",
			"from a import ()\n",
			"try:\n    pass\nexcept*:\n    pass\n",
			"try:\n    pass\nexcept A:\n    pass\nexcept* B:\n    pass\n",
			"try:\n    pass\nexcept A, B as e:\n    pass\n",
			"match x:\n    case {k: v}:\n        pass\n",
			"match x:\n    case {**rest, 'k': v}:\n        pass\n",
			"match x:\n    case {**_}:\n        pass\n",
			"match x:\n    case 1 + 2:\n        pass\n",
			"match x:\n    case 2j + 1:\n        pass\n",
		]) {
			expect([text, accepts(text)]).toEqual([text, false]);
		}
	});

	it("reads the newest grammar: t-strings, type parameter defaults, bare `except` tuples", () => {
		expect(accepts("t'{x}'\n")).toBe(true);
		expect(accepts("def f[T = int](): pass\n")).toBe(true);
		const handler = (module("try:\n    pass\nexcept A, B:\n    pass\n").body[0] as A.Try).handlers[0];
		expect(handler?.exceptionType?.type).toBe("Tuple");
	});

	it("reads type comments in eval and signature modes", () => {
		expect(parseExpression("List[int], str")?.type).toBe("Tuple");
		expect(parseFunctionType("(int, *Args, **Kwargs) -> str")?.argtypes.length).toBe(3);
		expect(parseFunctionType("(int,) -> str")).toBeUndefined();
		expect(parseExpression("x = 1")).toBeUndefined();
	});

	it("attaches a type comment only where CPython's type_comments mode accepts one", () => {
		const parsed = module("x = []  # type: List[int]\nf()  # type: int\ny = 1  # type: ignore_reason\n");
		expect((parsed.body[0] as A.Assign).typeComment).toBe("List[int]");
		expect(parsed.body).toHaveLength(3);
		expect((parsed.body[2] as A.Assign).typeComment).toBeUndefined();
		expect(parsed.typeIgnores.map((ignore) => ignore.tag)).toEqual(["_reason"]);
	});

	it("decodes literal values as CPython does", () => {
		const value = (text: string): unknown => ((module(text).body[0] as A.Expr).value as A.Constant).value;
		const joined = (text: string): unknown =>
			(((module(text).body[0] as A.Expr).value as A.JoinedStr).values[0] as A.Constant).value;
		expect(joined("f'\\{{'\n")).toEqual({ kind: "str", value: "\\{" });
		expect(value("b'\\400'\n")).toEqual({ kind: "bytes", value: "\0" });
		expect(value("'\\N{latin small letter a}'\n")).toEqual({ kind: "str", value: "a" });
		expect(accepts(`'\\N{LATIN SMALL LETTER LONG ${String.fromCodePoint(0x17f)}}'\n`)).toBe(false);
		expect(parsePython("0b12\n").error?.pos).toBe(3);
	});

	it("refuses a tree deeper than the nesting limit, however it grew", () => {
		const chain = (terms: number): string => `x = ${Array.from({ length: terms }, () => "a").join(" + ")}\n`;
		expect(accepts(chain(MAX_NESTING - 10))).toBe(true);
		expect(parsePython(chain(MAX_NESTING * 5)).error?.message).toBe(TOO_DEEP);
		expect(walk(module(chain(3))).length).toBeGreaterThan(3);
		const elifs = `if a:\n    pass\n${"elif a:\n    pass\n".repeat(MAX_NESTING * 20)}`;
		expect(parsePython(elifs).error?.message).toBe(TOO_DEEP);
	});
});
