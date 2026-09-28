// Character classes the C++ tokenizer reads by.

////////////////////////////////
//  Functions & Helpers

export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^[$A-Z_a-z]$/.test(character) || /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^\p{M}$/u.test(character) || /^\p{N}$/u.test(character);
}

export function isDigit(character: string): boolean {
	return /^[0-9]$/.test(character);
}

/** A pp-number's characters past its first; an exponent's sign is read with its letter. */
export function isNumberPart(character: string): boolean {
	return /^[A-Za-z0-9_'.]$/.test(character);
}

/** An exponent letter, after which a sign stays in the number. */
export function isExponent(character: string): boolean {
	return character === "e" || character === "E" || character === "p" || character === "P";
}

export function isSign(character: string): boolean {
	return character === "+" || character === "-";
}

export function isHorizontalSpace(character: string): boolean {
	return character === " " || character === "\t" || character === "\r" || character === "\f";
}
