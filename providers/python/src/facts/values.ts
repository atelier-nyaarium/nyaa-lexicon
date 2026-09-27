// Python's answers for the literal values inference folds: `repr`, and `+ - * / // %` over None, bool,
// int, float and str, as CPython computes them. Undefined is where Python raises.

import type { Operator, PyValue } from "../syntax/ast.js";

////////////////////////////////
//  Interfaces & Types

export type PyLiteral = Extract<PyValue, { kind: "None" | "bool" | "int" | "float" | "str" }>;

type PyNumber = Extract<PyValue, { kind: "int" | "float" }>;

////////////////////////////////
//  Constants

/** `str.isprintable` refuses these categories, the space excepted. */
const UNPRINTABLE_RE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** Past this, `int / int` leaves the doubles that divide it exactly. */
const EXACT_LIMIT = 1n << 53n;

/** C's `float.h` for a double. */
const DBL_MANT_DIG = 53;
const DBL_MIN_EXP = -1021;
const DBL_MAX_EXP = 1024;

/** A repeated string longer than this is not folded. */
const REPEAT_LIMIT = 1 << 24;

////////////////////////////////
//  Functions & Helpers

export function isLiteral(value: PyValue): value is PyLiteral {
	return (
		value.kind === "None" ||
		value.kind === "bool" ||
		value.kind === "int" ||
		value.kind === "float" ||
		value.kind === "str"
	);
}

function hex(point: number, width: number): string {
	return point.toString(16).padStart(width, "0");
}

/** `repr(float)`: the shortest round trip, exponent outside `1e-4 <= |x| < 1e16`. */
export function floatRepr(value: number): string {
	if (Number.isNaN(value)) return "nan";
	if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
	if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
	const sign = value < 0 ? "-" : "";
	const [mantissa = "", exponent = "0"] = Math.abs(value).toExponential().split("e");
	const digits = mantissa.replace(".", "");
	// Where the point falls after the first digit's place, as CPython's dtoa reports it.
	const point = Number(exponent) + 1;
	if (point <= -4 || point > 16) {
		const power = point - 1;
		const body = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
		return `${sign}${body}e${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
	}
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** `repr(str)`: single quotes unless only a single quote is inside, unprintables escaped. */
export function stringRepr(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	let written = quote;
	for (const character of value) {
		const point = character.codePointAt(0) as number;
		if (character === quote || character === "\\") written += `\\${character}`;
		else if (character === "\t") written += "\\t";
		else if (character === "\n") written += "\\n";
		else if (character === "\r") written += "\\r";
		else if (point < 0x20 || point === 0x7f) written += `\\x${hex(point, 2)}`;
		else if (point < 0x7f || !UNPRINTABLE_RE.test(character)) written += character;
		else if (point <= 0xff) written += `\\x${hex(point, 2)}`;
		else if (point <= 0xffff) written += `\\u${hex(point, 4)}`;
		else written += `\\U${hex(point, 8)}`;
	}
	return written + quote;
}

export function pyRepr(value: PyLiteral): string {
	switch (value.kind) {
		case "None":
			return "None";
		case "bool":
			return value.value ? "True" : "False";
		case "int":
			return value.value.toString();
		case "float":
			return floatRepr(value.value);
		case "str":
			return stringRepr(value.value);
	}
}

/** `str(value)`, which differs from `repr` only for a string. */
function pyStr(value: PyLiteral): string {
	return value.kind === "str" ? value.value : pyRepr(value);
}

/** A bool counts as the int it subclasses. */
function numeric(value: PyLiteral): PyNumber | undefined {
	if (value.kind === "bool") return { kind: "int", value: value.value ? 1n : 0n };
	return value.kind === "int" || value.kind === "float" ? value : undefined;
}

/** `float(value)`; undefined where the int is too large for one. */
function toFloat(value: PyNumber): number | undefined {
	if (value.kind === "float") return value.value;
	const converted = Number(value.value);
	return Number.isFinite(converted) ? converted : undefined;
}

function magnitude(value: bigint): bigint {
	return value < 0n ? -value : value;
}

function bitLength(value: bigint): number {
	return value === 0n ? 0 : value.toString(2).length;
}

/**
 * `int / int`, correctly rounded as CPython's `long_true_divide` rounds it: the quotient keeps two
 * or three bits past the double's, fewer where the result is subnormal, and rounds half to even.
 */
function trueDivide(dividend: bigint, divisor: bigint): number | undefined {
	if (magnitude(dividend) <= EXACT_LIMIT && magnitude(divisor) <= EXACT_LIMIT) {
		return Number(dividend) / Number(divisor);
	}
	const negative = dividend < 0n !== divisor < 0n;
	const numerator = magnitude(dividend);
	const denominator = magnitude(divisor);
	if (numerator === 0n) return negative ? -0 : 0;
	const diff = bitLength(numerator) - bitLength(denominator);
	if (diff > DBL_MAX_EXP) return undefined;
	if (diff < DBL_MIN_EXP - DBL_MANT_DIG - 1) return negative ? -0 : 0;
	const shift = Math.max(diff, DBL_MIN_EXP) - DBL_MANT_DIG - 2;
	const scaled = shift >= 0 ? numerator >> BigInt(shift) : numerator << BigInt(-shift);
	let inexact = shift > 0 && (numerator & ((1n << BigInt(shift)) - 1n)) !== 0n;
	let quotient = scaled / denominator;
	if (scaled % denominator !== 0n) inexact = true;
	const bits = bitLength(quotient);
	const extra = Math.max(bits, DBL_MIN_EXP - shift) - DBL_MANT_DIG;
	const mask = 1n << BigInt(extra - 1);
	if (inexact) quotient |= 1n;
	if ((quotient & mask) !== 0n && (quotient & (3n * mask - 1n)) !== 0n) quotient += mask;
	quotient &= ~(2n * mask - 1n);
	const rounded = Number(quotient);
	if (shift + bits >= DBL_MAX_EXP && (shift + bits > DBL_MAX_EXP || rounded === 2 ** bits)) return undefined;
	// Two exact steps, since one power of two this small underflows to zero.
	const first = Math.max(shift, -1000);
	const result = rounded * 2 ** first * 2 ** (shift - first);
	return negative ? -result : result;
}

function floorDivide(dividend: bigint, divisor: bigint): bigint {
	const quotient = dividend / divisor;
	return dividend % divisor !== 0n && dividend < 0n !== divisor < 0n ? quotient - 1n : quotient;
}

/** CPython's `float_divmod`: the remainder takes the divisor's sign. */
function floatDivmod(dividend: number, divisor: number): [number, number] {
	let remainder = dividend % divisor;
	let quotient = (dividend - remainder) / divisor;
	if (remainder !== 0) {
		if (divisor < 0 !== remainder < 0) {
			remainder += divisor;
			quotient -= 1;
		}
	} else {
		remainder = divisor < 0 ? -0 : 0;
	}
	let floored: number;
	if (quotient !== 0) {
		floored = Math.floor(quotient);
		if (quotient - floored > 0.5) floored += 1;
	} else {
		floored = dividend / divisor < 0 || Object.is(dividend / divisor, -0) ? -0 : 0;
	}
	return [floored, remainder];
}

function intOperation(operator: Operator, left: bigint, right: bigint): PyLiteral | undefined {
	switch (operator) {
		case "Add":
			return { kind: "int", value: left + right };
		case "Sub":
			return { kind: "int", value: left - right };
		case "Mult":
			return { kind: "int", value: left * right };
		case "Div": {
			if (right === 0n) return undefined;
			const quotient = trueDivide(left, right);
			return quotient === undefined ? undefined : { kind: "float", value: quotient };
		}
		case "FloorDiv":
			return right === 0n ? undefined : { kind: "int", value: floorDivide(left, right) };
		case "Mod":
			return right === 0n ? undefined : { kind: "int", value: left - right * floorDivide(left, right) };
		default:
			return undefined;
	}
}

function floatOperation(operator: Operator, left: number, right: number): PyLiteral | undefined {
	switch (operator) {
		case "Add":
			return { kind: "float", value: left + right };
		case "Sub":
			return { kind: "float", value: left - right };
		case "Mult":
			return { kind: "float", value: left * right };
		case "Div":
			return right === 0 ? undefined : { kind: "float", value: left / right };
		case "FloorDiv":
			return right === 0 ? undefined : { kind: "float", value: floatDivmod(left, right)[0] };
		case "Mod":
			return right === 0 ? undefined : { kind: "float", value: floatDivmod(left, right)[1] };
		default:
			return undefined;
	}
}

function repeated(text: string, count: PyLiteral): PyLiteral | undefined {
	const times = numeric(count);
	if (times?.kind !== "int") return undefined;
	if (times.value <= 0n || text === "") return { kind: "str", value: "" };
	if (times.value * BigInt(text.length) > BigInt(REPEAT_LIMIT)) return undefined;
	return { kind: "str", value: text.repeat(Number(times.value)) };
}

function textOperation(operator: Operator, left: PyLiteral, right: PyLiteral): PyLiteral | undefined {
	if (operator === "Add") {
		return left.kind === "str" && right.kind === "str"
			? { kind: "str", value: left.value + right.value }
			: undefined;
	}
	if (operator === "Mult") {
		if (left.kind === "str") return repeated(left.value, right);
		return right.kind === "str" ? repeated(right.value, left) : undefined;
	}
	if (operator === "Mod" && left.kind === "str") {
		const text = formatted(left.value, right);
		return text === undefined ? undefined : { kind: "str", value: text };
	}
	return undefined;
}

function isDigit(character: string | undefined): boolean {
	return character !== undefined && character >= "0" && character <= "9";
}

/**
 * `text % value` for one value no tuple holds, when every conversion is a text or integer one. Read
 * by code point, as Python counts characters.
 */
function formatted(text: string, value: PyLiteral): string | undefined {
	const characters = [...text];
	let written = "";
	let used = false;
	let at = 0;
	while (at < characters.length) {
		const character = characters[at++] as string;
		if (character !== "%") {
			written += character;
			continue;
		}
		let flags = "";
		while (at < characters.length && "-+ #0".includes(characters[at] as string)) flags += characters[at++];
		let width = "";
		while (isDigit(characters[at])) width += characters[at++];
		let precision: string | undefined;
		if (characters[at] === ".") {
			at++;
			precision = "";
			while (isDigit(characters[at])) precision += characters[at++];
		}
		if (at < characters.length && "hlL".includes(characters[at] as string)) at++;
		const conversion = characters[at++];
		if (conversion === undefined || !"%sradiuxXoc".includes(conversion)) return undefined;
		if (conversion === "%") {
			written += "%";
			continue;
		}
		if (used) return undefined;
		used = true;
		const field = converted(conversion, flags, precision, value);
		if (field === undefined) return undefined;
		written += padded(field, flags, width === "" ? 0 : Number(width), "diuxXo".includes(conversion));
	}
	return used ? written : undefined;
}

function converted(
	conversion: string,
	flags: string,
	precision: string | undefined,
	value: PyLiteral,
): string | undefined {
	const cut = (text: string): string =>
		precision === undefined ? text : [...text].slice(0, Number(precision || "0")).join("");
	switch (conversion) {
		case "s":
			return cut(pyStr(value));
		case "r":
			return cut(pyRepr(value));
		case "a":
			return cut([...pyRepr(value)].map(asciiEscape).join(""));
		case "c":
			return characterOf(value);
		default:
			return integerField(conversion, flags, precision, value);
	}
}

function asciiEscape(character: string): string {
	const point = character.codePointAt(0) as number;
	if (point < 0x80) return character;
	if (point <= 0xff) return `\\x${hex(point, 2)}`;
	return point <= 0xffff ? `\\u${hex(point, 4)}` : `\\U${hex(point, 8)}`;
}

function characterOf(value: PyLiteral): string | undefined {
	if (value.kind === "str") return [...value.value].length === 1 ? value.value : undefined;
	const number = numeric(value);
	if (number?.kind !== "int" || number.value < 0n || number.value > 0x10ffffn) return undefined;
	return String.fromCodePoint(Number(number.value));
}

/** `%d`, `%x` and kin: a float truncates for the decimal ones and is refused by the others. */
function integerField(
	conversion: string,
	flags: string,
	precision: string | undefined,
	value: PyLiteral,
): string | undefined {
	const number = numeric(value);
	if (number === undefined) return undefined;
	let integer: bigint;
	if (number.kind === "int") integer = number.value;
	else if ("diu".includes(conversion) && Number.isFinite(number.value)) integer = BigInt(Math.trunc(number.value));
	else return undefined;
	const radix = conversion === "o" ? 8 : conversion === "x" || conversion === "X" ? 16 : 10;
	let digits = magnitude(integer).toString(radix);
	if (conversion === "X") digits = digits.toUpperCase();
	if (precision !== undefined) digits = digits.padStart(Number(precision || "0"), "0");
	const prefix = flags.includes("#") && radix !== 10 ? `0${conversion === "o" ? "o" : conversion}` : "";
	const sign = integer < 0n ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
	return `${sign}${prefix}${digits}`;
}

/** Width padding by code point: left with `-`, zeros after any sign and prefix with `0` on a number. */
function padded(field: string, flags: string, width: number, number: boolean): string {
	const length = [...field].length;
	if (length >= width) return field;
	const blanks = " ".repeat(width - length);
	if (flags.includes("-")) return `${field}${blanks}`;
	if (!number || !flags.includes("0")) return `${blanks}${field}`;
	let lead = "-+ ".includes(field[0] as string) ? 1 : 0;
	if (field[lead] === "0" && "oxX".includes(field[lead + 1] ?? "_")) lead += 2;
	return field.slice(0, lead) + field.slice(lead).padStart(width - lead, "0");
}

////////////////////////////////
//  Main

/** `left <operator> right` as Python computes it; undefined where Python raises. */
export function binaryOperation(operator: Operator, left: PyLiteral, right: PyLiteral): PyLiteral | undefined {
	if (left.kind === "str" || right.kind === "str") return textOperation(operator, left, right);
	const a = numeric(left);
	const b = numeric(right);
	if (a === undefined || b === undefined) return undefined;
	if (a.kind === "int" && b.kind === "int") return intOperation(operator, a.value, b.value);
	const x = toFloat(a);
	const y = toFloat(b);
	return x === undefined || y === undefined ? undefined : floatOperation(operator, x, y);
}
