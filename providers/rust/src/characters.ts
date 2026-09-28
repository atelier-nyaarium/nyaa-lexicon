// Rust's character classes, as the Reference's lexical structure defines them.

////////////////////////////////
//  Constants

/** Pattern_White_Space. */
const WHITESPACE: ReadonlySet<string> = new Set(
	[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0x200e, 0x200f, 0x2028, 0x2029].map((point) =>
		String.fromCodePoint(point),
	),
);

export const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

////////////////////////////////
//  Functions & Helpers

export function isWhitespace(character: string): boolean {
	return WHITESPACE.has(character);
}

export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^\p{XID_Start}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return /^\p{XID_Continue}$/u.test(character);
}

export function isAsciiDigit(character: string): boolean {
	return character >= "0" && character <= "9";
}

export function isHexDigit(character: string): boolean {
	return isAsciiDigit(character) || (character >= "a" && character <= "f") || (character >= "A" && character <= "F");
}

export function isUppercase(character: string): boolean {
	return /^\p{Uppercase}$/u.test(character);
}
