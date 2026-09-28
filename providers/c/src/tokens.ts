import {
	type CommentSpan,
	type CursorMark,
	type Diagnostic,
	defined,
	type OffsetRange,
	type Position,
	type Range,
	SourceCursor,
} from "@nyaa-lexicon/protocol";
import {
	isDigit,
	isHexDigit,
	isHorizontalWhitespace,
	isIdentifierPart,
	isIdentifierStart,
	isNumberPart,
	isOctalDigit,
} from "./characters.js";
import { resolveConditionals } from "./conditionals.js";
import { tokenRange, widened } from "./tokenWalk.js";

////////////////////////////////
//  Interfaces & Types

export type TokenKind = "identifier" | "number" | "string" | "char" | "symbol" | "newline" | "comment";

/** `ghidra` reads code after Ghidra's load warning. */
export type Dialect = "c" | "ghidra";

export interface CToken {
	kind: TokenKind;
	value: string;
	raw: string;
	start: Position;
	end: Position;
	startOffset: number;
	endOffset: number;
	lineStart: boolean;
	doc?: string;
	unterminated?: boolean;
	/** What lies just before and is not code: splices and a removed branch's tokens. */
	hiddenBefore?: OffsetRange;
	/** Splices inside it; its value leaves them out. */
	splices?: OffsetRange[];
	/** Nothing but line splices since the token before, so the two touch once spliced. */
	touching?: true;
}

export interface LexedC {
	tokens: CToken[];
	/** Every comment the language defines, verbatim. */
	comments: CommentSpan[];
	/** Lines no token touches, a removed branch's tokens included. */
	blankLines: number[];
	diagnostics: Diagnostic[];
	/** The Ghidra dialect reads these tokens differently. */
	ghidraDiffers: boolean;
}

////////////////////////////////
//  Constants

const MULTI_SYMBOLS = [
	"<<=",
	">>=",
	"...",
	"::",
	"->",
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
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"<<",
	">>",
	"##",
] as const;

const MAX_SYMBOL_LENGTH = Math.max(...MULTI_SYMBOLS.map((symbol) => symbol.length));

/** MULTI_SYMBOLS by first character, longest first. */
const MULTI_SYMBOLS_BY_START: ReadonlyMap<string, readonly string[]> = new Map(
	MULTI_SYMBOLS.map((symbol) => [symbol[0] as string, MULTI_SYMBOLS.filter((other) => other[0] === symbol[0])]),
);

////////////////////////////////
//  Functions & Helpers

function range(start: Position, end: Position): Range {
	return { start, end };
}

function diagnostic(path: string, message: string, start: CursorMark, end: CursorMark): Diagnostic {
	return {
		severity: "error",
		message,
		path,
		range: range({ line: start.line, character: start.column }, { line: end.line, character: end.column }),
	};
}

/** Up to `limit` characters `accepts` takes, read one at a time. */
function readUpTo(cursor: SourceCursor, limit: number, accepts: (character: string) => boolean): string {
	let digits = "";
	let guard = -1;
	while (digits.length < limit && accepts(cursor.peek())) {
		if (cursor.offset <= guard) throw new Error("C escape scan failed to advance");
		guard = cursor.offset;
		digits += cursor.next();
	}
	return digits;
}

/** The character a numeric escape names, or its spelling when none can. */
function codePointOf(value: number, spelling: string): string {
	return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : spelling;
}

function decodeEscape(cursor: SourceCursor): string {
	const escaped = cursor.next();
	if (escaped === "") return "";
	const simple: Record<string, string> = {
		a: "\x07",
		b: "\b",
		e: "\x1b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
		"\\": "\\",
		'"': '"',
		"'": "'",
		"?": "?",
	};
	const replacement = simple[escaped];
	if (replacement !== undefined) return replacement;
	if (escaped === "x") {
		const digits = cursor.readWhile(isHexDigit);
		return digits === "" ? "\\x" : codePointOf(Number.parseInt(digits, 16), `\\x${digits}`);
	}
	if (escaped === "u" || escaped === "U") {
		const width = escaped === "u" ? 4 : 8;
		const digits = readUpTo(cursor, width, isHexDigit);
		const spelling = `\\${escaped}${digits}`;
		return digits.length === width ? codePointOf(Number.parseInt(digits, 16), spelling) : spelling;
	}
	if (isOctalDigit(escaped)) {
		const digits = escaped + readUpTo(cursor, 2, isOctalDigit);
		return codePointOf(Number.parseInt(digits, 8), `\\${digits}`);
	}
	return `\\${escaped}`;
}

function readQuoted(
	cursor: SourceCursor,
	quote: "'" | '"',
): { value: string; terminated: boolean; splices: OffsetRange[] } {
	const value: string[] = [];
	const splices: OffsetRange[] = [];
	let terminated = false;
	let guard = -1;
	cursor.next();
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("C quoted literal scan failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === quote) {
			terminated = true;
			break;
		}
		if (cursor.peek() === "\n") break;
		if (continuesLine(cursor)) {
			splices.push(takeSplice(cursor));
			continue;
		}
		if (cursor.peek() === "\\") {
			cursor.next();
			value.push(decodeEscape(cursor));
			continue;
		}
		value.push(cursor.next());
	}
	return { value: value.join(""), terminated, splices };
}

////////////////////////////////
//  Interfaces & Types

interface LineCommentInfo {
	value: string;
	end: CursorMark;
	/** Ghidra's warning with code after it, which the Ghidra dialect reads as code. */
	codeAfterWarning: boolean;
	/** Ended at the warning, so the code after it is read next. */
	cut: boolean;
}

interface TokenRead {
	token?: CToken;
	lineStart: boolean;
	lineComment?: LineCommentInfo;
	/** A splice between tokens, deleted. */
	splice?: OffsetRange;
}

////////////////////////////////
//  Constants

const GHIDRA_WARNING = "WARNING: Load size is inaccurate";

const ENCODING_PREFIXES: ReadonlySet<string> = new Set(["L", "u", "U", "u8"]);

/** Not code, so a comment after it has none before it. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

////////////////////////////////
//  Functions & Helpers

/** The width of a line splice `ahead` of the cursor; zero for none. */
function spliceWidth(cursor: SourceCursor, ahead: number): number {
	if (cursor.peek(ahead) !== "\\") return 0;
	if (cursor.peek(ahead + 1) === "\n") return 2;
	return cursor.peek(ahead + 1) === "\r" && cursor.peek(ahead + 2) === "\n" ? 3 : 0;
}

/** Backslash-newline: a line splice, which translation phase two deletes. */
function continuesLine(cursor: SourceCursor): boolean {
	return spliceWidth(cursor, 0) > 0;
}

/** Up to `length` characters ahead, with line splices deleted. */
function joinedAhead(cursor: SourceCursor, length: number): string {
	let text = "";
	let ahead = 0;
	let guard = -1;
	while (text.length < length) {
		if (ahead <= guard) throw new Error("C splice lookahead failed to advance");
		guard = ahead;
		const width = spliceWidth(cursor, ahead);
		if (width > 0) {
			ahead += width;
			continue;
		}
		const character = cursor.peek(ahead);
		if (character === "") break;
		text += character;
		ahead += character.length;
	}
	return text;
}

/** Past `text`, which `joinedAhead` saw, and the splices inside it. */
function takeJoined(cursor: SourceCursor, text: string): OffsetRange[] {
	const splices: OffsetRange[] = [];
	for (let index = 0; index < text.length; ) {
		if (index > 0 && continuesLine(cursor)) splices.push(...takeSplices(cursor));
		const character = cursor.next();
		if (character === "" || !text.startsWith(character, index))
			throw new Error("C spliced text does not match what was seen");
		index += character.length;
	}
	return splices;
}

/** Past every splice at the cursor. */
function takeSplices(cursor: SourceCursor): OffsetRange[] {
	const splices: OffsetRange[] = [];
	let guard = -1;
	while (continuesLine(cursor)) {
		if (cursor.offset <= guard) throw new Error("C splice scan failed to advance");
		guard = cursor.offset;
		splices.push(takeSplice(cursor));
	}
	return splices;
}

/** Past the splice `continuesLine` saw, and where it was. */
function takeSplice(cursor: SourceCursor): OffsetRange {
	const start = cursor.offset;
	cursor.next();
	if (cursor.peek() === "\r") cursor.next();
	cursor.next();
	return { start, end: cursor.offset };
}

/** The character after the splice at the cursor. */
function afterSplice(cursor: SourceCursor): string {
	return cursor.peek(1) === "\n" ? cursor.peek(2) : cursor.peek(3);
}

/** A run of `accepts` characters, joined across splices; the text without them, and where they were. */
function readJoined(
	cursor: SourceCursor,
	accepts: (character: string) => boolean,
): { value: string; splices: OffsetRange[] } {
	let value = "";
	const splices: OffsetRange[] = [];
	let guard = -1;
	for (;;) {
		if (cursor.offset <= guard) throw new Error("C word scan failed to advance");
		guard = cursor.offset;
		value += cursor.readWhile(accepts);
		if (!continuesLine(cursor) || !accepts(afterSplice(cursor))) return { value, splices };
		splices.push(takeSplice(cursor));
	}
}

/** A CRLF carriage return ends the line, so it is not comment text. */
function endsLine(cursor: SourceCursor): boolean {
	return cursor.peek() === "\n" || (cursor.peek() === "\r" && cursor.peek(1) === "\n");
}

/** To its line's end; in the Ghidra dialect, to Ghidra's warning, since the code Ghidra writes after it is code. */
function readLineComment(cursor: SourceCursor, dialect: Dialect): LineCommentInfo {
	takeJoined(cursor, "//");
	let value = "";
	let warned = false;
	let codeAfterWarning = false;
	let guard = -1;
	while (cursor.good() && !endsLine(cursor)) {
		if (cursor.offset <= guard) throw new Error("C line comment scan failed to advance");
		guard = cursor.offset;
		if (!warned && cursor.peek() === GHIDRA_WARNING[0] && cursor.take(GHIDRA_WARNING)) {
			value += GHIDRA_WARNING;
			warned = true;
			if (dialect === "ghidra") return { value, end: cursor.mark(), codeAfterWarning, cut: true };
			continue;
		}
		if (continuesLine(cursor)) {
			value += cursor.next();
			if (cursor.peek() === "\r") value += cursor.next();
			value += cursor.next();
			continue;
		}
		const character = cursor.next();
		codeAfterWarning ||= warned && !isHorizontalWhitespace(character);
		value += character;
	}
	return { value, end: cursor.mark(), codeAfterWarning, cut: false };
}

/** Through its terminator, when it has one. */
function readBlockComment(cursor: SourceCursor): { value: string; terminated: boolean; end: CursorMark } {
	takeJoined(cursor, "/*");
	let value = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("C block comment scan failed to advance");
		guard = cursor.offset;
		if (cursor.peek() === "*" && joinedAhead(cursor, 2) === "*/") {
			takeJoined(cursor, "*/");
			return { value, terminated: true, end: cursor.mark() };
		}
		value += cursor.next();
	}
	return { value, terminated: false, end: cursor.mark() };
}

function docText(kind: "line" | "block", value: string): string | undefined {
	if (kind === "line") {
		if (!value.startsWith("/") && !value.startsWith("!")) return undefined;
		return value.slice(1).trim();
	}
	if (!value.startsWith("*") && !value.startsWith("!")) return undefined;
	const lines = value
		.slice(1)
		.split("\n")
		.map((line) => line.replace(/^\s*\* ?/u, "").trimEnd());
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines.join("\n").trim() || undefined;
}

function makeToken(
	kind: TokenKind,
	value: string,
	raw: string,
	start: CursorMark,
	end: CursorMark,
	lineStart: boolean,
	extra: Pick<CToken, "doc" | "unterminated" | "splices"> = {},
): CToken {
	return {
		kind,
		value,
		raw,
		start: { line: start.line, character: start.column },
		end: { line: end.line, character: end.column },
		startOffset: start.offset,
		endOffset: end.offset,
		lineStart,
		...extra,
	};
}

function readNumber(cursor: SourceCursor): { value: string; splices: OffsetRange[] } {
	let value = "";
	let previous = "";
	const splices: OffsetRange[] = [];
	const continues = (character: string) =>
		isNumberPart(character) || ((character === "+" || character === "-") && /^[eEpP]$/u.test(previous));
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("C number scan failed to advance");
		guard = cursor.offset;
		const character = cursor.peek();
		if (continues(character)) {
			value += cursor.next();
			previous = character;
		} else if (continuesLine(cursor) && continues(afterSplice(cursor))) splices.push(takeSplice(cursor));
		else break;
	}
	return { value, splices };
}

/** The longest punctuator at the cursor, matched through splices. */
function symbolAt(cursor: SourceCursor): string {
	const first = cursor.peek();
	const candidates = MULTI_SYMBOLS_BY_START.get(first);
	if (candidates === undefined) return first;
	// Without a backslash in reach, no splice can split a candidate.
	const spliced = cursor.peek(1) === "\\" || cursor.peek(2) === "\\";
	const ahead = spliced ? joinedAhead(cursor, MAX_SYMBOL_LENGTH) : "";
	const found = candidates.find((candidate) =>
		spliced ? ahead.startsWith(candidate) : cursor.startsWith(candidate),
	);
	return found ?? first;
}

function isNumberStart(cursor: SourceCursor): boolean {
	if (isDigit(cursor.peek())) return true;
	return cursor.peek() === "." && isDigit(cursor.peek(1));
}

/** A string or character literal from `start`, its encoding prefix and the splices in it (`leading`) included; the cursor is at its quote. */
function quotedToken(
	module: string,
	cursor: SourceCursor,
	start: CursorMark,
	lineStart: boolean,
	diagnostics: Diagnostic[],
	leading: readonly OffsetRange[] = [],
): CToken {
	const quote = cursor.peek() as '"' | "'";
	const quoted = readQuoted(cursor, quote);
	const splices = [...leading, ...quoted.splices];
	if (quoted.terminated) cursor.next();
	else diagnostics.push(diagnostic(module, "String literal has no closing quote.", start, cursor.mark()));
	return makeToken(
		quote === '"' ? "string" : "char",
		quoted.value,
		cursor.textSince(start),
		start,
		cursor.mark(),
		lineStart,
		{
			...(quoted.terminated ? {} : { unterminated: true }),
			...(splices.length === 0 ? {} : { splices }),
		},
	);
}

/** A name or number token whose text may run across splices. */
function wordToken(
	kind: "identifier" | "number",
	read: { value: string; splices: OffsetRange[] },
	cursor: SourceCursor,
	start: CursorMark,
	lineStart: boolean,
): CToken {
	const extra = read.splices.length === 0 ? {} : { splices: read.splices };
	return makeToken(kind, read.value, cursor.textSince(start), start, cursor.mark(), lineStart, extra);
}

function readToken(
	module: string,
	cursor: SourceCursor,
	lineStart: boolean,
	diagnostics: Diagnostic[],
	dialect: Dialect,
): TokenRead {
	const character = cursor.peek();
	if (continuesLine(cursor)) return { lineStart, splice: takeSplice(cursor) };
	if (character === "\n") {
		const start = cursor.mark();
		cursor.next();
		return { token: makeToken("newline", "\n", "\n", start, cursor.mark(), lineStart), lineStart: true };
	}
	if (isHorizontalWhitespace(character)) {
		cursor.next();
		return { lineStart };
	}
	const opener = character === "/" ? joinedAhead(cursor, 2) : "";
	if (opener === "//") {
		const start = cursor.mark();
		const comment = readLineComment(cursor, dialect);
		const raw = cursor.textSince(start);
		const doc = docText("line", comment.value);
		return {
			token: makeToken(
				"comment",
				comment.value,
				raw,
				start,
				comment.end,
				lineStart,
				doc === undefined ? {} : { doc },
			),
			// Ghidra's code after its warning never starts a directive.
			lineStart: lineStart && !comment.cut,
			lineComment: comment,
		};
	}
	if (opener === "/*") {
		const start = cursor.mark();
		const comment = readBlockComment(cursor);
		const end = cursor.mark();
		const raw = cursor.textSince(start);
		const doc = docText("block", comment.value);
		if (!comment.terminated) {
			diagnostics.push(diagnostic(module, "Block comment has no closing delimiter.", start, comment.end));
		}
		return {
			token: makeToken(
				"comment",
				comment.value,
				raw,
				start,
				end,
				lineStart,
				comment.terminated ? (doc === undefined ? {} : { doc }) : { unterminated: true, ...defined({ doc }) },
			),
			lineStart: end.column === 0,
		};
	}
	if (character === '"' || character === "'") {
		return { token: quotedToken(module, cursor, cursor.mark(), lineStart, diagnostics), lineStart: false };
	}
	if (isIdentifierStart(character)) {
		const start = cursor.mark();
		const name = readJoined(cursor, isIdentifierPart);
		// A prefix and its quote join across splices, as the rest of a token does.
		if (ENCODING_PREFIXES.has(name.value) && ['"', "'"].includes(joinedAhead(cursor, 1))) {
			const leading = [...name.splices, ...takeSplices(cursor)];
			return { token: quotedToken(module, cursor, start, lineStart, diagnostics, leading), lineStart: false };
		}
		return { token: wordToken("identifier", name, cursor, start, lineStart), lineStart: false };
	}
	if (isNumberStart(cursor)) {
		const start = cursor.mark();
		return { token: wordToken("number", readNumber(cursor), cursor, start, lineStart), lineStart: false };
	}
	const start = cursor.mark();
	const value = symbolAt(cursor);
	if (value === "") {
		cursor.next();
		return { lineStart };
	}
	const splices = value.length === 1 ? undefined : takeJoined(cursor, value);
	if (splices === undefined) cursor.next();
	const spliced = splices !== undefined && splices.length > 0;
	return {
		token: makeToken(
			"symbol",
			value,
			spliced ? cursor.textSince(start) : value,
			start,
			cursor.mark(),
			lineStart,
			spliced ? { splices } : {},
		),
		lineStart: false,
	};
}

/** A token's last line; one ending at a line's start ends on the line before. */
function lastLine(token: CToken): number {
	return token.end.character === 0 && token.end.line > token.start.line ? token.end.line - 1 : token.end.line;
}

function isCode(token: CToken): boolean {
	return token.kind !== "comment" && token.kind !== "newline";
}

/** Whether code shares a comment's first line before it or last line after it. */
function commentSpans(read: readonly CToken[]): CommentSpan[] {
	const following: Array<CToken | undefined> = new Array(read.length);
	let next: CToken | undefined;
	for (let index = read.length - 1; index >= 0; index--) {
		following[index] = next;
		const token = read[index] as CToken;
		if (isCode(token)) next = token;
	}
	const spans: CommentSpan[] = [];
	let previous: CToken | undefined;
	for (let index = 0; index < read.length; index++) {
		const token = read[index] as CToken;
		if (isCode(token)) previous = token;
		if (token.kind !== "comment") continue;
		const after = following[index];
		spans.push({
			range: tokenRange(token),
			text: token.raw,
			codeBefore: previous !== undefined && lastLine(previous) === token.start.line,
			codeAfter: after !== undefined && after.start.line === lastLine(token),
		});
	}
	return spans;
}

/** Lines of `lineCount` that no token touches and no splice ends. */
function blankLinesOf(read: readonly CToken[], splicedLines: readonly number[], lineCount: number): number[] {
	const touched = new Array<boolean>(lineCount).fill(false);
	for (const line of splicedLines) touched[line] = true;
	for (const token of read) {
		if (token.kind === "newline") continue;
		for (let line = token.start.line; line <= lastLine(token); line++) touched[line] = true;
	}
	const blank: number[] = [];
	for (let line = 0; line < lineCount; line++) if (touched[line] !== true) blank.push(line);
	return blank;
}

/** A Ghidra line's comment as the C dialect reads it: its `//` to `endOffset`, the code after the warning included. */
function wholeLine(cursor: SourceCursor, cut: CToken, endOffset: number, end: Position): CToken {
	const after = cursor.textOf(cut.endOffset, endOffset);
	const start = { offset: cut.startOffset, line: cut.start.line, column: cut.start.character };
	const through = { offset: endOffset, line: end.line, column: end.character };
	return makeToken("comment", cut.value + after, cut.raw + after, start, through, cut.lineStart);
}

export function lexC(module: string, text: string, dialect: Dialect = "c"): LexedC {
	const cursor = new SourceCursor(text);
	const tokens: CToken[] = [];
	// The language's own reading, for comments and blank lines: a Ghidra line stays one comment.
	const read: CToken[] = [];
	const diagnostics: Diagnostic[] = [];
	let lineStart = true;
	let guard = -1;
	let ghidraDiffers = false;
	let hidden: OffsetRange | undefined;
	// Whitespace since the last token, so the next does not touch it.
	let spaced = true;
	// A comment cut at Ghidra's warning, while the code after it on its line is read.
	let cut: CToken | undefined;
	const splicedLines: number[] = [];

	if (cursor.peek() === BYTE_ORDER_MARK) cursor.next();
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("C lexer failed to advance");
		guard = cursor.offset;
		const line = cursor.line;
		const result = readToken(module, cursor, lineStart, diagnostics, dialect);
		if (result.splice !== undefined) {
			splicedLines.push(line);
			// The backslash alone: its line break still separates.
			hidden = widened(hidden, { start: result.splice.start, end: result.splice.start + 1 });
		} else if (result.token === undefined) spaced = true;
		if (result.token !== undefined) {
			// Fresh from readToken, so it is this loop's to finish.
			const token = result.token;
			if (hidden !== undefined) token.hiddenBefore = hidden;
			if (!spaced) token.touching = true;
			hidden = undefined;
			spaced = false;
			tokens.push(token);
			if (cut !== undefined && token.kind === "newline") {
				read.push(wholeLine(cursor, cut, token.startOffset, token.start));
				cut = undefined;
			}
			if (cut === undefined && result.lineComment?.cut === true) cut = token;
			else if (cut === undefined) read.push(token);
		}
		lineStart = result.lineStart;
		if (result.lineComment?.codeAfterWarning === true) ghidraDiffers = true;
	}
	if (cut !== undefined) read.push(wholeLine(cursor, cut, cursor.offset, cursor.position));

	const resolved = resolveConditionals(module, tokens, diagnostics);
	const kept = new Set<string>();
	for (const token of resolved) {
		if (token.kind === "comment") kept.add(`${token.start.line}:${token.start.character}`);
	}
	return {
		tokens: resolved,
		comments: commentSpans(read).filter((comment) =>
			kept.has(`${comment.range.start.line}:${comment.range.start.character}`),
		),
		blankLines: blankLinesOf(read, splicedLines, cursor.line + (cursor.column > 0 ? 1 : 0)),
		diagnostics,
		ghidraDiffers,
	};
}
