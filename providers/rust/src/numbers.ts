// Numeric literal values, and the primitive type a literal spells.

import type { RustNumber, RustToken } from "./tokens.js";

////////////////////////////////
//  Constants

const INTEGER_SUFFIXES = new Set([
	"u8",
	"u16",
	"u32",
	"u64",
	"u128",
	"usize",
	"i8",
	"i16",
	"i32",
	"i64",
	"i128",
	"isize",
]);
const FLOAT_SUFFIXES = new Set(["f32", "f64"]);
const BASE_PREFIX = { 2: "0b", 8: "0o", 10: "", 16: "0x" } as const;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAFE_INTEGER_TEXT = String(Number.MAX_SAFE_INTEGER);

////////////////////////////////
//  Functions

function isFloat(number: RustNumber): boolean {
	return number.fraction !== undefined || number.exponent !== undefined;
}

/** Underscore-free digits, if all valid. */
function digitsIn(text: string, base: RustNumber["base"]): string | undefined {
	const digits = text.replaceAll("_", "");
	if (digits === "") return undefined;
	return [...digits].every((character) => Number.parseInt(character, base) >= 0) ? digits : undefined;
}

function safeIntegerValue(prefix: string, digits: string): number | undefined {
	const value = BigInt(`${prefix}${digits}`);
	return value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : undefined;
}

function decimalExceedsSafeInteger(integerPart: string, fractionPart: string, exponent: number): boolean {
	const digits = `${integerPart}${fractionPart}`.replace(/^0+/u, "");
	if (digits === "") return false;
	if (!Number.isFinite(exponent)) return exponent > 0;
	const scale = fractionPart.length - exponent;
	if (scale <= 0) {
		const trailingZeroes = -scale;
		const digitCount = digits.length + trailingZeroes;
		if (digitCount !== MAX_SAFE_INTEGER_TEXT.length) return digitCount > MAX_SAFE_INTEGER_TEXT.length;
		return BigInt(`${digits}${"0".repeat(trailingZeroes)}`) > MAX_SAFE_INTEGER_BIGINT;
	}
	const thresholdLength = MAX_SAFE_INTEGER_TEXT.length + scale;
	if (digits.length !== thresholdLength) return digits.length > thresholdLength;
	return BigInt(digits) > MAX_SAFE_INTEGER_BIGINT * 10n ** BigInt(scale);
}

export function numericValue(number: RustNumber): number | undefined {
	const { base, suffix } = number;
	const integer = digitsIn(number.integer, base);
	if (integer === undefined) return undefined;
	if (!isFloat(number)) {
		if (suffix === "" || INTEGER_SUFFIXES.has(suffix)) return safeIntegerValue(BASE_PREFIX[base], integer);
		return base === 10 && FLOAT_SUFFIXES.has(suffix) ? safeIntegerValue("", integer) : undefined;
	}
	if (base !== 10 || !(suffix === "" || FLOAT_SUFFIXES.has(suffix))) return undefined;
	const fraction = (number.fraction ?? "").replaceAll("_", "");
	let exponent = "0";
	if (number.exponent !== undefined) {
		const digits = digitsIn(number.exponent.digits, 10);
		if (digits === undefined) return undefined;
		exponent = `${number.exponent.sign}${digits}`;
	}
	const value = Number(`${integer}.${fraction}e${exponent}`);
	return Number.isFinite(value) && !decimalExceedsSafeInteger(integer, fraction, Number.parseInt(exponent, 10))
		? value
		: undefined;
}

export function primitiveTypeForLiteral(token: RustToken): string | undefined {
	if (token.kind === "string") return "&str";
	if (token.kind === "char") return token.prefix === "b" ? "u8" : "char";
	if (token.value === "true" || token.value === "false") return "bool";
	const number = token.number;
	if (number === undefined) return undefined;
	if (INTEGER_SUFFIXES.has(number.suffix) || FLOAT_SUFFIXES.has(number.suffix)) return number.suffix;
	return isFloat(number) ? "f64" : "i32";
}
