// The SOLE owner of character access for every hand-written parser here. See docs/parsing.md.
//
// Nothing above this indexes text directly. A structural search that bypasses the cursor is the
// defect the law exists to prevent, and there is nowhere to write one once reads go through here.

////////////////////////////////
//  Interfaces & Types

export interface ParseFailure {
	message: string;
	offset: number;
	line: number;
	column: number;
	/** The span around the failure, with the offending token bracketed. */
	context: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; failure: ParseFailure };

////////////////////////////////
//  Constants

const CONTEXT_RADIUS = 20;

////////////////////////////////
//  Class

export class Cursor {
	private readonly buffer: string;
	private pos = 0;
	private ln = 1;
	private col = 1;
	private tokenStart = 0;
	private markLine = 1;
	private markColumn = 1;

	constructor(text = "") {
		this.buffer = text;
	}

	////////////////////////////////
	//  Reading

	/** Empty string past the end, so callers compare rather than bounds-check. */
	peek(offset = 0): string {
		return this.buffer[this.pos + offset] ?? "";
	}

	next(): string {
		const ch = this.buffer[this.pos];
		if (ch === undefined) return "";
		this.pos += 1;
		if (ch === "\n") {
			this.ln += 1;
			this.col = 1;
		} else {
			this.col += 1;
		}
		return ch;
	}

	good(): boolean {
		return this.pos < this.buffer.length;
	}

	takeWhile(predicate: (ch: string) => boolean): string {
		let out = "";
		while (this.good() && predicate(this.peek())) out += this.next();
		return out;
	}

	////////////////////////////////
	//  Position and failure

	get offset(): number {
		return this.pos;
	}

	get line(): number {
		return this.ln;
	}

	get column(): number {
		return this.col;
	}

	/** Marks where the current token began, so a failure can point at the whole token. */
	mark(): void {
		this.tokenStart = this.pos;
		this.markLine = this.ln;
		this.markColumn = this.col;
	}

	/** Rewind to the last mark, line and column included, or positions drift by what was re-read. */
	resetToMark(): void {
		this.pos = this.tokenStart;
		this.ln = this.markLine;
		this.col = this.markColumn;
	}

	fail(message: string): ParseFailure {
		const from = Math.max(0, this.tokenStart - CONTEXT_RADIUS);
		const to = Math.min(this.buffer.length, this.pos + CONTEXT_RADIUS);
		const before = this.buffer.slice(from, this.tokenStart);
		const token = this.buffer.slice(this.tokenStart, this.pos);
		const after = this.buffer.slice(this.pos, to);
		return {
			message,
			offset: this.offset,
			line: this.ln,
			column: this.col,
			context: `${before}[${token}]${after}`,
		};
	}
}

////////////////////////////////
//  Functions & Helpers

export function ok<T>(value: T): ParseResult<T> {
	return { ok: true, value };
}

export function err<T>(failure: ParseFailure): ParseResult<T> {
	return { ok: false, failure };
}

/** One-line rendering for a log or an error message. */
export function formatFailure(failure: ParseFailure): string {
	return `${failure.message} at ${failure.line}:${failure.column} (offset ${failure.offset}): ${failure.context}`;
}

/**
 * A digit run as a number, or null when the text and the number would disagree.
 *
 * Past 2^53 two distinct digit runs collapse onto one value, and a leading zero gives one value two
 * spellings. Either way an id or a version stops being its own name. One owner, because the same
 * check written twice already drifted once.
 */
export function safeDigits(text: string): number | null {
	if (!/^\d+$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) && String(value) === text ? value : null;
}
