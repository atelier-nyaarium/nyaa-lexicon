import { Cursor, type CursorSpan, isAsciiDigit, isIdentifierPart, isIdentifierStart, sourceRange } from "./cursor.js";
import type { DocComment } from "./model.js";

export type RustTokenKind = "identifier" | "number" | "string" | "char" | "lifetime" | "symbol";

export interface RustToken extends CursorSpan {
	kind: RustTokenKind;
	value: string;
	raw: string;
}

export interface ScanDiagnostic {
	message: string;
	span: CursorSpan;
}

export interface ScanResult {
	tokens: RustToken[];
	docs: DocComment[];
	diagnostics: ScanDiagnostic[];
	lineTokens: Map<number, RustToken[]>;
}

const MULTI_SYMBOLS = [
	">>=",
	"<<=",
	"..=",
	"=>",
	"->",
	"::",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
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
	"..",
	"??",
] as const;

function matches(cursor: Cursor, text: string): boolean {
	let index = 0;
	for (const character of text) {
		if (cursor.peek(index) !== character) return false;
		index += character.length;
	}
	return true;
}

function consumeText(cursor: Cursor, text: string): void {
	for (const _character of text) cursor.next();
}

function cleanDocText(text: string): string {
	const trimmed = text.startsWith(" ") ? text.slice(1) : text;
	return trimmed.replace(/\s+$/u, "");
}

function decodeString(text: string): string {
	const cursor = new Cursor(text);
	let decoded = "";
	while (cursor.good()) {
		const character = cursor.next();
		if (character !== "\\" || !cursor.good()) {
			decoded += character;
			continue;
		}
		const escaped = cursor.next();
		if (escaped === "\n") continue;
		if (escaped === "x") {
			const hex = cursor.next() + cursor.next();
			const codePoint = Number.parseInt(hex, 16);
			if (/^[0-9a-fA-F]{2}$/u.test(hex) && Number.isFinite(codePoint)) {
				decoded += String.fromCharCode(codePoint);
				continue;
			}
			decoded += `\\x${hex}`;
			continue;
		}
		const simple: Record<string, string> = {
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
		const replacement = simple[escaped];
		if (replacement !== undefined) {
			decoded += replacement;
			continue;
		}
		if (escaped === "u" && cursor.peek() === "{") {
			cursor.next();
			const hex = cursor.readWhile((value) => value !== "}");
			if (cursor.peek() === "}") cursor.next();
			const codePoint = Number.parseInt(hex, 16);
			if (hex !== "" && Number.isFinite(codePoint) && codePoint <= 0x10ffff) {
				decoded += String.fromCodePoint(codePoint);
				continue;
			}
		}
		decoded += `\\${escaped}`;
	}
	return decoded;
}

function spanFrom(mark: ReturnType<Cursor["mark"]>, cursor: Cursor): CursorSpan {
	return cursor.span(mark);
}

function makeToken(source: string, kind: RustTokenKind, value: string, span: CursorSpan): RustToken {
	return { kind, value, raw: sourceRange(source, span.startOffset, span.endOffset), ...span };
}

function scanQuoted(
	source: string,
	cursor: Cursor,
	quote: '"' | "'",
	prefixLength: number,
	diagnostics: ScanDiagnostic[],
): RustToken {
	const mark = cursor.mark();
	for (let index = 0; index < prefixLength; index++) cursor.next();
	const bodyStart = cursor.offset;
	let closed = false;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("quoted reader failed to advance");
		guard = cursor.offset;
		const character = cursor.peek();
		if (character === quote) {
			closed = true;
			break;
		}
		if (character === "\\") {
			cursor.next();
			if (cursor.good()) cursor.next();
			continue;
		}
		if (character === "\r") break;
		cursor.next();
	}
	const bodyEnd = cursor.offset;
	if (closed) cursor.next();
	else
		diagnostics.push({
			message: "string or character literal has no closing delimiter",
			span: spanFrom(mark, cursor),
		});
	const span = spanFrom(mark, cursor);
	const body = sourceRange(source, bodyStart, bodyEnd);
	return makeToken(source, quote === '"' ? "string" : "char", decodeString(body), span);
}

function tryCharacter(source: string, cursor: Cursor): RustToken | null {
	const mark = cursor.mark();
	cursor.next();
	let guard = -1;
	while (cursor.good() && cursor.peek() !== "\n") {
		if (cursor.offset <= guard) throw new Error("character reader failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === "\\") {
			cursor.next();
			if (cursor.good()) cursor.next();
			continue;
		}
		if (cursor.peek() === "'") {
			cursor.next();
			const span = spanFrom(mark, cursor);
			const bodyStart = mark.offset + 1;
			const bodyEnd = span.endOffset - 1;
			return makeToken(source, "char", decodeString(sourceRange(source, bodyStart, bodyEnd)), span);
		}
		if (cursor.peek() === " ") break;
		cursor.next();
	}
	cursor.rewind(mark);
	return null;
}

function isLifetime(cursor: Cursor): boolean {
	if (cursor.peek() !== "'" || !isIdentifierStart(cursor.peek(1))) return false;
	let offset = 1;
	while (isIdentifierPart(cursor.peek(offset))) offset++;
	return cursor.peek(offset) !== "'";
}

function scanLifetime(source: string, cursor: Cursor): RustToken {
	const mark = cursor.mark();
	let value = cursor.next();
	value += cursor.next();
	while (isIdentifierPart(cursor.peek())) value += cursor.next();
	return makeToken(source, "lifetime", value, spanFrom(mark, cursor));
}

function scanRawString(source: string, cursor: Cursor, prefixLength: number, diagnostics: ScanDiagnostic[]): RustToken {
	const mark = cursor.mark();
	for (let index = 0; index < prefixLength; index++) cursor.next();
	let hashes = 0;
	while (cursor.peek() === "#") {
		hashes++;
		cursor.next();
	}
	if (cursor.peek() === '"') cursor.next();
	const bodyStart = cursor.offset;
	let bodyEnd = cursor.offset;
	let closed = false;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("raw string reader failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === '"') {
			let valid = true;
			for (let index = 1; index <= hashes; index++) if (cursor.peek(index) !== "#") valid = false;
			if (valid) {
				bodyEnd = cursor.offset;
				cursor.next();
				for (let index = 0; index < hashes; index++) cursor.next();
				closed = true;
				break;
			}
		}
		cursor.next();
	}
	if (!closed) {
		bodyEnd = cursor.offset;
		diagnostics.push({ message: "raw string literal has no closing delimiter", span: spanFrom(mark, cursor) });
	}
	const span = spanFrom(mark, cursor);
	return makeToken(source, "string", sourceRange(source, bodyStart, bodyEnd), span);
}

function scanLineComment(cursor: Cursor, docs: DocComment[]): void {
	const inner = cursor.peek(2) === "!";
	const doc = cursor.peek(2) === "/" || inner;
	consumeText(cursor, doc ? (inner ? "//!" : "///") : "//");
	const body = cursor.readWhile((character) => character !== "\n");
	if (doc) docs.push({ line: cursor.line, text: cleanDocText(body), inner });
}

function scanBlockComment(source: string, cursor: Cursor, docs: DocComment[], diagnostics: ScanDiagnostic[]): void {
	const mark = cursor.mark();
	const doc = cursor.peek(2) === "*" || cursor.peek(2) === "!";
	const inner = cursor.peek(2) === "!";
	consumeText(cursor, "/*");
	if (doc) cursor.next();
	const bodyStart = cursor.offset;
	let depth = 1;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("block comment reader failed to advance");
		guard = cursor.offset;
		if (matches(cursor, "/*")) {
			consumeText(cursor, "/*");
			depth++;
			continue;
		}
		if (matches(cursor, "*/")) {
			const bodyEnd = cursor.offset;
			consumeText(cursor, "*/");
			depth--;
			if (depth === 0) {
				if (doc) {
					const body = sourceRange(source, bodyStart, bodyEnd);
					docs.push({ line: mark.line, text: cleanDocText(body), inner });
				}
				return;
			}
			continue;
		}
		cursor.next();
	}
	diagnostics.push({ message: "block comment has no closing delimiter", span: spanFrom(mark, cursor) });
}

function scanNumber(cursor: Cursor): string {
	let value = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("number reader failed to advance");
		guard = cursor.offset;
		const character = cursor.peek();
		if (isAsciiDigit(character) || /[A-Za-z_]/u.test(character)) {
			value += cursor.next();
			continue;
		}
		if (character === "." && cursor.peek(1) !== ".") {
			value += cursor.next();
			continue;
		}
		if ((character === "+" || character === "-") && /[eE]/u.test(value.slice(-1))) {
			value += cursor.next();
			continue;
		}
		break;
	}
	return value;
}

function scanIdentifier(cursor: Cursor): string {
	let value = "";
	if (cursor.peek() === "r" && cursor.peek(1) === "#" && isIdentifierStart(cursor.peek(2))) {
		cursor.next();
		cursor.next();
		value = cursor.next();
		while (isIdentifierPart(cursor.peek())) value += cursor.next();
		return value;
	}
	value += cursor.next();
	while (isIdentifierPart(cursor.peek())) value += cursor.next();
	return value;
}

function addToken(source: string, tokens: RustToken[], lineTokens: Map<number, RustToken[]>, token: RustToken): void {
	tokens.push(token);
	const line = lineTokens.get(token.start.line) ?? [];
	line.push(token);
	lineTokens.set(token.start.line, line);
}

export function tokenize(source: string): ScanResult {
	const cursor = new Cursor(source);
	const tokens: RustToken[] = [];
	const docs: DocComment[] = [];
	const diagnostics: ScanDiagnostic[] = [];
	const lineTokens = new Map<number, RustToken[]>();
	let guard = -1;

	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("tokenizer failed to advance");
		guard = cursor.offset;
		const character = cursor.peek();
		if (/\s/u.test(character)) {
			cursor.next();
			continue;
		}
		if (matches(cursor, "//")) {
			scanLineComment(cursor, docs);
			continue;
		}
		if (matches(cursor, "/*")) {
			scanBlockComment(source, cursor, docs, diagnostics);
			continue;
		}
		const mark = cursor.mark();
		if (character === "r" && (cursor.peek(1) === '"' || cursor.peek(1) === "#")) {
			let offset = 1;
			while (cursor.peek(offset) === "#") offset++;
			if (cursor.peek(offset) === '"') {
				const token = scanRawString(source, cursor, 1, diagnostics);
				addToken(source, tokens, lineTokens, token);
				continue;
			}
		}
		if ((character === "b" || character === "c") && cursor.peek(1) === '"') {
			const token = scanQuoted(source, cursor, '"', 2, diagnostics);
			addToken(source, tokens, lineTokens, token);
			continue;
		}
		if ((character === "b" || character === "c") && cursor.peek(1) === "r") {
			let offset = 2;
			while (cursor.peek(offset) === "#") offset++;
			if (cursor.peek(offset) === '"') {
				const token = scanRawString(source, cursor, 2, diagnostics);
				addToken(source, tokens, lineTokens, token);
				continue;
			}
		}
		if (character === '"') {
			const token = scanQuoted(source, cursor, '"', 1, diagnostics);
			addToken(source, tokens, lineTokens, token);
			continue;
		}
		if (character === "'") {
			if (isLifetime(cursor)) {
				addToken(source, tokens, lineTokens, scanLifetime(source, cursor));
				continue;
			}
			const token = tryCharacter(source, cursor);
			if (token !== null) {
				addToken(source, tokens, lineTokens, token);
				continue;
			}
		}
		if (isIdentifierStart(character)) {
			const value = scanIdentifier(cursor);
			const span = spanFrom(mark, cursor);
			addToken(source, tokens, lineTokens, makeToken(source, "identifier", value, span));
			continue;
		}
		if (isAsciiDigit(character)) {
			const value = scanNumber(cursor);
			const span = spanFrom(mark, cursor);
			addToken(source, tokens, lineTokens, makeToken(source, "number", value, span));
			continue;
		}
		const symbol = MULTI_SYMBOLS.find((candidate) => matches(cursor, candidate));
		if (symbol !== undefined) {
			consumeText(cursor, symbol);
			const span = spanFrom(mark, cursor);
			addToken(source, tokens, lineTokens, makeToken(source, "symbol", symbol, span));
			continue;
		}
		const value = cursor.next();
		const span = spanFrom(mark, cursor);
		addToken(source, tokens, lineTokens, makeToken(source, "symbol", value, span));
	}

	return { tokens, docs, diagnostics, lineTokens };
}

export function tokenText(source: string, token: RustToken): string {
	return sourceRange(source, token.startOffset, token.endOffset);
}
