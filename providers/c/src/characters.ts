// Character classes the C lexer reads through the cursor.

////////////////////////////////
//  Functions & Helpers

export function isIdentifierStart(character: string): boolean {
	return character === "_" || character === "$" || /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^[\p{M}\p{N}]$/u.test(character);
}

export function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\r" || character === "\f" || character === "\v";
}

export function isDigit(character: string): boolean {
	return /^[0-9]$/u.test(character);
}

export function isHexDigit(character: string): boolean {
	return /^[0-9A-Fa-f]$/u.test(character);
}

export function isOctalDigit(character: string): boolean {
	return /^[0-7]$/u.test(character);
}

/** Characters a number token holds besides exponent signs. */
export function isNumberPart(character: string): boolean {
	return /^[A-Za-z0-9_.]$/u.test(character);
}
