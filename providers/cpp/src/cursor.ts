import type { Position } from "@nyaa-lexicon/protocol";

export interface CursorMark {
	offset: number;
	line: number;
	column: number;
}

export class Cursor {
	private offsetValue: number;
	private lineValue = 0;
	private columnValue = 0;

	constructor(
		private readonly source: string,
		startOffset = 0,
		private readonly endOffset = source.length,
	) {
		this.offsetValue = Math.max(0, Math.min(startOffset, source.length));
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

	get position(): Position {
		return { line: this.lineValue, character: this.columnValue };
	}

	good(): boolean {
		return this.offsetValue < this.endOffset;
	}

	peek(offset = 0): string {
		const position = this.offsetValue + offset;
		if (position < 0 || position >= this.endOffset) return "";
		const codePoint = this.source.codePointAt(position);
		return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
	}

	startsWith(value: string): boolean {
		let index = 0;
		for (const character of value) {
			if (this.peek(index) !== character) return false;
			index += character.length;
		}
		return true;
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

	mark(): CursorMark {
		return { offset: this.offsetValue, line: this.lineValue, column: this.columnValue };
	}

	rewind(mark: CursorMark): void {
		this.offsetValue = mark.offset;
		this.lineValue = mark.line;
		this.columnValue = mark.column;
	}

	readWhile(predicate: (character: string) => boolean): string {
		let value = "";
		while (this.good() && predicate(this.peek())) value += this.next();
		return value;
	}

	skipHorizontalWhitespace(): void {
		let guard = -1;
		while (
			this.good() &&
			(this.peek() === " " || this.peek() === "\t" || this.peek() === "\r" || this.peek() === "\f")
		) {
			if (this.offset <= guard) throw new Error("cursor whitespace scan failed to advance");
			guard = this.offset;
			this.next();
		}
	}
}

export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^[$A-Z_a-z]$/.test(character) || /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^\p{M}$/u.test(character) || /^\p{N}$/u.test(character);
}

export function isIdentifier(value: string): boolean {
	const characters = [...value];
	return (
		characters.length > 0 &&
		isIdentifierStart(characters[0] as string) &&
		characters.slice(1).every((character) => isIdentifierPart(character))
	);
}
