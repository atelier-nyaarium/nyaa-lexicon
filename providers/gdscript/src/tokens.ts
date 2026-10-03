// Owns the lexed source's indices and token navigation.

import type { Range, TextCoordinates } from "@nyaa-lexicon/protocol";
import { type Lexed, lexGdscript } from "./lexer.js";
import type { ReferenceToken } from "./parse-model.js";

//////// Tokens

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

//////// Lexed source

/** A file's lines and tokens, indexed by line and position. */
export interface LexedSource extends Lexed {
	/** Indices of the code tokens starting on each line, newlines excluded. */
	lineTokens: number[][];
	/** Token index by `line:character`. */
	positions: Map<string, number>;
	/** Lines a comment starts on. */
	commentLines: Set<number>;
}

export function lexSource(text: string): LexedSource {
	const lexed = lexGdscript(text);
	const lineTokens = lexed.lines.map((): number[] => []);
	const positions = new Map<string, number>();
	lexed.tokens.forEach((token, index) => {
		if (token.kind === "newline") return;
		lineTokens[token.line]?.push(index);
		positions.set(`${token.line}:${token.character}`, index);
	});
	const commentLines = new Set(lexed.comments.map((comment) => comment.range.start.line));
	return { ...lexed, lineTokens, positions, commentLines };
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

/** A line-joining backslash. */
export function isContinuation(token: ReferenceToken | undefined): boolean {
	return token?.kind === "symbol" && token.value === "\\";
}

/** A newline or a continuation: no code. */
export function isLineBreak(token: ReferenceToken | undefined): boolean {
	return token?.kind === "newline" || isContinuation(token);
}

export function nextReferenceToken(tokens: ReferenceToken[], index: number): number {
	let next = index + 1;
	while (next < tokens.length && isLineBreak(tokens[next])) next++;
	return next < tokens.length ? next : -1;
}

export function previousReferenceToken(tokens: ReferenceToken[], index: number): number {
	let previous = index - 1;
	while (previous >= 0 && isLineBreak(tokens[previous])) previous--;
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
