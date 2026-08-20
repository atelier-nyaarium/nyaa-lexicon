// Owns source masking, line construction, and comment spans.

import type { CommentSpan, Position } from "@nyaa-lexicon/protocol";
import { Cursor } from "./cursor.js";
import type { SourceLine } from "./parse-model.js";

//////// Source scan

// Derived rather than restated, so the wire shape cannot drift from this provider's.
export type { CommentSpan };

type TripleQuote = "'" | '"';

interface ActiveString {
	quote: TripleQuote;
	triple: boolean;
	start: Position;
}

interface StringState {
	active: ActiveString | null;
	unterminated: Position[];
}

interface MaskedLine {
	code: string;
	hasString: boolean;
	stringStarts: number[];
	endsInString: boolean;
}

export interface ScannedSource {
	lines: SourceLine[];
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

function tripleQuoteAt(cursor: Cursor, quote: TripleQuote): boolean {
	return cursor.peek() === quote && cursor.peek(1) === quote && cursor.peek(2) === quote;
}

function consumeMasked(cursor: Cursor, count: number): string {
	let result = "";
	for (let index = 0; index < count && cursor.good(); index++) result += masked(cursor.next());
	return result;
}

function maskStringContent(cursor: Cursor, state: StringState): string {
	const active = state.active as ActiveString;
	let code = "";
	while (cursor.good()) {
		if (active.triple && tripleQuoteAt(cursor, active.quote)) {
			code += consumeMasked(cursor, 3);
			state.active = null;
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
			state.active = null;
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
	const stringStarts: number[] = [];
	while (cursor.good()) {
		const before = cursor.offset;
		if (state.active !== null) {
			code += maskStringContent(cursor, state);
		} else if (cursor.peek() === "#") {
			const character = cursor.column;
			let raw = "";
			while (cursor.good()) {
				const consumed = cursor.next();
				raw += consumed;
				code += masked(consumed);
			}
			comments.push(commentSpan(line, character, raw));
		} else if (cursor.peek() === "'" || cursor.peek() === '"') {
			const quote = cursor.peek() as TripleQuote;
			const triple = tripleQuoteAt(cursor, quote);
			hasString = true;
			stringStarts.push(cursor.column);
			state.active = { quote, triple, start: { line, character: cursor.column } };
			code += consumeMasked(cursor, triple ? 3 : 1);
			code += maskStringContent(cursor, state);
		} else {
			code += cursor.next();
		}
		if (cursor.offset <= before) throw new Error("maskLine failed to advance");
	}
	return { code, hasString, stringStarts, endsInString: state.active !== null };
}

export function scanSource(text: string): ScannedSource {
	const cursor = new Cursor(text);
	const lines: SourceLine[] = [];
	const state: StringState = { active: null, unterminated: [] };
	const comments: CommentSpan[] = [];
	let line = cursor.readLine();
	while (line !== null) {
		lines.push({ ...line, ...maskLine(line.text, line.line, state, comments) });
		line = cursor.readLine();
	}
	if (state.active !== null) state.unterminated.push(state.active.start);
	return { lines, unterminatedStrings: state.unterminated, comments };
}

export function readLines(text: string): SourceLine[] {
	return scanSource(text).lines;
}

/** GDScript has one comment form: `#` to end of line, and no block comment. */
export function extractCommentsCore(text: string): CommentSpan[] {
	return scanSource(text).comments;
}
