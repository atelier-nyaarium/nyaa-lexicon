import type { OffsetRange, Range } from "@nyaa-lexicon/protocol";
import { Cursor, type CursorSpan, isAsciiDigit, isIdentifierPart, isIdentifierStart, sourceRange } from "./cursor.js";
import type { CommentSpan } from "./model.js";

////////////////////////////////
//  Interfaces & Types

export type RustTokenKind = "identifier" | "number" | "string" | "char" | "lifetime" | "symbol";

/** Lexed number parts, underscores kept. */
export interface RustNumber {
	base: 2 | 8 | 10 | 16;
	integer: string;
	/** Empty for `1.`. */
	fraction?: string;
	exponent?: { sign: "" | "+" | "-"; digits: string };
	suffix: string;
}

export interface RustToken extends CursorSpan {
	kind: RustTokenKind;
	value: string;
	raw: string;
	number?: RustNumber;
	/** Byte or C literal prefix. */
	prefix?: "b" | "c";
}

export interface ScanDiagnostic {
	message: string;
	span: CursorSpan;
}

interface ScanComments {
	spans: CommentSpan[];
	/** Each span's UTF-16 offsets, in source order. */
	offsets: OffsetRange[];
}

export interface ScanResult {
	tokens: RustToken[];
	/** Each says whether a code token shares its first and last lines. */
	comments: CommentSpan[];
	/** Each comment's UTF-16 offsets, in source order. */
	commentOffsets: OffsetRange[];
	/** Lines no token or comment touches. */
	blankLines: number[];
	diagnostics: ScanDiagnostic[];
	lineTokens: Map<number, RustToken[]>;
}

////////////////////////////////
//  Constants

export const KEYWORDS = new Set([
	"as",
	"async",
	"await",
	"break",
	"const",
	"continue",
	"crate",
	"dyn",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"Self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
	"yield",
]);

/** Keywords that still end an operand. */
export const OPERAND_WORDS = new Set(["self", "Self", "true", "false", "crate", "super", "await"]);

export const TYPE_WORDS: ReadonlySet<string> = new Set([
	"bool",
	"char",
	"str",
	"u8",
	"u16",
	"u32",
	"u64",
	"u128",
	"usize",
	"i8",
	"i16",
	"i32",
	"i64",
	"i128",
	"isize",
	"f32",
	"f64",
	"Self",
	"self",
	"dyn",
	"impl",
]);

////////////////////////////////
//  Functions & Helpers

export function isValueToken(token: RustToken | undefined, value: string): boolean {
	return token !== undefined && (token.kind === "symbol" || token.kind === "identifier") && token.value === value;
}

export function tokenAt(tokens: readonly RustToken[], index: number): RustToken | undefined {
	return tokens[index];
}

export function isNameToken(token: RustToken | undefined): token is RustToken {
	return token !== undefined && (token.kind === "identifier" || token.value === "self" || token.value === "Self");
}

////////////////////////////////
//  Constants

const MULTI_SYMBOLS = [
	">>=",
	"<<=",
	"...",
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

////////////////////////////////
//  Functions & Helpers

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
		if (escaped === "\n" || (escaped === "\r" && cursor.peek() === "\n")) {
			// Continuation skips following whitespace.
			cursor.readWhile((next) => next === " " || next === "\t" || next === "\n" || next === "\r");
			continue;
		}
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

function addComment(source: string, comments: ScanComments, span: CursorSpan): void {
	comments.spans.push({
		range: { start: span.start, end: span.end },
		text: sourceRange(source, span.startOffset, span.endOffset),
	});
	comments.offsets.push({ start: span.startOffset, end: span.endOffset });
}

/** A line comment stops before its terminator, and CRLF is one terminator. */
function readToLineEnd(cursor: Cursor): void {
	let guard = -1;
	while (cursor.good() && cursor.peek() !== "\n") {
		if (cursor.offset <= guard) throw new Error("line comment reader failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === "\r" && cursor.peek(1) === "\n") break;
		cursor.next();
	}
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

/** rustc's char literal. Null if unterminated. */
function tryCharacter(source: string, cursor: Cursor, prefixLength: number): RustToken | null {
	const mark = cursor.mark();
	for (let index = 0; index < prefixLength; index++) cursor.next();
	const bodyStart = cursor.offset;
	if (cursor.peek(1) === "'" && cursor.peek() !== "\\") {
		cursor.next();
	} else {
		let guard = -1;
		while (cursor.good() && cursor.peek() !== "'") {
			if (cursor.offset <= guard) throw new Error("character reader failed to advance");
			guard = cursor.offset;
			const character = cursor.peek();
			if (character === "/" || (character === "\n" && cursor.peek(1) !== "'")) break;
			cursor.next();
			if (character === "\\" && cursor.good()) cursor.next();
		}
	}
	if (cursor.peek() !== "'") {
		cursor.rewind(mark);
		return null;
	}
	const bodyEnd = cursor.offset;
	cursor.next();
	return makeToken(source, "char", decodeString(sourceRange(source, bodyStart, bodyEnd)), spanFrom(mark, cursor));
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

function scanLineComment(source: string, cursor: Cursor, comments: ScanComments): void {
	const mark = cursor.mark();
	const inner = cursor.peek(2) === "!";
	const doc = cursor.peek(2) === "/" || inner;
	consumeText(cursor, doc ? (inner ? "//!" : "///") : "//");
	readToLineEnd(cursor);
	addComment(source, comments, spanFrom(mark, cursor));
}

function scanBlockComment(source: string, cursor: Cursor, comments: ScanComments, diagnostics: ScanDiagnostic[]): void {
	const mark = cursor.mark();
	// `/**/` closes the comment rather than opening a doc one.
	const doc = cursor.peek(2) === "!" || (cursor.peek(2) === "*" && cursor.peek(3) !== "/");
	consumeText(cursor, "/*");
	if (doc) cursor.next();
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
			consumeText(cursor, "*/");
			depth--;
			if (depth === 0) {
				addComment(source, comments, spanFrom(mark, cursor));
				return;
			}
			continue;
		}
		cursor.next();
	}
	// An unterminated block is one span reaching end of file.
	addComment(source, comments, spanFrom(mark, cursor));
	diagnostics.push({ message: "block comment has no closing delimiter", span: spanFrom(mark, cursor) });
}

/** Whitespace or one comment. */
function scanTrivia(source: string, cursor: Cursor, comments: ScanComments, diagnostics: ScanDiagnostic[]): boolean {
	if (/\s/u.test(cursor.peek())) {
		cursor.next();
		return true;
	}
	if (matches(cursor, "//")) {
		scanLineComment(source, cursor, comments);
		return true;
	}
	if (matches(cursor, "/*")) {
		scanBlockComment(source, cursor, comments, diagnostics);
		return true;
	}
	return false;
}

/** Shebang unless the next token is `[`. */
function isShebang(source: string, cursor: Cursor): boolean {
	if (!matches(cursor, "#!")) return false;
	const mark = cursor.mark();
	consumeText(cursor, "#!");
	const skipped: ScanComments = { spans: [], offsets: [] };
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("shebang lookahead failed to advance");
		guard = cursor.offset;
		if (!scanTrivia(source, cursor, skipped, [])) break;
	}
	const attribute = cursor.peek() === "[";
	cursor.rewind(mark);
	return !attribute;
}

////////////////////////////////
//  Constants

const BASE_PREFIXES = new Map<string, 2 | 8 | 16>([
	["b", 2],
	["o", 8],
	["x", 16],
]);

////////////////////////////////
//  Functions & Helpers

function isHexLetter(character: string): boolean {
	return (character >= "a" && character <= "f") || (character >= "A" && character <= "F");
}

/** Binary and octal accept decimal digits. */
function readDigits(cursor: Cursor, hex: boolean): string {
	return cursor.readWhile(
		(character) => character === "_" || isAsciiDigit(character) || (hex && isHexLetter(character)),
	);
}

function readExponent(cursor: Cursor): NonNullable<RustNumber["exponent"]> {
	const character = cursor.peek();
	const sign = character === "+" || character === "-" ? character : "";
	if (sign !== "") cursor.next();
	return { sign, digits: readDigits(cursor, false) };
}

function readSuffix(cursor: Cursor): string {
	return isIdentifierStart(cursor.peek()) ? cursor.readWhile(isIdentifierPart) : "";
}

/** rustc_lexer's number grammar. */
function scanNumber(cursor: Cursor): RustNumber {
	const first = cursor.next();
	const base = first === "0" ? BASE_PREFIXES.get(cursor.peek()) : undefined;
	let number: RustNumber;
	if (base === undefined) {
		number = { base: 10, integer: first + readDigits(cursor, false), suffix: "" };
	} else {
		cursor.next();
		number = { base, integer: readDigits(cursor, base === 16), suffix: "" };
		// A digitless base literal ends here.
		if ([...number.integer].every((character) => character === "_")) {
			number.suffix = readSuffix(cursor);
			return number;
		}
	}
	const next = cursor.peek(1);
	// Leaves `1..2` and `1.max()`.
	if (cursor.peek() === "." && next !== "." && !isIdentifierStart(next)) {
		cursor.next();
		number.fraction = isAsciiDigit(cursor.peek()) ? readDigits(cursor, false) : "";
		if (number.fraction !== "" && (cursor.peek() === "e" || cursor.peek() === "E")) {
			cursor.next();
			number.exponent = readExponent(cursor);
		}
	} else if (cursor.peek() === "e" || cursor.peek() === "E") {
		cursor.next();
		number.exponent = readExponent(cursor);
	}
	number.suffix = readSuffix(cursor);
	return number;
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

/** From the nearest code token on each side; comments are not code. */
function withTrivia(comments: ScanComments, tokens: readonly RustToken[]): CommentSpan[] {
	let next = 0;
	return comments.spans.map((comment, at) => {
		const start = (comments.offsets[at] as OffsetRange).start;
		while (next < tokens.length && (tokens[next] as RustToken).startOffset < start) next++;
		const before = tokens[next - 1];
		const after = tokens[next];
		return {
			...comment,
			codeBefore: before !== undefined && before.end.line === comment.range.start.line,
			codeAfter: after !== undefined && after.start.line === comment.range.end.line,
		};
	});
}

/** An end at a line's first column touches only the lines before it. */
function lastLineOf(range: Range): number {
	return range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
}

/** Lines below `lineCount` no token or comment touches. */
function blankLinesOf(ranges: readonly Range[], lineCount: number): number[] {
	const touched = new Uint8Array(lineCount);
	for (const range of ranges) {
		for (let line = range.start.line; line <= lastLineOf(range) && line < lineCount; line++) touched[line] = 1;
	}
	const blank: number[] = [];
	for (let line = 0; line < lineCount; line++) if (touched[line] === 0) blank.push(line);
	return blank;
}

export function tokenize(source: string): ScanResult {
	const cursor = new Cursor(source);
	const tokens: RustToken[] = [];
	const comments: ScanComments = { spans: [], offsets: [] };
	const diagnostics: ScanDiagnostic[] = [];
	const lineTokens = new Map<number, RustToken[]>();
	let guard = -1;

	if (isShebang(source, cursor)) {
		const mark = cursor.mark();
		readToLineEnd(cursor);
		addComment(source, comments, spanFrom(mark, cursor));
	}

	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("tokenizer failed to advance");
		guard = cursor.offset;
		if (scanTrivia(source, cursor, comments, diagnostics)) continue;
		const character = cursor.peek();
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
			addToken(source, tokens, lineTokens, { ...token, prefix: character });
			continue;
		}
		if ((character === "b" || character === "c") && cursor.peek(1) === "r") {
			let offset = 2;
			while (cursor.peek(offset) === "#") offset++;
			if (cursor.peek(offset) === '"') {
				const token = scanRawString(source, cursor, 2, diagnostics);
				addToken(source, tokens, lineTokens, { ...token, prefix: character });
				continue;
			}
		}
		if (character === "b" && cursor.peek(1) === "'") {
			const token = tryCharacter(source, cursor, 2);
			if (token !== null) {
				addToken(source, tokens, lineTokens, { ...token, prefix: character });
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
			const token = tryCharacter(source, cursor, 1);
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
			const number = scanNumber(cursor);
			const span = spanFrom(mark, cursor);
			const token = makeToken(source, "number", sourceRange(source, span.startOffset, span.endOffset), span);
			addToken(source, tokens, lineTokens, { ...token, number });
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

	// A final line break ends the last line rather than opening another.
	const lineCount = cursor.column > 0 ? cursor.line + 1 : cursor.line;
	const ranges = [...tokens, ...comments.spans.map((comment) => comment.range)];
	return {
		tokens,
		comments: withTrivia(comments, tokens),
		commentOffsets: comments.offsets,
		blankLines: blankLinesOf(ranges, lineCount),
		diagnostics,
		lineTokens,
	};
}
