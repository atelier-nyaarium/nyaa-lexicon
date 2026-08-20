import type { Diagnostic, Position, Range } from "@nyaa-lexicon/protocol";
import { Cursor, isIdentifierPart, isIdentifierStart } from "./cursor.js";

export type TokenKind = "identifier" | "number" | "string" | "character" | "comment" | "newline" | "punctuation";

export interface Token {
	kind: TokenKind;
	text: string;
	value: string;
	start: Position;
	end: Position;
	startOffset: number;
	endOffset: number;
}

export interface TokenizedSource {
	tokens: Token[];
	diagnostics: Diagnostic[];
}

const OPERATORS = [
	">>>=",
	"<=>",
	"...",
	"->*",
	"<<=",
	">>=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"<<",
	">>",
	"->",
	"::",
	".*",
	"##",
];

const STRING_PREFIXES = ["u8R", "u8", "uR", "UR", "LR", "R", "u", "U", "L"];

function pointRange(start: Position, end: Position): Range {
	return { start, end };
}

function tokenFrom(
	kind: TokenKind,
	text: string,
	value: string,
	start: Position,
	end: Position,
	startOffset: number,
	endOffset: number,
): Token {
	return { kind, text, value, start, end, startOffset, endOffset };
}

function diagnostic(message: string, start: Position, end: Position): Diagnostic {
	return { severity: "error", message, range: pointRange(start, end) };
}

function isDigit(character: string): boolean {
	return /^[0-9]$/.test(character);
}

function isNumberPart(character: string): boolean {
	return /^[A-Za-z0-9_'.]$/.test(character);
}

function prefixAt(cursor: Cursor): string | null {
	for (const prefix of STRING_PREFIXES) {
		if (cursor.startsWith(prefix) && cursor.peek(prefix.length) === '"') return prefix;
		if (cursor.startsWith(prefix) && cursor.peek(prefix.length) === "'") return prefix;
	}
	return null;
}

function decodeString(value: string): string {
	let decoded = "";
	let escaped = false;
	for (const character of value) {
		if (!escaped) {
			if (character === "\\") {
				escaped = true;
			} else {
				decoded += character;
			}
			continue;
		}
		const replacements: Record<string, string> = {
			"0": "\0",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "\t",
			v: "\v",
			"\\": "\\",
			'"': '"',
			"'": "'",
		};
		decoded += replacements[character] ?? character;
		escaped = false;
	}
	if (escaped) decoded += "\\";
	return decoded;
}

/** A CRLF carriage return ends the line, so it is not comment text. */
function endsLine(cursor: Cursor): boolean {
	return cursor.peek() === "\n" || (cursor.peek() === "\r" && cursor.peek(1) === "\n");
}

/** Backslash-newline continues a line comment onto the next line. */
function continuesLine(cursor: Cursor): boolean {
	if (cursor.peek() !== "\\") return false;
	return cursor.peek(1) === "\n" || (cursor.peek(1) === "\r" && cursor.peek(2) === "\n");
}

function readLineComment(cursor: Cursor): string {
	let value = cursor.next();
	value += cursor.next();
	while (cursor.good() && !endsLine(cursor)) {
		if (continuesLine(cursor)) {
			value += cursor.next();
			if (cursor.peek() === "\r") value += cursor.next();
		}
		value += cursor.next();
	}
	return value;
}

function readBlockComment(cursor: Cursor): { value: string; closed: boolean } {
	let value = cursor.next();
	value += cursor.next();
	while (cursor.good() && !cursor.startsWith("*/")) value += cursor.next();
	if (!cursor.startsWith("*/")) return { value, closed: false };
	value += cursor.next();
	value += cursor.next();
	return { value, closed: true };
}

function readRawString(cursor: Cursor, prefix: string): { text: string; value: string; closed: boolean } {
	let text = "";
	for (const _character of prefix) text += cursor.next();
	text += cursor.next();
	let delimiter = "";
	while (cursor.good() && cursor.peek() !== "(") {
		delimiter += cursor.next();
		if (delimiter.length > 16) return { text, value: delimiter, closed: false };
	}
	if (cursor.peek() !== "(") return { text, value: delimiter, closed: false };
	text += cursor.next();
	let value = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("raw string scan failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === ")") {
			const mark = cursor.mark();
			let candidate = cursor.next();
			let matches = true;
			for (const character of delimiter) {
				if (cursor.peek() !== character) matches = false;
				candidate += cursor.next();
			}
			if (matches && cursor.peek() === '"') {
				candidate += cursor.next();
				text += candidate;
				return { text, value, closed: true };
			}
			cursor.rewind(mark);
		}
		const character = cursor.next();
		text += character;
		value += character;
	}
	return { text, value, closed: false };
}

function readQuoted(cursor: Cursor, prefix: string): { text: string; value: string; closed: boolean } {
	let text = "";
	for (const _character of prefix) text += cursor.next();
	const quote = cursor.next();
	text += quote;
	let value = "";
	while (cursor.good()) {
		if (cursor.peek() === quote) {
			text += cursor.next();
			return { text, value: decodeString(value), closed: true };
		}
		if (cursor.peek() === "\n") return { text, value: decodeString(value), closed: false };
		const character = cursor.next();
		text += character;
		if (character === "\\") {
			if (!cursor.good() || cursor.peek() === "\n") return { text, value: decodeString(value), closed: false };
			const escaped = cursor.next();
			text += escaped;
			value += character + escaped;
		} else {
			value += character;
		}
	}
	return { text, value: decodeString(value), closed: false };
}

function readNumber(cursor: Cursor): string {
	let value = "";
	if (cursor.peek() === ".") value += cursor.next();
	while (cursor.good() && isNumberPart(cursor.peek())) value += cursor.next();
	return value;
}

function longestOperator(cursor: Cursor): string | null {
	for (const operator of OPERATORS) if (cursor.startsWith(operator)) return operator;
	return null;
}

function addToken(
	tokens: Token[],
	kind: TokenKind,
	text: string,
	value: string,
	start: Position,
	end: Position,
	startOffset: number,
	endOffset: number,
): void {
	tokens.push(tokenFrom(kind, text, value, start, end, startOffset, endOffset));
}

export function tokenize(text: string, module?: string): TokenizedSource {
	const cursor = new Cursor(text);
	const tokens: Token[] = [];
	const diagnostics: Diagnostic[] = [];
	while (cursor.good()) {
		const before = cursor.offset;
		const start = cursor.position;
		const startOffset = cursor.offset;
		if (cursor.peek() === "\n") {
			const value = cursor.next();
			addToken(tokens, "newline", value, value, start, cursor.position, startOffset, cursor.offset);
		} else if (
			cursor.peek() === " " ||
			cursor.peek() === "\t" ||
			cursor.peek() === "\r" ||
			cursor.peek() === "\f"
		) {
			cursor.skipHorizontalWhitespace();
		} else if (cursor.startsWith("//")) {
			const value = readLineComment(cursor);
			addToken(tokens, "comment", value, value, start, cursor.position, startOffset, cursor.offset);
		} else if (cursor.startsWith("/*")) {
			const result = readBlockComment(cursor);
			addToken(tokens, "comment", result.value, result.value, start, cursor.position, startOffset, cursor.offset);
			if (!result.closed) diagnostics.push(diagnostic("Unterminated block comment.", start, cursor.position));
		} else {
			const prefix = prefixAt(cursor);
			const raw = prefix?.endsWith("R") ?? false;
			if (prefix !== null && raw) {
				const result = readRawString(cursor, prefix);
				addToken(
					tokens,
					"string",
					result.text,
					result.value,
					start,
					cursor.position,
					startOffset,
					cursor.offset,
				);
				if (!result.closed)
					diagnostics.push(diagnostic("Unterminated raw string literal.", start, cursor.position));
			} else if (prefix !== null) {
				const quote = cursor.peek(prefix.length);
				const result = readQuoted(cursor, prefix);
				addToken(
					tokens,
					quote === "'" ? "character" : "string",
					result.text,
					result.value,
					start,
					cursor.position,
					startOffset,
					cursor.offset,
				);
				if (!result.closed)
					diagnostics.push(diagnostic("Unterminated string literal.", start, cursor.position));
			} else if (cursor.peek() === '"' || cursor.peek() === "'") {
				const quote = cursor.peek();
				const result = readQuoted(cursor, "");
				addToken(
					tokens,
					quote === "'" ? "character" : "string",
					result.text,
					result.value,
					start,
					cursor.position,
					startOffset,
					cursor.offset,
				);
				if (!result.closed)
					diagnostics.push(diagnostic("Unterminated string literal.", start, cursor.position));
			} else if (isIdentifierStart(cursor.peek())) {
				const value = cursor.readWhile((character) => isIdentifierPart(character));
				const kind: TokenKind = value === "true" || value === "false" ? "identifier" : "identifier";
				addToken(tokens, kind, value, value, start, cursor.position, startOffset, cursor.offset);
			} else if (isDigit(cursor.peek()) || (cursor.peek() === "." && isDigit(cursor.peek(1)))) {
				const value = readNumber(cursor);
				addToken(tokens, "number", value, value, start, cursor.position, startOffset, cursor.offset);
			} else {
				const operator = longestOperator(cursor);
				const value = operator ?? cursor.next();
				for (const _character of operator ?? "") cursor.next();
				addToken(tokens, "punctuation", value, value, start, cursor.position, startOffset, cursor.offset);
			}
		}
		if (cursor.offset <= before) throw new Error("tokenizer failed to advance");
	}
	if (module !== undefined) {
		for (const item of diagnostics) item.path = module;
	}
	return { tokens, diagnostics };
}

export function isSignificant(token: Token): boolean {
	return token.kind !== "comment" && token.kind !== "newline";
}

export function rangeOfToken(token: Token): Range {
	return { start: token.start, end: token.end };
}
