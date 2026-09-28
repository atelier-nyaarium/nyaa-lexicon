// Owns GDScript's lexical grammar, as Godot 4's tokenizer reads it.

import { type CommentSpan, type CursorMark, type Position, SourceCursor } from "@nyaa-lexicon/protocol";
import {
	isBinaryDigit,
	isBlank,
	isDigit,
	isHexDigit,
	isIdentifierPart,
	isIdentifierStart,
	isQuote,
} from "./characters.js";
import type { ReferenceToken, SourceLine, StringPrefix, StringQuote, StringSpan } from "./parse-model.js";

export type { CommentSpan, StringSpan };

////////////////////////////////
//  Interfaces & Types

export interface Lexed {
	/** Code tokens and line breaks outside strings; comments are not tokens. */
	tokens: ReferenceToken[];
	/** The empty remainder after a final line break is not a line. */
	lines: SourceLine[];
	strings: StringSpan[];
	/** Where each string with no closing quote opens. */
	unterminatedStrings: Position[];
	/** Each escape Godot refuses, at its backslash; it adds nothing to the value. */
	invalidEscapes: Position[];
	comments: CommentSpan[];
}

////////////////////////////////
//  Constants

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** Longest first. */
const OPERATORS = [
	"**=",
	">>=",
	"<<=",
	"...",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"->",
	":=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"**",
	"<<",
	">>",
	"..",
];

const OPERATOR_STARTS = new Set(OPERATORS.map((operator) => operator.charAt(0)));

const ESCAPES: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"'": "'",
	'"': '"',
	"\\": "\\",
};

////////////////////////////////
//  Functions & Helpers

function isSpace(character: string): boolean {
	return isBlank(character) || character === "\r";
}

function isDigitOrUnderscore(character: string): boolean {
	return isDigit(character) || character === "_";
}

////////////////////////////////
//  Lexer

class Lexer {
	private readonly cursor: SourceCursor;
	private readonly tokens: ReferenceToken[] = [];
	private readonly lines: SourceLine[] = [];
	private readonly strings: StringSpan[] = [];
	private readonly unterminatedStrings: Position[] = [];
	private readonly invalidEscapes: Position[] = [];
	private readonly comments: CommentSpan[] = [];
	/** The line being read, until its break. */
	private open: SourceLine | null = null;

	constructor(text: string) {
		this.cursor = new SourceCursor(text);
	}

	run(): Lexed {
		const cursor = this.cursor;
		if (cursor.good()) this.openLine(false);
		if (cursor.peek() === BYTE_ORDER_MARK) cursor.next();
		let guard = -1;
		while (cursor.good()) {
			if (cursor.offset <= guard) throw new Error("GDScript lexer failed to advance");
			guard = cursor.offset;
			this.token();
		}
		// A carriage return ending the file is content.
		if (this.open !== null) this.open.end = cursor.column;
		return {
			tokens: this.tokens,
			lines: this.lines,
			strings: this.strings,
			unterminatedStrings: this.unterminatedStrings,
			invalidEscapes: this.invalidEscapes,
			comments: this.comments,
		};
	}

	private token(): void {
		const cursor = this.cursor;
		const character = cursor.peek();
		if (character === "\n") {
			const at = cursor.mark();
			this.lineBreak(false);
			this.push("newline", "\n", at);
			return;
		}
		if (isSpace(character)) {
			cursor.readWhile(isSpace);
			return;
		}
		if (character === "#") {
			this.comment();
			return;
		}
		const start = cursor.mark();
		if (isDigit(character) || (character === "." && isDigit(cursor.peek(1)))) {
			this.number(start);
			return;
		}
		if (isIdentifierStart(character)) {
			const name = cursor.readWhile(isIdentifierPart);
			if (name === "r" && isQuote(cursor.peek())) this.string("r", start);
			else this.push("identifier", name, start);
			return;
		}
		if (isQuote(character)) {
			this.string("", start);
			return;
		}
		// `&&` and `^=` are operators.
		if ((character === "&" || character === "^") && isQuote(cursor.peek(1))) {
			cursor.next();
			this.string(character, start);
			return;
		}
		const operator = OPERATOR_STARTS.has(character)
			? OPERATORS.find((candidate) => cursor.startsWith(candidate))
			: undefined;
		if (operator !== undefined) cursor.take(operator);
		else cursor.next();
		this.push("symbol", cursor.textSince(start), start);
	}

	private push(kind: ReferenceToken["kind"], value: string, start: CursorMark): void {
		this.tokens.push({ kind, value, line: start.line, character: start.column, offset: start.offset });
	}

	////////////////////////////////
	//  Lines

	private openLine(inString: boolean): void {
		let indent = 0;
		for (let ahead = 0; isBlank(this.cursor.peek(ahead)); ahead++)
			indent += this.cursor.peek(ahead) === "\t" ? 4 : 1;
		this.open = {
			line: this.cursor.line,
			start: this.cursor.offset,
			indent,
			end: 0,
			hasString: inString,
			endsInString: false,
		};
		this.lines.push(this.open);
	}

	/** Consumes the `\n` at the cursor; a carriage return before it ends the line's content. */
	private lineBreak(inString: boolean): void {
		const open = this.open as SourceLine;
		const { column, offset } = this.cursor;
		open.end = column > 0 && this.cursor.textOf(offset - 1) === "\r" ? column - 1 : column;
		open.endsInString = inString;
		this.cursor.next();
		this.open = null;
		if (this.cursor.good()) this.openLine(inString);
	}

	////////////////////////////////
	//  Comments and numbers

	/** To the line's end, a carriage return before the break excluded. */
	private comment(): void {
		const cursor = this.cursor;
		const start = cursor.mark();
		let guard = -1;
		for (let character = cursor.peek(); character !== "" && character !== "\n"; character = cursor.peek()) {
			if (cursor.offset <= guard) throw new Error("GDScript comment failed to advance");
			guard = cursor.offset;
			if (character === "\r" && cursor.peek(1) === "\n") break;
			cursor.next();
		}
		this.comments.push({
			range: { start: { line: start.line, character: start.column }, end: cursor.position },
			text: cursor.textSince(start),
		});
	}

	/** A sign is its own token. */
	private number(start: CursorMark): void {
		const cursor = this.cursor;
		const base = cursor.peek() === "0" ? cursor.peek(1).toLowerCase() : "";
		if (base === "x" || base === "b") {
			cursor.next();
			cursor.next();
			const digit = base === "x" ? isHexDigit : isBinaryDigit;
			cursor.readWhile((character) => digit(character) || character === "_");
		} else {
			cursor.readWhile(isDigitOrUnderscore);
			if (cursor.peek() === "." && cursor.peek(1) !== ".") {
				cursor.next();
				cursor.readWhile(isDigitOrUnderscore);
			}
			const exponent = cursor.peek();
			const sign = cursor.peek(1) === "+" || cursor.peek(1) === "-" ? 1 : 0;
			if ((exponent === "e" || exponent === "E") && isDigit(cursor.peek(1 + sign))) {
				cursor.next();
				if (sign === 1) cursor.next();
				cursor.readWhile(isDigitOrUnderscore);
			}
		}
		this.push("number", cursor.textSince(start), start);
	}

	////////////////////////////////
	//  Strings

	/** Any string may span lines. */
	private string(prefix: StringPrefix, start: CursorMark): void {
		const cursor = this.cursor;
		const quote = cursor.next() as StringQuote;
		const triple = cursor.peek() === quote && cursor.peek(1) === quote;
		if (triple) cursor.take(quote.repeat(2));
		(this.open as SourceLine).hasString = true;
		const closing = triple ? quote.repeat(3) : quote;
		let value = "";
		// A lead surrogate escape awaiting its trail.
		let lead: { at: Position; unit: number } | undefined;
		const dropLead = (): void => {
			if (lead !== undefined) this.invalidEscapes.push(lead.at);
			lead = undefined;
		};
		let guard = -1;
		for (;;) {
			if (cursor.offset <= guard) throw new Error("GDScript string failed to advance");
			guard = cursor.offset;
			const character = cursor.peek();
			if (character === "") {
				this.unterminatedStrings.push({ line: start.line, character: start.column });
				if (this.open !== null) this.open.endsInString = true;
				return;
			}
			if (character === "\\" && prefix !== "r") {
				const at = cursor.position;
				cursor.next();
				const unit = this.escape(at);
				if (unit === null) continue;
				if (unit >= 0xd800 && unit <= 0xdbff) {
					if (lead === undefined) lead = { at, unit };
					else {
						// A second lead drops both.
						this.invalidEscapes.push(at);
						lead = undefined;
					}
				} else if (unit >= 0xdc00 && unit <= 0xdfff) {
					if (lead === undefined) this.invalidEscapes.push(at);
					else value += String.fromCharCode(lead.unit, unit);
					lead = undefined;
				} else {
					dropLead();
					value += String.fromCodePoint(unit);
				}
				continue;
			}
			dropLead();
			if (cursor.take(closing)) break;
			if (character === "\\") {
				cursor.next();
				value += this.rawEscape(quote);
			} else if (character === "\n") {
				this.lineBreak(true);
				value += character;
			} else {
				value += cursor.next();
			}
		}
		const span: StringSpan = {
			start: { line: start.line, character: start.column },
			end: cursor.position,
			prefix,
			quote,
			triple,
			value,
		};
		this.strings.push(span);
		this.tokens.push({
			kind: "string",
			value: cursor.textSince(start),
			line: start.line,
			character: start.column,
			offset: start.offset,
			string: span,
		});
	}

	/** Guards only a quote or backslash. */
	private rawEscape(quote: StringQuote): string {
		const next = this.cursor.peek();
		if (next !== quote && next !== "\\") return "\\";
		this.cursor.next();
		return `\\${next}`;
	}

	/** Past the backslash at `at`: the escaped code point, or null when it adds nothing. */
	private escape(at: Position): number | null {
		const cursor = this.cursor;
		const code = cursor.peek();
		if (code === "\r" && cursor.peek(1) === "\n") cursor.next();
		if (cursor.peek() === "\n") {
			this.lineBreak(true);
			return null;
		}
		if (code === "") return null;
		cursor.next();
		const simple = ESCAPES[code];
		if (simple !== undefined) return simple.charCodeAt(0);
		if (code === "u" || code === "U") {
			const width = code === "u" ? 4 : 6;
			let digits = "";
			let guard = -1;
			while (digits.length < width && isHexDigit(cursor.peek())) {
				if (cursor.offset <= guard) throw new Error("GDScript escape failed to advance");
				guard = cursor.offset;
				digits += cursor.next();
			}
			const point = Number.parseInt(digits, 16);
			if (digits.length === width && point <= 0x10ffff) return point;
		}
		this.invalidEscapes.push(at);
		return null;
	}
}

////////////////////////////////
//  Functions

export function lexGdscript(text: string): Lexed {
	return new Lexer(text).run();
}

/** The double-quoted literal whose value is `value`; `lexGdscript` reads it back. */
export function quoteGdscriptString(value: string): string {
	let quoted = '"';
	for (const character of value) {
		if (character === '"' || character === "\\") quoted += `\\${character}`;
		else if (character === "\n") quoted += "\\n";
		else if (character === "\r") quoted += "\\r";
		else if (character === "\t") quoted += "\\t";
		else if (character.charCodeAt(0) < 0x20)
			quoted += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
		else quoted += character;
	}
	return `${quoted}"`;
}
