// C# character classes, one code point at a time.

/** A letter, a letter number, or `_`. */
export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^[\p{L}\p{Nl}]$/u.test(character);
}

/** Adds digits, connectors, combining marks and formatting characters. */
export function isIdentifierPart(character: string): boolean {
	return /^[\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]$/u.test(character);
}

/** Dropped from an identifier's name. */
export function isFormatting(character: string): boolean {
	return character.charCodeAt(0) > 0x7f && /^\p{Cf}$/u.test(character);
}

export function isHexDigit(character: string): boolean {
	return /^[0-9A-Fa-f]$/u.test(character);
}

export function isDigit(character: string): boolean {
	return /^[0-9]$/u.test(character);
}

/** A space separator, tab, vertical tab or form feed. */
export function isWhitespace(character: string): boolean {
	return (
		character === " " ||
		character === "\t" ||
		character === "\f" ||
		character === "\v" ||
		/^\p{Zs}$/u.test(character)
	);
}

const NEXT_LINE = String.fromCodePoint(0x85);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

/** Ends a line lexically; only `\n` ends one in positions. */
export function isNewline(character: string): boolean {
	return (
		character === "\r" ||
		character === "\n" ||
		character === NEXT_LINE ||
		character === LINE_SEPARATOR ||
		character === PARAGRAPH_SEPARATOR
	);
}
