// Owns character cursor access and identifier primitives.

import type { RawLine, Token } from "./parse-model.js";

//////// Cursor

export class Cursor {
	private offsetValue = 0;
	private lineValue = 0;
	private columnValue = 0;
	private readonly endOffsetValue: number;

	constructor(
		private readonly source: string,
		startOffset = 0,
		endOffset = source.length,
	) {
		this.offsetValue = startOffset;
		this.endOffsetValue = Math.min(endOffset, source.length);
	}

	get offset(): number {
		return this.offsetValue;
	}

	get line(): number {
		return this.lineValue;
	}

	get column(): number {
		return this.columnValue;
	}

	peek(offset = 0): string {
		const position = this.offsetValue + offset;
		if (position < 0 || position >= this.endOffsetValue) return "";
		const codePoint = this.source.codePointAt(position);
		return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
	}

	next(): string {
		const character = this.peek();
		if (character === "") return "";
		this.offsetValue += character.length;
		if (character === "\n") {
			this.lineValue++;
			this.columnValue = 0;
		} else {
			this.columnValue += character.length;
		}
		return character;
	}

	good(): boolean {
		return this.offsetValue < this.endOffsetValue;
	}

	readLine(): RawLine | null {
		if (!this.good()) return null;
		const line = this.line;
		let text = "";
		while (this.good() && this.peek() !== "\n") text += this.next();
		if (this.peek() === "\n") this.next();
		return { line, text };
	}

	skipWhitespace(): void {
		while (this.peek() === " " || this.peek() === "\t" || this.peek() === "\r") this.next();
	}

	readIdentifier(): Token | null {
		const start = this.offset;
		if (!isIdentifierStart(this.peek())) return null;
		let name = this.next();
		while (isIdentifierPart(this.peek())) name += this.next();
		return { name, start };
	}
}

export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^[\p{M}\p{N}]$/u.test(character);
}

export function isGdscriptIdentifier(name: string): boolean {
	const characters = [...name];
	return (
		characters.length > 0 &&
		isIdentifierStart(characters[0] as string) &&
		characters.slice(1).every(isIdentifierPart)
	);
}
