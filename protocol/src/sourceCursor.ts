// The sole owner of character access for every hand-written parser here, in the positions
// `coordinatesOf` defines. See docs/parsing.md.
//
// Lines break only at `\n`; a lone `\r` is content, as it is to every range core reads. Columns
// count UTF-16 code units, and `peek` and `next` read whole code points.

import type { ParseFailure } from "./parseResult.js";
import type { Position } from "./symbols.js";

////////////////////////////////
//  Constants

/** Characters of context either side of a failure. */
const CONTEXT_RADIUS = 20;

////////////////////////////////
//  Interfaces & Types

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

////////////////////////////////
//  Classes

export class SourceCursor {
	private at: number;
	private lineAt = 0;
	private columnAt = 0;
	private readonly limit: number;

	constructor(
		private readonly source: string,
		startOffset = 0,
		endOffset = source.length,
	) {
		this.limit = Math.min(source.length, Math.max(0, endOffset));
		this.at = 0;
		const start = Math.min(this.limit, Math.max(0, startOffset));
		while (this.at < start) this.next();
	}

	get offset(): number {
		return this.at;
	}

	get line(): number {
		return this.lineAt;
	}

	get column(): number {
		return this.columnAt;
	}

	get position(): Position {
		return { line: this.lineAt, character: this.columnAt };
	}

	good(): boolean {
		return this.at < this.limit;
	}

	/** The code point `ahead` UTF-16 units on; empty past the end. */
	peek(ahead = 0): string {
		const index = this.at + ahead;
		if (index < 0 || index >= this.limit) return "";
		const unit = this.source.charCodeAt(index);
		// Only a high surrogate can start a pair.
		if (unit < 0xd800 || unit > 0xdbff) return this.source[index] as string;
		const point = this.source.codePointAt(index);
		if (point === undefined) return "";
		const character = String.fromCodePoint(point);
		return index + character.length > this.limit ? (this.source[index] as string) : character;
	}

	/** Whether `text` is next. */
	startsWith(text: string): boolean {
		return this.at + text.length <= this.limit && this.source.startsWith(text, this.at);
	}

	next(): string {
		const character = this.peek();
		if (character !== "") this.advance(character);
		return character;
	}

	/** Consumes `text` when it is next; false and unmoved otherwise. */
	take(text: string): boolean {
		if (!this.startsWith(text)) return false;
		let guard = -1;
		const end = this.at + text.length;
		while (this.at < end) {
			if (this.at <= guard) throw new Error("cursor take failed to advance");
			guard = this.at;
			this.next();
		}
		return true;
	}

	mark(): CursorMark {
		return { offset: this.at, line: this.lineAt, column: this.columnAt };
	}

	rewind(mark: CursorMark): void {
		this.at = mark.offset;
		this.lineAt = mark.line;
		this.columnAt = mark.column;
	}

	span(from: CursorMark): CursorSpan {
		return {
			startOffset: from.offset,
			endOffset: this.at,
			start: { line: from.line, character: from.column },
			end: { line: this.lineAt, character: this.columnAt },
		};
	}

	/** The text from `from` to here. */
	textSince(from: CursorMark): string {
		return this.source.slice(from.offset, this.at);
	}

	/** A failure here, the token from `from` bracketed with some text either side. */
	failure(message: string, from: CursorMark = this.mark()): ParseFailure {
		const before = this.source.slice(Math.max(0, from.offset - CONTEXT_RADIUS), from.offset);
		const token = this.source.slice(from.offset, this.at);
		const after = this.source.slice(this.at, Math.min(this.limit, this.at + CONTEXT_RADIUS));
		return {
			message,
			offset: this.at,
			line: this.lineAt + 1,
			column: this.columnAt + 1,
			context: `${before}[${token}]${after}`,
		};
	}

	/** The text of a span already passed, by offsets: a token's, read again after the fact. */
	textOf(start: number, end = this.at): string {
		if (start < 0 || start > end || end > this.at) throw new Error("cursor textOf reads only text already passed");
		return this.source.slice(start, end);
	}

	readWhile(predicate: (character: string) => boolean): string {
		const from = this.at;
		let guard = -1;
		for (let character = this.peek(); character !== "" && predicate(character); character = this.peek()) {
			if (this.at <= guard) throw new Error("cursor readWhile failed to advance");
			guard = this.at;
			this.advance(character);
		}
		return this.source.slice(from, this.at);
	}

	/** Past `character`, the non-empty code point at the cursor. */
	private advance(character: string): void {
		this.at += character.length;
		if (character === "\n") {
			this.lineAt++;
			this.columnAt = 0;
		} else {
			this.columnAt += character.length;
		}
	}
}
