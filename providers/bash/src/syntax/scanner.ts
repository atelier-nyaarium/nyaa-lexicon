// Character access for the Bash parser: one SourceCursor, and every character it consumes placed as a token.
//
// Bash lexes by context, so there is no token list ahead of the parser. The parser asks for the next
// piece in the mode it stands in, and each read here records the characters it took as tokens.

import { type CursorMark, type NestingGauge, SourceCursor } from "@nyaa-lexicon/protocol";
import type { ParseError, Redirect, Token } from "./ast.js";

////////////////////////////////
//  Interfaces & Types

/** A here-document whose body starts after the next line break. */
export interface PendingHeredoc {
	redirect: Redirect;
	/** Quote-removed; the body ends at a line spelling it. */
	delimiter: string;
	/** `<<-` strips leading tabs from each body line and the delimiter line. */
	strip: boolean;
}

////////////////////////////////
//  Constants

/** Characters that end an unquoted word. */
const METACHARACTERS: ReadonlySet<string> = new Set([" ", "\t", "\n", "|", "&", ";", "(", ")", "<", ">", ""]);

////////////////////////////////
//  Functions & Helpers

export function isBlank(character: string): boolean {
	return character === " " || character === "\t";
}

export function isMeta(character: string): boolean {
	return METACHARACTERS.has(character);
}

export function isNameStart(character: string): boolean {
	return character === "_" || (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

export function isNameCharacter(character: string): boolean {
	return isNameStart(character) || isDigit(character);
}

export function isDigit(character: string): boolean {
	return character >= "0" && character <= "9";
}

////////////////////////////////
//  Classes

export class Scanner {
	readonly cursor: SourceCursor;
	readonly errors: ParseError[] = [];
	/** Here-documents opened on the current line, read at its end. */
	readonly heredocs: PendingHeredoc[] = [];
	private readonly placed: Token[] = [];
	private run: Token | null = null;
	/** While above zero, consumed characters place no token. */
	private quiet = 0;

	/** The text's length in UTF-16 units. */
	readonly size: number;

	constructor(
		text: string,
		private readonly gauge: NestingGauge,
	) {
		this.cursor = new SourceCursor(text);
		this.size = text.length;
	}

	/** The text of a span already read, to the cursor unless `end` says otherwise. */
	textOf(start: number, end = this.offset): string {
		return this.cursor.textOf(start, end);
	}

	/** A read that may hold itself, counted against the shared nesting limit. */
	nested<T>(read: () => T): T {
		this.gauge.open();
		try {
			return read();
		} finally {
			this.gauge.close();
		}
	}

	/**
	 * A chain built in a loop, each link a level deeper in the tree, counted against the same limit
	 * while it grows. `link` builds one and says so, or returns false to end the chain.
	 */
	chain(link: () => boolean): void {
		let links = 0;
		try {
			let guard = -1;
			while (link()) {
				if (this.offset <= guard) throw new Error("bash chain read failed to advance");
				guard = this.offset;
				this.gauge.open();
				links++;
			}
		} finally {
			for (; links > 0; links--) this.gauge.close();
		}
	}

	get offset(): number {
		return this.cursor.offset;
	}

	get done(): boolean {
		return !this.cursor.good();
	}

	peek(ahead = 0): string {
		return this.cursor.peek(ahead);
	}

	/** Whether `text` is next, as bash reads it: a backslash and line break between its characters vanish. */
	startsWith(text: string): boolean {
		return this.past(text) !== undefined;
	}

	/** The character after `text`, with line continuations passed over; empty when `text` is not next. */
	peekAfter(text: string): string {
		const at = this.past(text);
		return at === undefined ? "" : this.cursor.peek(this.pastContinuations(at));
	}

	/** Consumes one character as code. */
	code(): string {
		return this.take("code");
	}

	/** Consumes `text` as code when it is next, with any line continuations inside it. */
	codeText(text: string): boolean {
		if (!this.startsWith(text)) return false;
		for (let index = 0; index < text.length; index++) {
			if (index > 0 && this.atContinuation()) this.continuation();
			this.code();
		}
		return true;
	}

	/** UTF-16 units from the cursor past `text` read through line continuations. */
	private past(text: string): number | undefined {
		let at = 0;
		for (let index = 0; index < text.length; index++) {
			if (index > 0) at = this.pastContinuations(at);
			if (this.cursor.peek(at) !== text[index]) return undefined;
			at++;
		}
		return at;
	}

	private pastContinuations(at: number): number {
		let past = at;
		while (this.cursor.peek(past) === "\\" && this.cursor.peek(past + 1) === "\n") past += 2;
		return past;
	}

	/** Consumes one character as `kind`. */
	take(kind: Token["kind"]): string {
		const start = this.cursor.mark();
		const character = this.cursor.next();
		if (this.quiet === 0 && character !== "") this.place(kind, start, this.cursor.offset);
		return character;
	}

	/** Consumes characters as `kind` while `accepts` holds. */
	takeWhile(kind: Token["kind"], accepts: (character: string) => boolean): string {
		const start = this.cursor.mark();
		const text = this.cursor.readWhile(accepts);
		if (this.quiet === 0) this.place(kind, start, this.cursor.offset);
		return text;
	}

	codeWhile(accepts: (character: string) => boolean): string {
		return this.takeWhile("code", accepts);
	}

	/** Consumes as `kind` up to `end`, which lies ahead within the text. */
	takeTo(kind: Token["kind"], end: number): void {
		this.takeWhile(kind, () => this.cursor.offset < end);
	}

	/** Consumes one character as blank space. */
	skip(): string {
		return this.cursor.next();
	}

	/** A backslash before a line break, which bash removes before reading. */
	atContinuation(): boolean {
		return this.peek() === "\\" && this.peek(1) === "\n";
	}

	continuation(): void {
		this.take("continuation");
		this.take("continuation");
	}

	/** Blanks and continuations between tokens. */
	skipBlanks(): void {
		let guard = -1;
		for (;;) {
			if (this.offset <= guard) throw new Error("bash blank scan failed to advance");
			guard = this.offset;
			if (isBlank(this.peek())) this.skip();
			else if (this.atContinuation()) this.continuation();
			else return;
		}
	}

	/** Blanks, continuations and a comment to the line's end; the line break stays. */
	skipSpace(): void {
		this.skipBlanks();
		if (this.peek() === "#") this.takeWhile("comment", (character) => character !== "\n");
	}

	/** Places a token read out of band, such as a decoded backquote's. */
	placeToken(token: Token): void {
		if (this.quiet > 0) return;
		this.flush();
		this.placed.push(token);
	}

	/** Consumed characters place no token until the matching `loud`. */
	hush(): void {
		this.flush();
		this.quiet++;
	}

	loud(): void {
		this.quiet--;
	}

	error(message: string, pos = this.offset): void {
		this.errors.push({ message, pos });
	}

	tokens(): Token[] {
		this.flush();
		return this.placed;
	}

	private place(kind: Token["kind"], start: CursorMark, end: number): void {
		if (end <= start.offset) return;
		if (this.run !== null && this.run.kind === kind && this.run.end === start.offset) {
			this.run.end = end;
			return;
		}
		this.flush();
		this.run = { kind, pos: start.offset, end, line: start.line, column: start.column };
	}

	private flush(): void {
		if (this.run === null) return;
		this.placed.push(this.run);
		this.run = null;
	}
}
