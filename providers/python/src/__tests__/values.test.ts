import { describe, expect, it } from "bun:test";
import { binaryOperation, floatRepr, type PyLiteral, pyRepr, stringRepr } from "../facts/values.js";

const int = (value: bigint): PyLiteral => ({ kind: "int", value });
const float = (value: number): PyLiteral => ({ kind: "float", value });
const str = (value: string): PyLiteral => ({ kind: "str", value });

function folded(
	operator: Parameters<typeof binaryOperation>[0],
	left: PyLiteral,
	right: PyLiteral,
): string | undefined {
	const result = binaryOperation(operator, left, right);
	return result === undefined ? undefined : pyRepr(result);
}

describe("Python values", () => {
	it("writes a float as repr does", () => {
		expect(
			[1e16, 1e15, 1e-5, 1e-4, 0.1, 1.5, -0, 1 / 3, Number.POSITIVE_INFINITY, Number.NaN].map(floatRepr),
		).toEqual([
			"1e+16",
			"1000000000000000.0",
			"1e-05",
			"0.0001",
			"0.1",
			"1.5",
			"-0.0",
			"0.3333333333333333",
			"inf",
			"nan",
		]);
	});

	it("writes a string as repr does", () => {
		const noBreak = String.fromCodePoint(0xa0);
		const accented = String.fromCodePoint(0xe9);
		const emoji = String.fromCodePoint(0x1f600);
		expect([`it's`, `say "hi" it's`, "tab\t\\", `${noBreak}${accented}`, emoji].map(stringRepr)).toEqual([
			`"it's"`,
			`'say "hi" it\\'s'`,
			"'tab\\t\\\\'",
			`'\\xa0${accented}'`,
			`'${emoji}'`,
		]);
	});

	it("folds arithmetic as CPython computes it", () => {
		expect(folded("FloorDiv", int(-7n), int(2n))).toBe("-4");
		expect(folded("Mod", int(-7n), int(2n))).toBe("1");
		expect(folded("Mod", float(-7), float(2))).toBe("1.0");
		expect(folded("Div", int(1n), int(3n))).toBe("0.3333333333333333");
		expect(folded("Div", int(10n ** 30n), int(3n))).toBe("3.333333333333333e+29");
		expect(folded("Add", { kind: "bool", value: true }, int(1n))).toBe("2");
		expect(folded("Mult", str("ab"), int(3n))).toBe("'ababab'");
		expect(folded("Mod", str("%05d%%"), int(-42n))).toBe("'-0042%'");
		expect(folded("Mod", str("[%-4s]"), str("ab"))).toBe("'[ab  ]'");
	});

	it("folds nothing where Python raises", () => {
		expect(folded("Div", int(1n), int(0n))).toBeUndefined();
		expect(folded("Add", str("a"), int(1n))).toBeUndefined();
		expect(folded("Add", int(10n ** 400n), float(1))).toBeUndefined();
		expect(folded("Mod", str("%s %s"), str("a"))).toBeUndefined();
		expect(folded("Mod", str("%05d|%#x"), int(42n))).toBeUndefined();
		expect(folded("Mod", str("%x"), float(1.5))).toBeUndefined();
	});
});
