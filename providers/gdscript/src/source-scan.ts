// Owns source masking and line construction.

import type { Position } from "@nyaa-lexicon/protocol";
import { Cursor } from "./cursor.js";
import type { SourceLine } from "./parse-model.js";

//////// Source scan

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
}

function masked(character: string): string {
	return " ".repeat(character.length);
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

function maskLine(text: string, line: number, state: StringState): MaskedLine {
	const cursor = new Cursor(text);
	let code = "";
	let hasString = state.active !== null;
	const stringStarts: number[] = [];
	while (cursor.good()) {
		const before = cursor.offset;
		if (state.active !== null) {
			code += maskStringContent(cursor, state);
		} else if (cursor.peek() === "#") {
			while (cursor.good()) code += masked(cursor.next());
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
	let line = cursor.readLine();
	while (line !== null) {
		lines.push({ ...line, ...maskLine(line.text, line.line, state) });
		line = cursor.readLine();
	}
	if (state.active !== null) state.unterminated.push(state.active.start);
	return { lines, unterminatedStrings: state.unterminated };
}

export function readLines(text: string): SourceLine[] {
	return scanSource(text).lines;
}
