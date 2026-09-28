// C# escape sequences: in character and string literals, and in identifiers.

import type { SourceCursor } from "@nyaa-lexicon/protocol";
import { isFormatting, isHexDigit, isIdentifierPart, isIdentifierStart } from "./characters.js";

////////////////////////////////
//  Constants

const SIMPLE_ESCAPES: Record<string, string> = {
	"0": "\0",
	a: "\x07",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	'"': '"',
	"'": "'",
};

////////////////////////////////
//  Functions & Helpers

export function decodeEscape(cursor: SourceCursor): string {
	const slash = cursor.next();
	if (slash !== "\\") return slash;
	const escaped = cursor.next();
	if (escaped === "") return "\\";
	const simple = SIMPLE_ESCAPES[escaped];
	if (simple !== undefined) return simple;
	const digits = escaped === "u" ? 4 : escaped === "U" ? 8 : escaped === "x" ? 2 : 0;
	if (digits === 0) return escaped;
	let hex = "";
	let guard = -1;
	while (hex.length < digits && isHexDigit(cursor.peek())) {
		if (cursor.offset <= guard) throw new Error("escape reader failed to advance");
		guard = cursor.offset;
		hex += cursor.next();
	}
	if (hex.length !== digits) return `${escaped}${hex}`;
	const codePoint = Number.parseInt(hex, 16);
	return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : `${escaped}${hex}`;
}

/** The character a `\u` or `\U` escape `ahead` of the cursor spells, with its text. */
function identifierEscape(cursor: SourceCursor, ahead = 0): { character: string; text: string } | undefined {
	if (cursor.peek(ahead) !== "\\") return undefined;
	const marker = cursor.peek(ahead + 1);
	const digits = marker === "u" ? 4 : marker === "U" ? 8 : 0;
	if (digits === 0) return undefined;
	let hex = "";
	for (let index = 0; index < digits; index++) {
		const digit = cursor.peek(ahead + 2 + index);
		if (!isHexDigit(digit)) return undefined;
		hex += digit;
	}
	const codePoint = Number.parseInt(hex, 16);
	if (codePoint > 0x10ffff) return undefined;
	return { character: String.fromCodePoint(codePoint), text: `\\${marker}${hex}` };
}

/** Whether an identifier starts `ahead` of the cursor, written or escaped. */
export function startsIdentifier(cursor: SourceCursor, ahead = 0): boolean {
	return isIdentifierStart(identifierEscape(cursor, ahead)?.character ?? cursor.peek(ahead));
}

/** An identifier: escapes decoded, formatting characters dropped. Escaped is never a keyword. */
export function readIdentifier(cursor: SourceCursor): { value: string; escaped: boolean } {
	let value = "";
	let escaped = false;
	let first = true;
	let guard = -1;
	for (;;) {
		if (cursor.offset <= guard) throw new Error("identifier reader failed to advance");
		guard = cursor.offset;
		const sequence = identifierEscape(cursor);
		const character = sequence?.character ?? cursor.peek();
		if (character === "" || !(first ? isIdentifierStart(character) : isIdentifierPart(character)))
			return { value, escaped };
		if (sequence === undefined) cursor.next();
		else cursor.take(sequence.text);
		escaped ||= sequence !== undefined;
		first = false;
		if (!isFormatting(character)) value += character;
	}
}
