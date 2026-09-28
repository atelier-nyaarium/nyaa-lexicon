import { type CursorMark, type CursorSpan, type OffsetRange, type Range, SourceCursor } from "@nyaa-lexicon/protocol";
import {
	BYTE_ORDER_MARK,
	isAsciiDigit,
	isHexDigit,
	isIdentifierPart,
	isIdentifierStart,
	isWhitespace,
} from "./characters.js";
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
	/** The source between two offsets, read from the cursor that lexed it. */
	textOf: (start: number, end: number) => string;
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

/** A symbol, or a word as written; a raw identifier spells no keyword. */
export function isValueToken(token: RustToken | undefined, value: string): boolean {
	return token !== undefined && (token.kind === "symbol" || token.kind === "identifier") && token.raw === value;
}

/** A keyword as written, never a raw identifier spelling one. */
export function isKeyword(token: RustToken | undefined): boolean {
	return token?.kind === "identifier" && token.raw === token.value && KEYWORDS.has(token.value);
}

export function tokenAt(tokens: readonly RustToken[], index: number): RustToken | undefined {
	return tokens[index];
}

export function isNameToken(token: RustToken | undefined): token is RustToken {
	return token !== undefined && token.kind === "identifier";
}

////////////////////////////////
//  Constants

/** rustc glues these; `?` stays single, so `x??` is two. */
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
] as const;

const SIMPLE_ESCAPES = new Map([
	["0", "\0"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
	["\\", "\\"],
	['"', '"'],
	["'", "'"],
]);

////////////////////////////////
//  Functions & Helpers

function isContinuationSpace(character: string): boolean {
	return character === " " || character === "\t" || character === "\n" || character === "\r";
}

/** A literal body's value: escapes decoded, CRLF read as LF. */
function decodeString(body: string): string {
	const cursor = new SourceCursor(body);
	let decoded = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("escape decoder failed to advance");
		guard = cursor.offset;
		const character = cursor.next();
		if (character === "\r" && cursor.peek() === "\n") continue;
		if (character !== "\\" || !cursor.good()) {
			decoded += character;
			continue;
		}
		const escaped = cursor.next();
		if (escaped === "\n" || (escaped === "\r" && cursor.peek() === "\n")) {
			cursor.readWhile(isContinuationSpace);
			continue;
		}
		const simple = SIMPLE_ESCAPES.get(escaped);
		if (simple !== undefined) {
			decoded += simple;
			continue;
		}
		if (escaped === "x" && isHexDigit(cursor.peek()) && isHexDigit(cursor.peek(1))) {
			decoded += String.fromCharCode(Number.parseInt(cursor.next() + cursor.next(), 16));
			continue;
		}
		if (escaped === "u" && cursor.peek() === "{") {
			const mark = cursor.mark();
			cursor.next();
			const digits = cursor.readWhile((value) => isHexDigit(value) || value === "_").replaceAll("_", "");
			const codePoint = Number.parseInt(digits, 16);
			if (cursor.peek() === "}" && digits !== "" && digits.length <= 6 && codePoint <= 0x10ffff) {
				cursor.next();
				decoded += String.fromCodePoint(codePoint);
				continue;
			}
			cursor.rewind(mark);
		}
		decoded += `\\${escaped}`;
	}
	return decoded;
}

/** A raw body's value: CRLF read as LF. */
function normalizeLineBreaks(body: string): string {
	const cursor = new SourceCursor(body);
	let value = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("line break reader failed to advance");
		guard = cursor.offset;
		const character = cursor.next();
		if (character !== "\r" || cursor.peek() !== "\n") value += character;
	}
	return value;
}

function addComment(cursor: SourceCursor, comments: ScanComments, span: CursorSpan): void {
	comments.spans.push({
		range: { start: span.start, end: span.end },
		text: cursor.textOf(span.startOffset, span.endOffset),
	});
	comments.offsets.push({ start: span.startOffset, end: span.endOffset });
}

/** A line comment stops before its terminator, and CRLF is one terminator. */
function readToLineEnd(cursor: SourceCursor): void {
	let guard = -1;
	while (cursor.good() && cursor.peek() !== "\n") {
		if (cursor.offset <= guard) throw new Error("line comment reader failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === "\r" && cursor.peek(1) === "\n") break;
		cursor.next();
	}
}

function makeToken(cursor: SourceCursor, kind: RustTokenKind, value: string, span: CursorSpan): RustToken {
	return { kind, value, raw: cursor.textOf(span.startOffset, span.endOffset), ...span };
}

function skip(cursor: SourceCursor, count: number): void {
	for (let index = 0; index < count; index++) cursor.next();
}

function scanQuoted(
	cursor: SourceCursor,
	quote: '"' | "'",
	prefixLength: number,
	diagnostics: ScanDiagnostic[],
): RustToken {
	const mark = cursor.mark();
	skip(cursor, prefixLength);
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
			span: cursor.span(mark),
		});
	const body = cursor.textOf(bodyStart, bodyEnd);
	return makeToken(cursor, quote === '"' ? "string" : "char", decodeString(body), cursor.span(mark));
}

/** rustc's char literal. Null if unterminated. */
function tryCharacter(cursor: SourceCursor, prefixLength: number): RustToken | null {
	const mark = cursor.mark();
	skip(cursor, prefixLength);
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
	return makeToken(cursor, "char", decodeString(cursor.textOf(bodyStart, bodyEnd)), cursor.span(mark));
}

/** `'name` or `'r#name` with no closing quote after the name. */
function isLifetime(cursor: SourceCursor): boolean {
	if (cursor.peek() !== "'" || cursor.peek(1) === "'") return false;
	const mark = cursor.mark();
	cursor.next();
	if (cursor.peek() === "r" && cursor.peek(1) === "#" && isIdentifierStart(cursor.peek(2))) cursor.take("r#");
	const named = isIdentifierStart(cursor.peek()) && cursor.readWhile(isIdentifierPart) !== "";
	const lifetime = named && cursor.peek() !== "'";
	cursor.rewind(mark);
	return lifetime;
}

function scanLifetime(cursor: SourceCursor): RustToken {
	const mark = cursor.mark();
	cursor.next();
	if (cursor.startsWith("r#")) skip(cursor, 2);
	const name = cursor.readWhile(isIdentifierPart);
	return makeToken(cursor, "lifetime", `'${name}`, cursor.span(mark));
}

function scanRawString(cursor: SourceCursor, prefixLength: number, diagnostics: ScanDiagnostic[]): RustToken {
	const mark = cursor.mark();
	skip(cursor, prefixLength);
	const hashes = cursor.readWhile((character) => character === "#").length;
	cursor.take('"');
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
				skip(cursor, hashes + 1);
				closed = true;
				break;
			}
		}
		cursor.next();
	}
	if (!closed) {
		bodyEnd = cursor.offset;
		diagnostics.push({ message: "raw string literal has no closing delimiter", span: cursor.span(mark) });
	}
	return makeToken(cursor, "string", normalizeLineBreaks(cursor.textOf(bodyStart, bodyEnd)), cursor.span(mark));
}

function scanLineComment(cursor: SourceCursor, comments: ScanComments): void {
	const mark = cursor.mark();
	cursor.take("//");
	readToLineEnd(cursor);
	addComment(cursor, comments, cursor.span(mark));
}

function scanBlockComment(cursor: SourceCursor, comments: ScanComments, diagnostics: ScanDiagnostic[]): void {
	const mark = cursor.mark();
	// `/**/` closes the comment rather than opening a doc one.
	const doc = cursor.peek(2) === "!" || (cursor.peek(2) === "*" && cursor.peek(3) !== "/");
	cursor.take("/*");
	if (doc) cursor.next();
	let depth = 1;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("block comment reader failed to advance");
		guard = cursor.offset;
		if (cursor.take("/*")) {
			depth++;
			continue;
		}
		if (cursor.take("*/")) {
			depth--;
			if (depth === 0) {
				addComment(cursor, comments, cursor.span(mark));
				return;
			}
			continue;
		}
		cursor.next();
	}
	// An unterminated block is one span reaching end of file.
	addComment(cursor, comments, cursor.span(mark));
	diagnostics.push({ message: "block comment has no closing delimiter", span: cursor.span(mark) });
}

/** Whitespace or one comment. */
function scanTrivia(cursor: SourceCursor, comments: ScanComments, diagnostics: ScanDiagnostic[]): boolean {
	if (isWhitespace(cursor.peek())) {
		cursor.next();
		return true;
	}
	if (cursor.startsWith("//")) {
		scanLineComment(cursor, comments);
		return true;
	}
	if (cursor.startsWith("/*")) {
		scanBlockComment(cursor, comments, diagnostics);
		return true;
	}
	return false;
}

/** Shebang unless the next token is `[`. */
function isShebang(cursor: SourceCursor): boolean {
	if (!cursor.startsWith("#!")) return false;
	const mark = cursor.mark();
	cursor.take("#!");
	const skipped: ScanComments = { spans: [], offsets: [] };
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("shebang lookahead failed to advance");
		guard = cursor.offset;
		if (!scanTrivia(cursor, skipped, [])) break;
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

/** Binary and octal accept decimal digits. */
function readDigits(cursor: SourceCursor, hex: boolean): string {
	return cursor.readWhile(
		(character) => character === "_" || (hex ? isHexDigit(character) : isAsciiDigit(character)),
	);
}

function readExponent(cursor: SourceCursor): NonNullable<RustNumber["exponent"]> {
	const character = cursor.peek();
	const sign = character === "+" || character === "-" ? character : "";
	if (sign !== "") cursor.next();
	return { sign, digits: readDigits(cursor, false) };
}

function readSuffix(cursor: SourceCursor): string {
	return isIdentifierStart(cursor.peek()) ? cursor.readWhile(isIdentifierPart) : "";
}

/** rustc_lexer's number grammar. */
function scanNumber(cursor: SourceCursor): RustNumber {
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

/** The name an identifier spells; `r#` is no part of it. */
function scanIdentifier(cursor: SourceCursor): string {
	if (cursor.peek() === "r" && cursor.peek(1) === "#" && isIdentifierStart(cursor.peek(2))) cursor.take("r#");
	const start = cursor.mark();
	cursor.next();
	cursor.readWhile(isIdentifierPart);
	return cursor.textSince(start);
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

/** A raw string, byte or C string, or byte character at the cursor; null for anything else. */
function scanPrefixed(cursor: SourceCursor, diagnostics: ScanDiagnostic[]): RustToken | null {
	const character = cursor.peek();
	const prefix = character === "b" || character === "c" ? character : undefined;
	const rawAt = prefix === undefined ? 0 : 1;
	if (cursor.peek(rawAt) === "r" && (character === "r" || prefix !== undefined)) {
		let offset = rawAt + 1;
		while (cursor.peek(offset) === "#") offset++;
		if (cursor.peek(offset) === '"') {
			const token = scanRawString(cursor, rawAt + 1, diagnostics);
			return prefix === undefined ? token : { ...token, prefix };
		}
	}
	if (prefix !== undefined && cursor.peek(1) === '"') return { ...scanQuoted(cursor, '"', 2, diagnostics), prefix };
	if (prefix === "b" && cursor.peek(1) === "'") {
		const token = tryCharacter(cursor, 2);
		return token === null ? null : { ...token, prefix };
	}
	return null;
}

/** The one token at the cursor, which trivia does not start. */
function scanToken(cursor: SourceCursor, diagnostics: ScanDiagnostic[]): RustToken {
	const character = cursor.peek();
	const mark: CursorMark = cursor.mark();
	const prefixed = scanPrefixed(cursor, diagnostics);
	if (prefixed !== null) return prefixed;
	if (character === '"') return scanQuoted(cursor, '"', 1, diagnostics);
	if (character === "'") {
		if (isLifetime(cursor)) return scanLifetime(cursor);
		const token = tryCharacter(cursor, 1);
		if (token !== null) return token;
	}
	if (isIdentifierStart(character)) {
		const value = scanIdentifier(cursor);
		return makeToken(cursor, "identifier", value, cursor.span(mark));
	}
	if (isAsciiDigit(character)) {
		const number = scanNumber(cursor);
		return { ...makeToken(cursor, "number", cursor.textSince(mark), cursor.span(mark)), number };
	}
	const symbol = MULTI_SYMBOLS.find((candidate) => cursor.startsWith(candidate)) ?? character;
	cursor.take(symbol);
	return makeToken(cursor, "symbol", symbol, cursor.span(mark));
}

export function tokenize(source: string): ScanResult {
	const cursor = new SourceCursor(source);
	const tokens: RustToken[] = [];
	const comments: ScanComments = { spans: [], offsets: [] };
	const diagnostics: ScanDiagnostic[] = [];
	let guard = -1;

	cursor.take(BYTE_ORDER_MARK);
	if (isShebang(cursor)) {
		const mark = cursor.mark();
		readToLineEnd(cursor);
		addComment(cursor, comments, cursor.span(mark));
	}

	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("tokenizer failed to advance");
		guard = cursor.offset;
		if (scanTrivia(cursor, comments, diagnostics)) continue;
		tokens.push(scanToken(cursor, diagnostics));
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
		textOf: (start, end) => cursor.textOf(start, end),
	};
}
