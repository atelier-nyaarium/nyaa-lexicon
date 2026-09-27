// Literal values: string escapes, and numbers as Python reads them.

import { SourceCursor } from "@nyaa-lexicon/protocol";
import type { PyValue } from "./ast.js";
import { unicodeNamed } from "./unicodeNames.js";

////////////////////////////////
//  Interfaces & Types

export interface StringShape {
	raw: boolean;
	bytes: boolean;
	interpolated: boolean;
	template: boolean;
	/** The `u` prefix, which `Constant.kind` records. */
	unicode: boolean;
	quote: string;
	/** Offset of the body within the token, past prefix and quote. */
	bodyAt: number;
}

////////////////////////////////
//  Constants

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
	["\\", "\\"],
	["'", "'"],
	['"', '"'],
	["a", "\u0007"],
	["b", "\b"],
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
	["v", "\v"],
]);

////////////////////////////////
//  Functions & Helpers

function isOctal(character: string): boolean {
	return character.length === 1 && character >= "0" && character <= "7";
}

function isHex(character: string): boolean {
	return (
		(character.length === 1 && character >= "0" && character <= "9") ||
		(character >= "a" && character <= "f") ||
		(character >= "A" && character <= "F")
	);
}

/** A string token's prefix letters and quote. */
export function shapeOf(text: string): StringShape {
	const cursor = new SourceCursor(text);
	const prefix = cursor.readWhile((character) => character !== "'" && character !== '"').toLowerCase();
	const quoteCharacter = cursor.peek();
	const quote = cursor.startsWith(quoteCharacter.repeat(3)) ? quoteCharacter.repeat(3) : quoteCharacter;
	return {
		raw: prefix.includes("r"),
		bytes: prefix.includes("b"),
		interpolated: prefix.includes("f"),
		template: prefix.includes("t"),
		unicode: prefix.includes("u"),
		quote,
		bodyAt: prefix.length + quote.length,
	};
}

/**
 * The value a literal's body spells, escapes replaced unless raw. Line breaks are normalized to LF,
 * as the parser reads source. Undefined with the reason when an escape is malformed.
 */
export function decodeBody(body: string, raw: boolean, bytes: boolean): { value: string } | { error: string } {
	const cursor = new SourceCursor(body);
	let value = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("python escape scan failed to advance");
		guard = cursor.offset;
		const character = cursor.next();
		if (character === "\r") {
			if (cursor.peek() === "\n") cursor.next();
			value += "\n";
			continue;
		}
		if (bytes && (character.codePointAt(0) ?? 0) > 0x7f)
			return { error: "bytes can only contain ASCII literal characters" };
		if (character !== "\\" || !cursor.good()) {
			value += character;
			continue;
		}
		if (raw) {
			// A raw backslash keeps what follows, a quote or a line break included.
			value += character;
			continue;
		}
		const escaped = cursor.next();
		if (escaped === "\n") continue;
		if (escaped === "\r") {
			if (cursor.peek() === "\n") cursor.next();
			continue;
		}
		const simple = SIMPLE_ESCAPES.get(escaped);
		if (simple !== undefined) {
			value += simple;
			continue;
		}
		if (isOctal(escaped)) {
			let digits = escaped;
			for (let count = 1; count < 3 && isOctal(cursor.peek()); count++) digits += cursor.next();
			// A byte keeps the low eight bits of an escape past 0o377.
			const code = Number.parseInt(digits, 8);
			value += String.fromCodePoint(bytes ? code & 0xff : code);
			continue;
		}
		const width = escaped === "x" ? 2 : !bytes && escaped === "u" ? 4 : !bytes && escaped === "U" ? 8 : 0;
		if (width > 0) {
			let digits = "";
			for (let count = 0; count < width && isHex(cursor.peek()); count++) digits += cursor.next();
			if (digits.length !== width) return { error: `truncated \\${escaped}${"X".repeat(width)} escape` };
			const point = Number.parseInt(digits, 16);
			if (point > 0x10ffff) return { error: "illegal Unicode character" };
			value += String.fromCodePoint(point);
			continue;
		}
		if (!bytes && escaped === "N") {
			if (!cursor.take("{")) return { error: "malformed \\N character escape" };
			const name = cursor.readWhile((named) => named !== "}");
			const point = cursor.take("}") ? unicodeNamed(name) : undefined;
			if (point === undefined) return { error: "unknown Unicode character name" };
			value += String.fromCodePoint(point);
			continue;
		}
		// An unknown escape keeps its backslash.
		value += `\\${escaped}`;
	}
	return { value };
}

/** A string literal token's value; `Constant.kind` is `u` for a `u` prefix. */
export function stringValue(text: string): { value: PyValue; unicode: boolean } | { error: string } {
	const shape = shapeOf(text);
	const body = text.slice(shape.bodyAt, text.length - shape.quote.length);
	const decoded = decodeBody(body, shape.raw, shape.bytes);
	if ("error" in decoded) return decoded;
	return { value: { kind: shape.bytes ? "bytes" : "str", value: decoded.value }, unicode: shape.unicode };
}

/** A number token's value, or why Python refuses it and where, as an offset into the token. */
export function numberValue(text: string): PyValue | { error: string; at?: number } {
	const lower = text.toLowerCase();
	const imaginary = lower.endsWith("j");
	const body = imaginary ? lower.slice(0, -1) : lower;
	const letter = body.startsWith("0") ? body.charAt(1) : "";
	const radix = letter === "x" ? 16 : letter === "o" ? 8 : letter === "b" ? 2 : 10;
	const name = radix === 16 ? "hexadecimal" : radix === 8 ? "octal" : radix === 2 ? "binary" : "decimal";
	const isDigitOf = (character: string): boolean =>
		radix === 16
			? isHex(character)
			: radix === 8
				? isOctal(character)
				: radix === 2
					? character === "0" || character === "1"
					: character.length === 1 && character >= "0" && character <= "9";
	if (radix !== 10 && imaginary) return { error: `invalid ${name} literal` };
	const characters = [...body];
	if (radix === 2 || radix === 8) {
		const index = characters.findIndex(
			(character, at) => at >= 2 && character >= "0" && character <= "9" && !isDigitOf(character),
		);
		if (index >= 0) return { error: `invalid digit '${characters[index]}' in ${name} literal`, at: index };
	}
	// An underscore sits between two digits, or after a base's letter.
	for (let index = 0; index < characters.length; index++) {
		if (characters[index] !== "_") continue;
		const before = characters[index - 1] ?? "";
		const after = characters[index + 1] ?? "";
		if (!isDigitOf(after) || !(isDigitOf(before) || (radix !== 10 && index === 2)))
			return { error: `invalid ${name} literal` };
	}
	const digits = body.replaceAll("_", "");
	if (radix !== 10) {
		const run = digits.slice(2);
		if (run === "" || [...run].some((character) => !isDigitOf(character)))
			return { error: `invalid ${name} literal` };
		return { kind: "int", value: BigInt(`0${letter}${run}`) };
	}
	const isFloat = digits.includes(".") || digits.includes("e");
	if (imaginary) return { kind: "complex", imag: Number(digits) };
	if (isFloat) return { kind: "float", value: Number(digits) };
	if (digits.length > 1 && digits.startsWith("0") && [...digits].some((character) => character !== "0"))
		return { error: "leading zeros in decimal integer literals are not permitted" };
	return { kind: "int", value: BigInt(digits) };
}
