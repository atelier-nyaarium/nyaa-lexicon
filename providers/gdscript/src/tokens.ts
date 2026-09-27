// Owns GDScript reference tokenization and token navigation.

import type { Range, TextCoordinates } from "@nyaa-lexicon/protocol";
import { Cursor, isIdentifierPart, isIdentifierStart } from "./cursor.js";
import type { ReferenceToken, SourceLine, StringSpan } from "./parse-model.js";
import { type ScannedSource, scanSource } from "./source-scan.js";

//////// Tokens

const BYTE_ORDER_MARK = "\uFEFF";

const referenceOperators = [
	"**=",
	">>=",
	"<<=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"->",
	":=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"**",
	"<<",
	">>",
	"++",
	"--",
];

export const referenceAssignmentOperators = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"<<=",
	">>=",
	"&=",
	"|=",
	"^=",
	":=",
]);

export const referenceKeywords = new Set([
	"and",
	"as",
	"await",
	"break",
	"class",
	"class_name",
	"const",
	"continue",
	"elif",
	"else",
	"enum",
	"extends",
	"false",
	"for",
	"func",
	"if",
	"in",
	"is",
	"match",
	"not",
	"null",
	"or",
	"pass",
	"return",
	"self",
	"signal",
	"static",
	"super",
	"true",
	"var",
	"void",
	"when",
	"while",
]);

export const referenceCallKeywords = new Set([
	"class",
	"class_name",
	"const",
	"enum",
	"extends",
	"for",
	"func",
	"if",
	"match",
	"return",
	"signal",
	"when",
	"while",
]);

function isDigit(character: string): boolean {
	return character >= "0" && character <= "9";
}

function isHexDigit(character: string): boolean {
	return isDigit(character) || (character >= "a" && character <= "f") || (character >= "A" && character <= "F");
}

function digitsFrom(cursor: Cursor, index: number, digit: (character: string) => boolean): number {
	let at = index;
	while (digit(cursor.peek(at)) || cursor.peek(at) === "_") at++;
	return at;
}

/** Godot's number grammar; 0 if none. */
function numberLength(cursor: Cursor): number {
	const first = cursor.peek();
	const base = first === "0" ? cursor.peek(1) : "";
	if (base === "x" || base === "X") return digitsFrom(cursor, 2, isHexDigit);
	if (base === "b" || base === "B")
		return digitsFrom(cursor, 2, (character) => character === "0" || character === "1");
	if (!isDigit(first) && !(first === "." && isDigit(cursor.peek(1)))) return 0;
	let at = isDigit(first) ? digitsFrom(cursor, 1, isDigit) : 0;
	// `..` is its own token.
	if (cursor.peek(at) === "." && cursor.peek(at + 1) !== ".") at = digitsFrom(cursor, at + 1, isDigit);
	if (cursor.peek(at) === "e" || cursor.peek(at) === "E") {
		const sign = cursor.peek(at + 1) === "+" || cursor.peek(at + 1) === "-" ? 1 : 0;
		const digits = at + 1 + sign;
		if (isDigit(cursor.peek(digits))) at = digitsFrom(cursor, digits, isDigit);
	}
	return at;
}

function stringText(lines: readonly SourceLine[], span: StringSpan): string {
	if (span.start.line === span.end.line)
		return (lines[span.start.line]?.text ?? "").slice(span.start.character, span.end.character);
	const parts = [(lines[span.start.line]?.text ?? "").slice(span.start.character)];
	for (let line = span.start.line + 1; line < span.end.line; line++) parts.push(lines[line]?.text ?? "");
	parts.push((lines[span.end.line]?.text ?? "").slice(0, span.end.character));
	return parts.join("\n");
}

export function referenceTokens(scanned: Pick<ScannedSource, "lines" | "strings">): ReferenceToken[] {
	const strings = new Map<string, StringSpan>();
	for (const span of scanned.strings) strings.set(`${span.start.line}:${span.start.character}`, span);
	const cursor = new Cursor(scanned.lines.map((line) => line.code).join("\n"));
	const tokens: ReferenceToken[] = [];
	while (cursor.good()) {
		const character = cursor.peek();
		const span = strings.get(`${cursor.line}:${cursor.column}`);
		if (span !== undefined) {
			const line = cursor.line;
			const column = cursor.column;
			while (cursor.good() && (cursor.line < span.end.line || cursor.column < span.end.character)) cursor.next();
			tokens.push({
				kind: "string",
				value: stringText(scanned.lines, span),
				line,
				character: column,
				string: span,
			});
			continue;
		}
		if (character === "\n") {
			const line = cursor.line;
			const column = cursor.column;
			cursor.next();
			tokens.push({ kind: "newline", value: "\n", line, character: column });
			continue;
		}
		if (character === " " || character === "\t" || character === "\r") {
			cursor.next();
			continue;
		}
		// A leading byte order mark is not code.
		if (cursor.offset === 0 && character === BYTE_ORDER_MARK) {
			cursor.next();
			continue;
		}
		const line = cursor.line;
		const column = cursor.column;
		const length = numberLength(cursor);
		if (length > 0) {
			let value = "";
			for (let index = 0; index < length; index++) value += cursor.next();
			tokens.push({ kind: "number", value, line, character: column });
			continue;
		}
		if (isIdentifierStart(character)) {
			let value = cursor.next();
			while (isIdentifierPart(cursor.peek())) value += cursor.next();
			tokens.push({ kind: "identifier", value, line, character: column });
			continue;
		}
		const operator = referenceOperators.find((candidate) =>
			candidate.split("").every((part, index) => cursor.peek(index) === part),
		);
		if (operator !== undefined) {
			for (let index = 0; index < operator.length; index++) cursor.next();
			tokens.push({ kind: "symbol", value: operator, line, character: column });
			continue;
		}
		tokens.push({ kind: "symbol", value: cursor.next(), line, character: column });
	}
	return tokens;
}

//////// Lexed source

/** A file's lines and tokens, indexed by line and position. */
export interface LexedSource {
	scanned: ScannedSource;
	lines: SourceLine[];
	tokens: ReferenceToken[];
	/** Indices of the code tokens starting on each line, newlines excluded. */
	lineTokens: number[][];
	/** Token index by `line:character`. */
	positions: Map<string, number>;
	/** Lines a comment starts on. */
	commentLines: Set<number>;
}

export function lexSource(text: string): LexedSource {
	const scanned = scanSource(text);
	const tokens = referenceTokens(scanned);
	const lineTokens = scanned.lines.map((): number[] => []);
	const positions = new Map<string, number>();
	tokens.forEach((token, index) => {
		if (token.kind === "newline") return;
		lineTokens[token.line]?.push(index);
		positions.set(`${token.line}:${token.character}`, index);
	});
	const commentLines = new Set(scanned.comments.map((comment) => comment.range.start.line));
	return { scanned, lines: scanned.lines, tokens, lineTokens, positions, commentLines };
}

export function tokenAt(lexed: LexedSource, line: number, character: number): number {
	return lexed.positions.get(`${line}:${character}`) ?? -1;
}

/** No code token starts on the line. */
export function isIgnorable(lexed: LexedSource, line: number): boolean {
	return (lexed.lineTokens[line]?.length ?? 0) === 0;
}

export function firstLineToken(lexed: LexedSource, line: number): ReferenceToken | undefined {
	const index = lexed.lineTokens[line]?.[0];
	return index === undefined ? undefined : lexed.tokens[index];
}

export function lastLineToken(lexed: LexedSource, line: number): ReferenceToken | undefined {
	const index = lexed.lineTokens[line]?.at(-1);
	return index === undefined ? undefined : lexed.tokens[index];
}

//////// Navigation

export function nextReferenceToken(tokens: ReferenceToken[], index: number): number {
	let next = index + 1;
	while (next < tokens.length && tokens[next]?.kind === "newline") next++;
	return next < tokens.length ? next : -1;
}

export function previousReferenceToken(tokens: ReferenceToken[], index: number): number {
	let previous = index - 1;
	while (previous >= 0 && tokens[previous]?.kind === "newline") previous--;
	return previous;
}

/** A declaration's initializer start, or -1. */
export function initializerStart(tokens: ReferenceToken[], name: number): number {
	const ends = new Set([";", ",", "in"]);
	let depth = 0;
	for (let index = name + 1; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		const top = depth === 0;
		if (top && (token.kind === "newline" || ends.has(token.value))) return -1;
		if (token.value === "(" || token.value === "[" || token.value === "{") depth++;
		else if (token.value === ")" || token.value === "]" || token.value === "}") {
			if (top) return -1;
			depth--;
		} else if (top && (token.value === "=" || token.value === ":=")) return nextReferenceToken(tokens, index);
	}
	return -1;
}

export function tokenRange(token: ReferenceToken): Range {
	return {
		start: { line: token.line, character: token.character },
		end: token.string?.end ?? { line: token.line, character: token.character + token.value.length },
	};
}

export function sourceBetween(
	coordinates: TextCoordinates,
	start: ReferenceToken,
	end: ReferenceToken,
): string | undefined {
	return coordinates.sliceRange({ start: tokenRange(start).start, end: tokenRange(end).end });
}

export function matchingReferenceToken(tokens: ReferenceToken[], start: number, open: string, close: string): number {
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === open) depth++;
		if (value === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}
