import type { Diagnostic, Position, Range } from "@nyaa-lexicon/protocol";
import { Cursor, isDigit, isHexDigit, isIdentifierPart, isIdentifierStart, isWhitespace } from "./cursor.js";

export type TokenKind =
	| "identifier"
	| "number"
	| "string"
	| "character"
	| "boolean"
	| "punctuation"
	| "doc"
	| "comment"
	| "directive"
	| "newline"
	| "eof";

export interface Token {
	kind: TokenKind;
	value: string;
	raw: string;
	start: Position;
	end: Position;
	startOffset: number;
	endOffset: number;
}

export interface LexedSource {
	tokens: Token[];
	literals: Token[];
	/** Every line and block comment token, in source order. A directive is not a comment. */
	comments: Token[];
	diagnostics: Diagnostic[];
}

const OPERATORS = [
	">>>=",
	"<<=",
	">>=",
	"??=",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
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
	"::",
	"..",
] as const;

// Directive forms whose body is tokens rather than free text. Only there does a trailing `//`
// start a comment; in every other form, and in a quoted path, slashes are the directive's text.
const TOKENIZED_DIRECTIVES = new Set(["define", "elif", "else", "endif", "if", "line", "nullable", "pragma", "undef"]);

const SIMPLE_ESCAPES: Record<string, string> = {
	"0": "\0",
	a: "\x07",
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

function rangeOf(start: Position, end: Position): Range {
	return { start, end };
}

function diagnostic(message: string, start: Position, end: Position): Diagnostic {
	return { severity: "error", message, range: rangeOf(start, end) };
}

function positionOf(mark: ReturnType<Cursor["mark"]>): Position {
	return { line: mark.line, character: mark.column };
}

function sameAscii(cursor: Cursor, value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		if (cursor.peek(index) !== value[index]) return false;
	}
	return true;
}

function consumeAscii(cursor: Cursor, value: string): void {
	for (let index = 0; index < value.length; index++) cursor.next();
}

function decodeEscape(cursor: Cursor): string {
	const slash = cursor.next();
	if (slash !== "\\") return slash;
	const escaped = cursor.next();
	if (escaped === "") return "\\";
	const simple = SIMPLE_ESCAPES[escaped];
	if (simple !== undefined) return simple;
	const digits = escaped === "u" ? 4 : escaped === "U" ? 8 : escaped === "x" ? 2 : 0;
	if (digits === 0) return escaped;
	let hex = "";
	let guard = -1;
	while (hex.length < digits && isHexDigit(cursor.peek())) {
		if (cursor.offset <= guard) throw new Error("escape reader failed to advance");
		guard = cursor.offset;
		hex += cursor.next();
	}
	if (hex.length !== digits) return `${escaped}${hex}`;
	const codePoint = Number.parseInt(hex, 16);
	return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : `${escaped}${hex}`;
}

function readNumber(cursor: Cursor): string {
	let value = "";
	if (cursor.peek() === "0" && (cursor.peek(1) === "x" || cursor.peek(1) === "X")) {
		value += cursor.next();
		value += cursor.next();
		value += cursor.readWhile((character) => isHexDigit(character) || character === "_");
		return value + cursor.readWhile((character) => /[uUlL]$/u.test(character));
	}
	if (cursor.peek() === "0" && (cursor.peek(1) === "b" || cursor.peek(1) === "B")) {
		value += cursor.next();
		value += cursor.next();
		value += cursor.readWhile((character) => character === "0" || character === "1" || character === "_");
		return value + cursor.readWhile((character) => /[uUlL]$/u.test(character));
	}
	value += cursor.readWhile((character) => isDigit(character) || character === "_");
	if (cursor.peek() === "." && isDigit(cursor.peek(1))) {
		value += cursor.next();
		value += cursor.readWhile((character) => isDigit(character) || character === "_");
	}
	if (cursor.peek() === "e" || cursor.peek() === "E") {
		const mark = cursor.mark();
		let exponent = cursor.next();
		if (cursor.peek() === "+" || cursor.peek() === "-") exponent += cursor.next();
		const digits = cursor.readWhile((character) => isDigit(character) || character === "_");
		if (digits === "") cursor.rewind(mark);
		else exponent += digits;
		if (digits !== "") value += exponent;
	}
	return value + cursor.readWhile((character) => /[fFdDmMuUlL]$/u.test(character));
}

function readString(
	cursor: Cursor,
	quote: '"' | "'",
	verbatim: boolean,
	rawString: boolean,
): { value: string; closed: boolean; invalidNewline: boolean } {
	let value = "";
	let invalidNewline = false;
	if (rawString) {
		consumeAscii(cursor, quote.repeat(3));
		while (cursor.good()) {
			if (sameAscii(cursor, quote.repeat(3))) {
				consumeAscii(cursor, quote.repeat(3));
				return { value, closed: true, invalidNewline };
			}
			value += cursor.next();
		}
		return { value, closed: false, invalidNewline };
	}
	if (cursor.peek() === quote) cursor.next();
	while (cursor.good()) {
		if (cursor.peek() === quote) {
			if (verbatim && cursor.peek(1) === quote) {
				cursor.next();
				cursor.next();
				value += quote;
				continue;
			}
			cursor.next();
			return { value, closed: true, invalidNewline };
		}
		if (!verbatim && isNewline(cursor.peek())) invalidNewline = true;
		if (!verbatim && cursor.peek() === "\\") {
			value += decodeEscape(cursor);
			continue;
		}
		value += cursor.next();
	}
	return { value, closed: false, invalidNewline };
}

function readPrefixString(
	cursor: Cursor,
): { value: string; quote: '"' | "'"; rawString: boolean; closed: boolean; invalidNewline: boolean } | null {
	const start = cursor.mark();
	let verbatim = false;
	while (cursor.peek() === "$" || cursor.peek() === "@") {
		if (cursor.next() === "@") verbatim = true;
	}
	const quote = cursor.peek();
	if (quote !== '"' && quote !== "'") {
		cursor.rewind(start);
		return null;
	}
	const rawString = !verbatim && quote === '"' && cursor.peek(1) === '"' && cursor.peek(2) === '"';
	const string = readString(cursor, quote, verbatim, rawString);
	return { ...string, quote, rawString };
}

function token(cursor: Cursor, kind: TokenKind, value: string, start: ReturnType<Cursor["mark"]>): Token {
	const end = cursor.mark();
	return {
		kind,
		value,
		raw: cursor.textBetween(start.offset, end.offset),
		start: { line: start.line, character: start.column },
		end: { line: end.line, character: end.column },
		startOffset: start.offset,
		endOffset: end.offset,
	};
}

function isNewline(character: string): boolean {
	return character === "\r" || character === "\n";
}

function addLiteral(literals: Token[], item: Token): void {
	if (item.kind === "string" || item.kind === "number" || item.kind === "boolean") literals.push(item);
}

export function tokenize(
	text: string,
	options: { collectLiterals?: boolean; collectComments?: boolean } = {},
): LexedSource {
	const cursor = new Cursor(text);
	const tokens: Token[] = [];
	const literals: Token[] = [];
	const comments: Token[] = [];
	const diagnostics: Diagnostic[] = [];
	const collectLiterals = options.collectLiterals ?? true;
	const collectComments = options.collectComments ?? true;
	const addComment = (item: Token): void => {
		tokens.push(item);
		if (collectComments) comments.push(item);
	};
	while (cursor.good()) {
		const before = cursor.offset;
		const character = cursor.peek();
		if (isWhitespace(character)) {
			cursor.next();
		} else if (isNewline(character)) {
			const start = cursor.mark();
			cursor.next();
			if (character === "\r" && cursor.peek() === "\n") cursor.next();
			tokens.push(token(cursor, "newline", "\n", start));
		} else if (sameAscii(cursor, "//")) {
			const start = cursor.mark();
			cursor.next();
			cursor.next();
			if (cursor.peek() === "/") {
				cursor.next();
				if (cursor.peek() === " ") cursor.next();
				const value = cursor.readWhile((item) => !isNewline(item));
				addComment(token(cursor, "doc", value, start));
			} else {
				cursor.readWhile((item) => !isNewline(item));
				addComment(token(cursor, "comment", "", start));
			}
		} else if (sameAscii(cursor, "/*")) {
			const start = cursor.mark();
			cursor.next();
			cursor.next();
			let closed = false;
			while (cursor.good()) {
				if (sameAscii(cursor, "*/")) {
					cursor.next();
					cursor.next();
					closed = true;
					break;
				}
				cursor.next();
			}
			if (!closed)
				diagnostics.push(
					diagnostic("Block comment has no closing delimiter.", positionOf(start), positionOf(cursor.mark())),
				);
			addComment(token(cursor, "comment", "", start));
		} else if (character === "#") {
			const start = cursor.mark();
			cursor.next();
			cursor.readWhile(isWhitespace);
			const keyword = cursor.readWhile(isIdentifierPart);
			const tokenized = TOKENIZED_DIRECTIVES.has(keyword);
			while (cursor.good() && !isNewline(cursor.peek())) {
				if (!tokenized) {
					cursor.next();
					continue;
				}
				if (sameAscii(cursor, "//")) break;
				if (cursor.peek() === '"') {
					cursor.next();
					while (cursor.good() && !isNewline(cursor.peek()) && cursor.peek() !== '"') cursor.next();
					if (cursor.peek() === '"') cursor.next();
					continue;
				}
				cursor.next();
			}
			tokens.push(token(cursor, "directive", keyword, start));
			if (sameAscii(cursor, "//")) {
				const commentStart = cursor.mark();
				cursor.readWhile((item) => !isNewline(item));
				addComment(token(cursor, "comment", "", commentStart));
			}
		} else if (character === "@" && isIdentifierStart(cursor.peek(1))) {
			const start = cursor.mark();
			cursor.next();
			const value = cursor.readWhile(isIdentifierPart);
			tokens.push(token(cursor, "identifier", value, start));
		} else if (character === '"' || character === "'" || character === "$" || character === "@") {
			const start = cursor.mark();
			const parsed = readPrefixString(cursor);
			if (parsed === null) {
				cursor.next();
				tokens.push(token(cursor, "punctuation", character, start));
			} else {
				const item = token(cursor, parsed.quote === '"' ? "string" : "character", parsed.value, start);
				tokens.push(item);
				if (!parsed.closed) {
					diagnostics.push(diagnostic("String literal has no closing quote.", item.start, item.end));
				}
				if (parsed.invalidNewline)
					diagnostics.push(diagnostic("String literal cannot contain a newline.", item.start, item.end));
				if (collectLiterals) addLiteral(literals, item);
			}
		} else if (isDigit(character)) {
			const start = cursor.mark();
			const value = readNumber(cursor);
			const item = token(cursor, "number", value, start);
			tokens.push(item);
			if (collectLiterals) addLiteral(literals, item);
		} else if (isIdentifierStart(character)) {
			const start = cursor.mark();
			const value = cursor.readWhile(isIdentifierPart);
			const kind: TokenKind = value === "true" || value === "false" ? "boolean" : "identifier";
			const item = token(cursor, kind, value, start);
			tokens.push(item);
			if (collectLiterals) addLiteral(literals, item);
		} else {
			const start = cursor.mark();
			const operator = OPERATORS.find((candidate) => sameAscii(cursor, candidate));
			if (operator === undefined) {
				cursor.next();
				tokens.push(token(cursor, "punctuation", character, start));
			} else {
				consumeAscii(cursor, operator);
				tokens.push(token(cursor, "punctuation", operator, start));
			}
		}
		if (cursor.offset <= before) throw new Error("tokenizer failed to advance");
	}
	tokens.push(token(cursor, "eof", "", cursor.mark()));
	return { tokens, literals, comments, diagnostics };
}

export function positionRange(token: Token): Range {
	return { start: token.start, end: token.end };
}

export function pointRange(position: Position): Range {
	return { start: position, end: { line: position.line, character: position.character + 1 } };
}
