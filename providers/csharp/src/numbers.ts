// C# number literals: their text, value and type.

import type { SourceCursor } from "@nyaa-lexicon/protocol";
import { isDigit, isHexDigit } from "./characters.js";

////////////////////////////////
//  Constants

const RADIX_PREFIXES: ReadonlyMap<string, number> = new Map([
	["x", 16],
	["X", 16],
	["b", 2],
	["B", 2],
]);

/** Real suffixes, lowercased, to their types. */
const REAL_TYPES: ReadonlyMap<string, string> = new Map([
	["f", "float"],
	["d", "double"],
	["m", "decimal"],
]);

const INT_MAX = 0x7fffffffn;
const UINT_MAX = 0xffffffffn;
const LONG_MAX = 0x7fffffffffffffffn;

////////////////////////////////
//  Functions & Helpers

function isDigitOrSeparator(character: string): boolean {
	return isDigit(character) || character === "_";
}

function isIntegerSuffix(character: string): boolean {
	return character === "u" || character === "U" || character === "l" || character === "L";
}

function isNumberSuffix(character: string): boolean {
	return isIntegerSuffix(character) || REAL_TYPES.has(character.toLowerCase());
}

function exactInteger(text: string): bigint | undefined {
	try {
		return BigInt(text.replaceAll("_", ""));
	} catch {
		return undefined;
	}
}

function safeNumber(exact: bigint | undefined): number | undefined {
	return exact === undefined || exact > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(exact);
}

/** The first type that holds the value, among those the suffix allows. */
function integerType(exact: bigint | undefined, suffix: string): string {
	const lower = suffix.toLowerCase();
	const unsigned = lower.includes("u");
	const long = lower.includes("l");
	if (unsigned && long) return "ulong";
	const value = exact ?? 0n;
	if (unsigned) return value <= UINT_MAX ? "uint" : "ulong";
	if (long) return value <= LONG_MAX ? "long" : "ulong";
	return value <= INT_MAX ? "int" : value <= UINT_MAX ? "uint" : value <= LONG_MAX ? "long" : "ulong";
}

/** A number literal's text, value and type, read part by part. */
export function readNumber(cursor: SourceCursor): { value: string; number: number | undefined; type: string } {
	const start = cursor.offset;
	const radix = cursor.peek() === "0" ? RADIX_PREFIXES.get(cursor.peek(1)) : undefined;
	if (radix !== undefined) {
		const prefix = cursor.next() + cursor.next();
		const digits = cursor.readWhile(
			(character) =>
				character === "_" || (radix === 16 ? isHexDigit(character) : character === "0" || character === "1"),
		);
		const suffix = cursor.readWhile(isIntegerSuffix);
		const exact = exactInteger(`${prefix}${digits}`);
		return { value: cursor.textOf(start), number: safeNumber(exact), type: integerType(exact, suffix) };
	}
	const whole = cursor.readWhile(isDigitOrSeparator);
	let fraction = "";
	if (cursor.peek() === "." && isDigit(cursor.peek(1)))
		fraction = cursor.next() + cursor.readWhile(isDigitOrSeparator);
	let exponent = "";
	if (cursor.peek() === "e" || cursor.peek() === "E") {
		const mark = cursor.mark();
		let candidate = cursor.next();
		if (cursor.peek() === "+" || cursor.peek() === "-") candidate += cursor.next();
		const digits = cursor.readWhile(isDigitOrSeparator);
		if (digits === "") cursor.rewind(mark);
		else exponent = candidate + digits;
	}
	const suffix = cursor.readWhile(isNumberSuffix);
	const realType = REAL_TYPES.get(suffix.toLowerCase());
	if (fraction === "" && exponent === "" && realType === undefined) {
		const exact = exactInteger(whole);
		return { value: cursor.textOf(start), number: safeNumber(exact), type: integerType(exact, suffix) };
	}
	const number = Number(`${whole}${fraction}${exponent}`.replaceAll("_", ""));
	return {
		value: cursor.textOf(start),
		number: Number.isFinite(number) ? number : undefined,
		type: realType ?? "double",
	};
}
