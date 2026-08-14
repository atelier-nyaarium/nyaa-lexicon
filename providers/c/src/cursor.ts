export interface CursorMark {
	offset: number;
	line: number;
	column: number;
}

export class Cursor {
	private offsetValue: number;
	private lineValue: number;
	private columnValue: number;
	private limitValue: number;

	constructor(
		private readonly source: string,
		startOffset = 0,
		endOffset = source.length,
	) {
		this.offsetValue = startOffset;
		this.lineValue = 0;
		this.columnValue = 0;
		this.limitValue = endOffset;
		for (let offset = 0; offset < startOffset; ) {
			const character = this.source.codePointAt(offset);
			if (character === undefined) break;
			const value = String.fromCodePoint(character);
			offset += value.length;
			if (value === "\n") {
				this.lineValue++;
				this.columnValue = 0;
			} else {
				this.columnValue += value.length;
			}
		}
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
		return this.offsetValue < this.limitValue;
	}

	peek(lookahead = 0): string {
		let offset = this.offsetValue;
		for (let index = 0; index < lookahead; index++) {
			const codePoint = this.source.codePointAt(offset);
			if (codePoint === undefined) return "";
			offset += String.fromCodePoint(codePoint).length;
		}
		if (offset >= this.limitValue) return "";
		const codePoint = this.source.codePointAt(offset);
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

	mark(): CursorMark {
		return { offset: this.offset, line: this.line, column: this.column };
	}

	rewind(mark: CursorMark): void {
		this.offsetValue = mark.offset;
		this.lineValue = mark.line;
		this.columnValue = mark.column;
	}

	withLimit<T>(endOffset: number, callback: () => T): T {
		const previousLimit = this.limitValue;
		this.limitValue = Math.min(previousLimit, endOffset);
		try {
			return callback();
		} finally {
			this.limitValue = previousLimit;
		}
	}

	takeWhile(predicate: (character: string) => boolean): string {
		let value = "";
		while (this.good() && predicate(this.peek())) value += this.next();
		return value;
	}

	slice(start: number, end = this.offset): string {
		return this.source.slice(start, end);
	}

	readIdentifier(): { name: string; start: CursorMark; end: CursorMark } | null {
		if (!isIdentifierStart(this.peek())) return null;
		const start = this.mark();
		let name = this.next();
		while (isIdentifierPart(this.peek())) name += this.next();
		return { name, start, end: this.mark() };
	}
}

export function isIdentifierStart(character: string): boolean {
	return character === "_" || character === "$" || /^\p{L}$/u.test(character);
}

export function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^[\p{M}\p{N}]$/u.test(character);
}

export function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\r" || character === "\f" || character === "\v";
}
