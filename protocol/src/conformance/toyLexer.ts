// Shared lexer for the reference provider and toy-language test doubles. It emits words, strings,
// comments and single punctuation tokens for sequence matching.
// Readers use these tokens so markers and declarations inside strings are not code or comments.

import { Cursor } from "../cursor.js";

////////////////////////////////
//  Interfaces & Types

/** One token, as UTF-16 offsets, end exclusive, with its own text. */
export interface ToyToken {
	kind: "word" | "string" | "comment" | "punct";
	start: number;
	end: number;
	text: string;
}

////////////////////////////////
//  Constants

const QUOTES = new Set(['"', "'", "`"]);

////////////////////////////////
//  Functions & Helpers

function isWordStart(char: string): boolean {
	return /^[A-Za-z_$]$/.test(char);
}

function isWordPart(char: string): boolean {
	return /^[\w$]$/.test(char);
}

/** The remaining text of a string opened by `quote`, including its closing quote if present. */
function readString(cursor: Cursor, quote: string): string {
	let out = cursor.next();
	while (cursor.good() && cursor.peek() !== quote) {
		const char = cursor.next();
		out += char === "\\" ? char + cursor.next() : char;
	}
	return out + cursor.next();
}

/** Through line end. CRLF ends the line; a lone CR is comment text. */
function readLineComment(cursor: Cursor): string {
	let out = "";
	while (cursor.good() && cursor.peek() !== "\n" && !(cursor.peek() === "\r" && cursor.peek(1) === "\n")) {
		out += cursor.next();
	}
	return out;
}

/** Through the closing marker; unterminated comments consume the rest of the file. */
function readBlockComment(cursor: Cursor): string {
	let out = cursor.next() + cursor.next();
	while (cursor.good() && !(cursor.peek() === "*" && cursor.peek(1) === "/")) out += cursor.next();
	return out + cursor.next() + cursor.next();
}

/** Blocks do not nest, matching the C family the toy grammar borrows from. */
export function toyTokens(text: string): ToyToken[] {
	const cursor = new Cursor(text);
	const tokens: ToyToken[] = [];
	const push = (kind: ToyToken["kind"], start: number, read: string) =>
		tokens.push({ kind, start, end: cursor.offset, text: read });
	while (cursor.good()) {
		const start = cursor.offset;
		const char = cursor.peek();
		if (char.trim() === "") cursor.next();
		else if (QUOTES.has(char)) push("string", start, readString(cursor, char));
		else if (char === "/" && cursor.peek(1) === "/") push("comment", start, readLineComment(cursor));
		else if (char === "/" && cursor.peek(1) === "*") push("comment", start, readBlockComment(cursor));
		else if (isWordStart(char)) push("word", start, cursor.takeWhile(isWordPart));
		else push("punct", start, cursor.next());
	}
	return tokens;
}

/** Whether a token is of `kind`, and spelled `word` when one is given. */
export function toySpelled(token: ToyToken | undefined, kind: ToyToken["kind"], word?: string): boolean {
	return token?.kind === kind && (word === undefined || token.text === word);
}

/** A string token's contents between its quotes. */
export function toyStringValue(token: ToyToken): string {
	return token.text.slice(1, -1);
}
