// Owns GDScript character classes.

////////////////////////////////
//  Functions & Helpers

function isAsciiLetter(character: string): boolean {
	return (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

export function isDigit(character: string): boolean {
	return character >= "0" && character <= "9";
}

export function isHexDigit(character: string): boolean {
	return isDigit(character) || (character >= "a" && character <= "f") || (character >= "A" && character <= "F");
}

export function isBinaryDigit(character: string): boolean {
	return character === "0" || character === "1";
}

/** Space or tab. */
export function isBlank(character: string): boolean {
	return character === " " || character === "\t";
}

export function isQuote(character: string): character is "'" | '"' {
	return character === "'" || character === '"';
}

export function isIdentifierStart(character: string): boolean {
	if (character === "_" || isAsciiLetter(character)) return true;
	return character.charCodeAt(0) > 0x7f && /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	if (isIdentifierStart(character) || isDigit(character)) return true;
	return character.charCodeAt(0) > 0x7f && /^[\p{M}\p{N}]$/u.test(character);
}

export function isGdscriptIdentifier(name: string): boolean {
	const characters = [...name];
	return (
		characters.length > 0 &&
		isIdentifierStart(characters[0] as string) &&
		characters.slice(1).every(isIdentifierPart)
	);
}
