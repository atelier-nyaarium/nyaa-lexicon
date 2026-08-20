import type { CommentSpan, Diagnostic, Position, Range } from "@nyaa-lexicon/protocol";
import { Cursor, isHorizontalWhitespace } from "./cursor.js";

/** The protocol barrel does not export CommentSpan. */
export type { CommentSpan };

export type TokenKind = "identifier" | "number" | "string" | "char" | "symbol" | "newline" | "comment";

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
}

export interface LexedC {
	tokens: CToken[];
	/** Every comment the language defines, verbatim. */
	comments: CommentSpan[];
	diagnostics: Diagnostic[];
}

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

function range(start: Position, end: Position): Range {
	return { start, end };
}

function diagnostic(path: string, message: string, start: CursorMarkLike, end: CursorMarkLike): Diagnostic {
	return {
		severity: "error",
		message,
		path,
		range: range({ line: start.line, character: start.column }, { line: end.line, character: end.column }),
	};
}

function startsWith(cursor: Cursor, value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		if (cursor.peek(index) !== value[index]) return false;
	}
	return true;
}

function decodeEscape(cursor: Cursor): string {
	const escaped = cursor.next();
	if (escaped === "") return "";
	const simple: Record<string, string> = {
		"0": "\0",
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
		const digits = cursor.takeWhile((character) => /^[0-9A-Fa-f]$/u.test(character));
		const value = Number.parseInt(digits, 16);
		return digits === "" || !Number.isFinite(value) ? `\\${escaped}` : String.fromCodePoint(value);
	}
	if (/^[0-7]$/u.test(escaped)) {
		const digits = escaped + cursor.takeWhile((character) => /^[0-7]$/u.test(character)).slice(0, 2);
		const value = Number.parseInt(digits, 8);
		return Number.isFinite(value) ? String.fromCodePoint(value) : `\\${digits}`;
	}
	return `\\${escaped}`;
}

function readQuoted(cursor: Cursor, quote: "'" | '"'): { value: string; terminated: boolean; end: CursorMarkLike } {
	const value: string[] = [];
	let terminated = false;
	const triple = quote === '"' && cursor.peek(1) === quote && cursor.peek(2) === quote;
	if (triple) {
		cursor.next();
		cursor.next();
		cursor.next();
	} else {
		cursor.next();
	}
	while (cursor.good()) {
		if (triple && cursor.peek() === quote && cursor.peek(1) === quote && cursor.peek(2) === quote) {
			terminated = true;
			break;
		}
		if (!triple && cursor.peek() === quote) {
			terminated = true;
			break;
		}
		if (cursor.peek() === "\n" && !triple) break;
		if (cursor.peek() === "\\") {
			cursor.next();
			value.push(decodeEscape(cursor));
			continue;
		}
		value.push(cursor.next());
	}
	return { value: value.join(""), terminated, end: cursor.mark() };
}

interface CursorMarkLike {
	offset: number;
	line: number;
	column: number;
}

/** Backslash-newline continues a line comment onto the next line. */
function continuesLine(cursor: Cursor): boolean {
	if (cursor.peek() !== "\\") return false;
	return cursor.peek(1) === "\n" || (cursor.peek(1) === "\r" && cursor.peek(2) === "\n");
}

function readLineComment(cursor: Cursor): { value: string; end: CursorMarkLike } {
	cursor.next();
	cursor.next();
	let value = "";
	while (cursor.good() && cursor.peek() !== "\n") {
		if (continuesLine(cursor)) {
			value += cursor.next();
			if (cursor.peek() === "\r") value += cursor.next();
		}
		value += cursor.next();
	}
	return { value, end: cursor.mark() };
}

/** Comment values carry newlines, so suffix positions are walked rather than added. */
function advanced(mark: CursorMarkLike, text: string): CursorMarkLike {
	let { offset, line, column } = mark;
	for (const character of text) {
		offset += character.length;
		if (character === "\n") {
			line++;
			column = 0;
			continue;
		}
		column += character.length;
	}
	return { offset, line, column };
}

interface LineCommentInfo {
	value: string;
	start: CursorMarkLike;
	end: CursorMarkLike;
}

interface TokenRead {
	token?: CToken;
	lineStart: boolean;
	lineComment?: LineCommentInfo;
}

function ghidraWarningTokens(
	module: string,
	cursor: Cursor,
	comment: LineCommentInfo,
): { tokens: CToken[]; diagnostics: Diagnostic[] } {
	const marker = "WARNING: Load size is inaccurate";
	const markerEnd = comment.value.indexOf(marker);
	if (markerEnd < 0) return { tokens: [], diagnostics: [] };

	const suffixStart = advanced(comment.start, `//${comment.value.slice(0, markerEnd + marker.length)}`);
	const saved = cursor.mark();
	const tokens: CToken[] = [];
	const diagnostics: Diagnostic[] = [];
	let lineStart = false;
	let guard = -1;

	try {
		cursor.rewind(suffixStart);
		cursor.withLimit(comment.end.offset, () => {
			while (cursor.good()) {
				if (cursor.offset <= guard) throw new Error("C lexer failed to advance");
				guard = cursor.offset;
				const result = readToken(module, cursor, lineStart, diagnostics);
				if (result.token !== undefined) tokens.push(result.token);
				lineStart = result.lineStart;
			}
		});
	} finally {
		cursor.rewind(saved);
	}

	return { tokens, diagnostics };
}

function readBlockComment(cursor: Cursor): { value: string; terminated: boolean; end: CursorMarkLike } {
	cursor.next();
	cursor.next();
	let value = "";
	let terminated = false;
	while (cursor.good()) {
		if (cursor.peek() === "*" && cursor.peek(1) === "/") {
			terminated = true;
			break;
		}
		value += cursor.next();
	}
	return { value, terminated, end: cursor.mark() };
}

function docText(kind: "line" | "block", value: string): string | undefined {
	if (kind === "line") {
		if (!value.startsWith("/") && !value.startsWith("!")) return undefined;
		const content = value.startsWith("/") ? value.slice(1) : value.slice(1);
		return content.trim();
	}
	if (!value.startsWith("*") && !value.startsWith("!")) return undefined;
	const source = value.startsWith("*") ? value.slice(1) : value.slice(1);
	const lines = source.split("\n").map((line) => line.replace(/^\s*\* ?/u, "").trimEnd());
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines.join("\n").trim() || undefined;
}

function makeToken(
	kind: TokenKind,
	value: string,
	raw: string,
	start: CursorMarkLike,
	end: CursorMarkLike,
	lineStart: boolean,
	extra: Pick<CToken, "doc" | "unterminated"> = {},
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

function readNumber(cursor: Cursor): string {
	let value = "";
	let previous = "";
	while (cursor.good()) {
		const character = cursor.peek();
		if (/^[A-Za-z0-9_.]$/u.test(character) || character === "_") {
			value += cursor.next();
			previous = character;
			continue;
		}
		if ((character === "+" || character === "-") && /^[eEpP]$/u.test(previous)) {
			value += cursor.next();
			previous = character;
			continue;
		}
		break;
	}
	return value;
}

function symbolAt(cursor: Cursor): string {
	for (const candidate of MULTI_SYMBOLS) if (startsWith(cursor, candidate)) return candidate;
	return cursor.peek();
}

function isNumberStart(cursor: Cursor): boolean {
	if (/^[0-9]$/u.test(cursor.peek())) return true;
	return cursor.peek() === "." && /^[0-9]$/u.test(cursor.peek(1));
}

function readToken(module: string, cursor: Cursor, lineStart: boolean, diagnostics: Diagnostic[]): TokenRead {
	const character = cursor.peek();
	if (character === "\n") {
		const start = cursor.mark();
		cursor.next();
		return { token: makeToken("newline", "\n", "\n", start, cursor.mark(), lineStart), lineStart: true };
	}
	if (isHorizontalWhitespace(character)) {
		cursor.next();
		return { lineStart };
	}
	if (character === "/" && cursor.peek(1) === "/") {
		const start = cursor.mark();
		const comment = readLineComment(cursor);
		const lineComment = { value: comment.value, start, end: comment.end };
		const raw = cursor.slice(start.offset, comment.end.offset);
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
			lineStart,
			lineComment,
		};
	}
	if (character === "/" && cursor.peek(1) === "*") {
		const start = cursor.mark();
		const comment = readBlockComment(cursor);
		if (comment.terminated) {
			cursor.next();
			cursor.next();
		}
		const end = cursor.mark();
		const raw = cursor.slice(start.offset, end.offset);
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
				comment.terminated
					? doc === undefined
						? {}
						: { doc }
					: { unterminated: true, ...(doc === undefined ? {} : { doc }) },
			),
			lineStart: end.column === 0,
		};
	}
	if (character === '"' || character === "'") {
		const start = cursor.mark();
		const quote = character as '"' | "'";
		const quoted = readQuoted(cursor, quote);
		if (quoted.terminated) {
			cursor.next();
			if (quote === '"' && cursor.peek() === quote && cursor.peek(1) === quote) {
				cursor.next();
				cursor.next();
			}
		}
		const raw = cursor.slice(start.offset, cursor.offset);
		const kind: TokenKind = quote === '"' ? "string" : "char";
		if (!quoted.terminated) {
			diagnostics.push(diagnostic(module, "String literal has no closing quote.", start, cursor.mark()));
		}
		return {
			token: makeToken(
				kind,
				quoted.value,
				raw,
				start,
				cursor.mark(),
				lineStart,
				quoted.terminated ? {} : { unterminated: true },
			),
			lineStart: false,
		};
	}
	const identifier = cursor.readIdentifier();
	if (identifier !== null) {
		return {
			token: makeToken(
				"identifier",
				identifier.name,
				cursor.slice(identifier.start.offset, identifier.end.offset),
				identifier.start,
				identifier.end,
				lineStart,
			),
			lineStart: false,
		};
	}
	if (isNumberStart(cursor)) {
		const start = cursor.mark();
		const value = readNumber(cursor);
		return { token: makeToken("number", value, value, start, cursor.mark(), lineStart), lineStart: false };
	}
	const start = cursor.mark();
	const value = symbolAt(cursor);
	if (value === "") {
		cursor.next();
		return { lineStart };
	}
	for (let index = 0; index < value.length; index++) cursor.next();
	return { token: makeToken("symbol", value, value, start, cursor.mark(), lineStart), lineStart: false };
}

export function lexC(module: string, text: string): LexedC {
	const cursor = new Cursor(text);
	const tokens: CToken[] = [];
	// Only this loop sees comments: a marker retokenized inside one is not a second comment.
	const comments: CommentSpan[] = [];
	const diagnostics: Diagnostic[] = [];
	let lineStart = true;
	let guard = -1;

	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("C lexer failed to advance");
		guard = cursor.offset;
		const result = readToken(module, cursor, lineStart, diagnostics);
		if (result.token !== undefined) {
			tokens.push(result.token);
			if (result.token.kind === "comment")
				comments.push({ range: tokenRange(result.token), text: result.token.raw });
		}
		lineStart = result.lineStart;
		if (result.lineComment !== undefined) {
			const warning = ghidraWarningTokens(module, cursor, result.lineComment);
			tokens.push(...warning.tokens);
			diagnostics.push(...warning.diagnostics);
			if (warning.tokens.length > 0) lineStart = false;
		}
	}

	return { tokens, comments, diagnostics };
}

export function tokenRange(token: CToken): Range {
	return { start: token.start, end: token.end };
}

export function significant(tokens: CToken[], index: number): number {
	let next = index;
	while (next < tokens.length) {
		const token = tokens[next] as CToken;
		if (token.kind !== "comment" && token.kind !== "newline") return next;
		next++;
	}
	return -1;
}

export function previousSignificant(tokens: CToken[], index: number): number {
	let previous = index - 1;
	while (previous >= 0) {
		const token = tokens[previous] as CToken;
		if (token.kind !== "comment" && token.kind !== "newline") return previous;
		previous--;
	}
	return -1;
}

export function sameLine(left: CToken, right: CToken): boolean {
	return left.start.line === right.start.line;
}
