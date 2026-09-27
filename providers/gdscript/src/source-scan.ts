// Owns source masking, line construction, and comment spans.

import type { CommentSpan, Position } from "@nyaa-lexicon/protocol";
import { Cursor, isIdentifierStart } from "./cursor.js";
import type { SourceLine, StringPrefix, StringQuote, StringSpan } from "./parse-model.js";

//////// Source scan

// Derived rather than restated, so the wire shape cannot drift from this provider's.
export type { CommentSpan, StringSpan };

interface ActiveString {
	prefix: StringPrefix;
	quote: StringQuote;
	triple: boolean;
	start: Position;
}

interface StringState {
	active: ActiveString | null;
	strings: StringSpan[];
	unterminated: Position[];
}

interface MaskedLine {
	code: string;
	hasString: boolean;
	endsInString: boolean;
}

export interface ScannedSource {
	lines: SourceLine[];
	strings: StringSpan[];
	unterminatedStrings: Position[];
	comments: CommentSpan[];
}

function masked(character: string): string {
	return " ".repeat(character.length);
}

// A trailing carriage return terminates the line, so it is not comment text.
function commentSpan(line: number, character: number, raw: string): CommentSpan {
	const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
	return {
		range: { start: { line, character }, end: { line, character: character + text.length } },
		text,
	};
}

function tripleQuoteAt(cursor: Cursor, quote: StringQuote): boolean {
	return cursor.peek() === quote && cursor.peek(1) === quote && cursor.peek(2) === quote;
}

function isQuote(character: string): character is StringQuote {
	return character === "'" || character === '"';
}

function consumeMasked(cursor: Cursor, count: number): string {
	let result = "";
	for (let index = 0; index < count && cursor.good(); index++) result += masked(cursor.next());
	return result;
}

function maskStringContent(cursor: Cursor, line: number, state: StringState): string {
	const active = state.active as ActiveString;
	const close = () => {
		state.strings.push({ ...active, end: { line, character: cursor.column } });
		state.active = null;
	};
	let code = "";
	while (cursor.good()) {
		if (active.triple && tripleQuoteAt(cursor, active.quote)) {
			code += consumeMasked(cursor, 3);
			close();
			return code;
		}
		const character = cursor.next();
		code += masked(character);
		if (character === "\\") {
			if (!cursor.good()) return code;
			if (cursor.peek() === "\r" && cursor.peek(1) === "") {
				code += masked(cursor.next());
				return code;
			}
			code += masked(cursor.next());
			continue;
		}
		if (!active.triple && character === active.quote) {
			close();
			return code;
		}
	}
	if (!active.triple) {
		state.unterminated.push(active.start);
		state.active = null;
	}
	return code;
}

function maskLine(text: string, line: number, state: StringState, comments: CommentSpan[]): MaskedLine {
	const cursor = new Cursor(text);
	let code = "";
	let hasString = state.active !== null;
	const open = (prefix: StringPrefix, start: number): void => {
		const quote = cursor.peek() as StringQuote;
		const triple = tripleQuoteAt(cursor, quote);
		hasString = true;
		state.active = { prefix, quote, triple, start: { line, character: start } };
		code += consumeMasked(cursor, triple ? 3 : 1);
		code += maskStringContent(cursor, line, state);
	};
	while (cursor.good()) {
		const before = cursor.offset;
		const character = cursor.peek();
		if (state.active !== null) {
			code += maskStringContent(cursor, line, state);
		} else if (character === "#") {
			const column = cursor.column;
			let raw = "";
			while (cursor.good()) {
				const consumed = cursor.next();
				raw += consumed;
				code += masked(consumed);
			}
			comments.push(commentSpan(line, column, raw));
		} else if (isQuote(character)) {
			open("", cursor.column);
		} else if (character === "&" && cursor.peek(1) === "&") {
			code += cursor.next() + cursor.next();
		} else if ((character === "&" || character === "^") && isQuote(cursor.peek(1))) {
			const start = cursor.column;
			code += masked(cursor.next());
			open(character, start);
		} else if (isIdentifierStart(character)) {
			// Raw `r` starts a word.
			const start = cursor.column;
			const word = cursor.readIdentifier()?.name ?? "";
			if (word === "r" && isQuote(cursor.peek())) {
				code += masked(word);
				open("r", start);
			} else {
				code += word;
			}
		} else {
			code += cursor.next();
		}
		if (cursor.offset <= before) throw new Error("maskLine failed to advance");
	}
	return { code, hasString, endsInString: state.active !== null };
}

function indentWidth(text: string): number {
	const cursor = new Cursor(text);
	let width = 0;
	while (cursor.peek() === " " || cursor.peek() === "\t") {
		width += cursor.next() === "\t" ? 4 : 1;
	}
	return width;
}

export function scanSource(text: string): ScannedSource {
	const cursor = new Cursor(text);
	const lines: SourceLine[] = [];
	const state: StringState = { active: null, strings: [], unterminated: [] };
	const comments: CommentSpan[] = [];
	let line = cursor.readLine();
	while (line !== null) {
		const end = line.text.endsWith("\r") ? line.text.length - 1 : line.text.length;
		lines.push({
			...line,
			...maskLine(line.text, line.line, state, comments),
			indent: indentWidth(line.text),
			end,
		});
		line = cursor.readLine();
	}
	if (state.active !== null) state.unterminated.push(state.active.start);
	return { lines, strings: state.strings, unterminatedStrings: state.unterminated, comments };
}
