export interface CursorMark {
	offset: number;
	line: number;
	column: number;
}

export class Cursor {
	private offsetValue: number;
	private lineValue = 0;
	private columnValue = 0;
	private readonly endOffsetValue: number;
	private crlfPending = false;

	constructor(
		private readonly source: string,
		startOffset = 0,
		endOffset = source.length,
	) {
		this.offsetValue = Math.max(0, startOffset);
		this.endOffsetValue = Math.min(source.length, Math.max(this.offsetValue, endOffset));
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

	good(): boolean {
		return this.offsetValue < this.endOffsetValue;
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
		if (character === "\r") {
			this.lineValue++;
			this.columnValue = 0;
			this.crlfPending = this.peek() === "\n";
		} else if (character === "\n") {
			if (this.crlfPending) {
				this.crlfPending = false;
				this.columnValue = 0;
			} else {
				this.lineValue++;
				this.columnValue = 0;
			}
		} else {
			this.crlfPending = false;
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
		this.crlfPending = false;
	}

	textBetween(start: number, end: number): string {
		return this.source.slice(start, end);
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
}

export function isIdentifierStart(character: string): boolean {
	return character === "_" || /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^[\p{M}\p{N}]$/u.test(character);
}

export function isHexDigit(character: string): boolean {
	return /^[0-9A-Fa-f]$/u.test(character);
}

export function isDigit(character: string): boolean {
	return /^[0-9]$/u.test(character);
}

export function isWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\f" || character === "\v";
}
