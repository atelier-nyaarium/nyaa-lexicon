import type { Position } from "@nyaa-lexicon/protocol";

export interface CursorMark {
	offset: number;
	line: number;
	column: number;
}

export interface CursorSpan {
	startOffset: number;
	endOffset: number;
	start: Position;
	end: Position;
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

	peek(offset = 0): string {
		const position = this.offsetValue + offset;
		if (position < 0 || position >= Math.min(this.endOffset, this.source.length)) return "";
		const point = this.source.codePointAt(position);
		return point === undefined ? "" : String.fromCodePoint(point);
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
		return this.offsetValue < Math.min(this.endOffset, this.source.length);
	}

	mark(): CursorMark {
		return { offset: this.offsetValue, line: this.lineValue, column: this.columnValue };
	}

	rewind(mark: CursorMark): void {
		this.offsetValue = mark.offset;
		this.lineValue = mark.line;
		this.columnValue = mark.column;
	}

	span(mark: CursorMark): CursorSpan {
		return {
			startOffset: mark.offset,
			endOffset: this.offsetValue,
			start: { line: mark.line, character: mark.column },
			end: { line: this.line, character: this.column },
		};
	}

	readWhile(predicate: (character: string) => boolean): string {
		let value = "";
		let guard = -1;
		while (this.good() && predicate(this.peek())) {
			if (this.offset <= guard) throw new Error("cursor reader failed to advance");
			guard = this.offset;
			value += this.next();
		}
		return value;
	}

	readLine(): { line: number; text: string } | null {
		if (!this.good()) return null;
		const line = this.line;
		let text = "";
		let guard = -1;
		while (this.good() && this.peek() !== "\n") {
			if (this.offset <= guard) throw new Error("line reader failed to advance");
			guard = this.offset;
			text += this.next();
		}
		if (this.peek() === "\n") this.next();
		return { line, text };
	}
}

export function sourceRange(source: string, startOffset: number, endOffset: number): string {
	const cursor = new Cursor(source, startOffset, endOffset);
	let value = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("source range reader failed to advance");
		guard = cursor.offset;
		value += cursor.next();
	}
	return value;
}

export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^\p{M}$/u.test(character) || /^\p{N}$/u.test(character);
}

export function isAsciiDigit(character: string): boolean {
	return character >= "0" && character <= "9";
}
