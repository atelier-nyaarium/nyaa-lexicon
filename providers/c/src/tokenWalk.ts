// Walks over a C token list: code neighbors, qualified names, ranges and doc comments.

import { comparePositions, type OffsetRange, type Range } from "@nyaa-lexicon/protocol";
import type { DescriptorPath, QualifiedName } from "./model.js";
import type { CToken, TokenKind } from "./tokens.js";
import { isIdentifierToken } from "./words.js";

////////////////////////////////
//  Constants

/**
 * Whether a token's text is syntax rather than data.
 *
 * Keyed by TokenKind, so a new kind must declare itself instead of defaulting into the parser.
 */
const CARRIES_SYNTAX: Record<TokenKind, boolean> = {
	identifier: true,
	number: true,
	symbol: true,
	newline: true,
	string: false,
	char: false,
	comment: false,
};

////////////////////////////////
//  Functions & Helpers

/** A token's text as syntax, empty for the kinds whose text is content the program merely holds. */
export function syntaxValue(token: CToken | undefined): string {
	if (token === undefined) return "";
	return CARRIES_SYNTAX[token.kind] ? token.value : "";
}

export function tokenValue(tokens: CToken[], index: number): string {
	return syntaxValue(tokens[index]);
}

export function nextCode(tokens: CToken[], index: number, end = tokens.length): number {
	let current = index;
	while (current < end) {
		const token = tokens[current] as CToken;
		if (token.kind !== "comment" && token.kind !== "newline") return current;
		current++;
	}
	return end;
}

export function previousCode(tokens: CToken[], index: number): number {
	let current = index - 1;
	while (current >= 0) {
		const token = tokens[current] as CToken;
		if (token.kind !== "comment" && token.kind !== "newline") return current;
		current--;
	}
	return -1;
}

export function qualifiedNameAt(tokens: CToken[], start: number, end: number): QualifiedName | undefined {
	const startIndex = nextCode(tokens, start, end);
	let index = startIndex;
	const leading = tokenValue(tokens, index) === "::";
	if (leading) index = nextCode(tokens, index + 1, end);
	if (!isIdentifierToken(tokens[index])) return undefined;
	const first = index;
	const parts: string[] = [];
	const identifierIndices: number[] = [];
	let last = index;
	while (index < end) {
		const token = tokens[index];
		if (!isIdentifierToken(token)) break;
		parts.push(token.value);
		identifierIndices.push(index);
		last = index;
		const separator = nextCode(tokens, index + 1, end);
		if (tokenValue(tokens, separator) !== "::") break;
		const next = nextCode(tokens, separator + 1, end);
		if (!isIdentifierToken(tokens[next])) break;
		index = next;
	}
	return {
		name: `${leading ? "::" : ""}${parts.join("::")}`,
		startIndex: leading ? startIndex : first,
		endIndex: last,
		identifierIndices,
	};
}

export function qualifiedNameForIdentifier(tokens: CToken[], index: number, end: number): QualifiedName | undefined {
	if (!isIdentifierToken(tokens[index])) return undefined;
	let component = index;
	let separator = previousSignificant(tokens, component);
	while (tokenValue(tokens, separator) === "::") {
		const left = previousSignificant(tokens, separator);
		if (isIdentifierToken(tokens[left])) {
			component = left;
			separator = previousSignificant(tokens, component);
			continue;
		}
		return qualifiedNameAt(tokens, separator, end);
	}
	return qualifiedNameAt(tokens, component, end);
}

/** Last token of Ghidra's dotted type name from `index`, as in `anon_struct.conflict71c`; `index` when none follows. */
export function dottedEnd(tokens: CToken[], index: number): number {
	let end = index;
	for (;;) {
		const last = tokens[end];
		const dot = tokens[end + 1];
		const part = tokens[end + 2];
		if (!isIdentifierToken(last) || syntaxValue(dot) !== "." || !isIdentifierToken(part)) return end;
		if (dot?.startOffset !== last.endOffset || part.startOffset !== dot.endOffset) return end;
		end += 2;
	}
}

/** The name tokens `start` through `end` spell. */
export function spelledName(tokens: CToken[], start: number, end: number): string {
	const parts: string[] = [];
	for (let index = start; index <= end; index++) parts.push((tokens[index] as CToken).raw);
	return parts.join("");
}

export function descriptorKey(path: DescriptorPath): string {
	return path
		.map((descriptor) => `${descriptor.kind}:${descriptor.name}:${descriptor.disambiguator ?? ""}`)
		.join("/");
}

export function containsPosition(range: Range, position: Range["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

export function rangeForTokens(tokens: CToken[], start: number, end: number): Range | undefined {
	const first = tokens[start];
	const last = tokens[end];
	if (first === undefined || last === undefined) return undefined;
	return { start: first.start, end: last.end };
}

export function lineCount(start: CToken, end: CToken): number {
	return end.end.line - start.start.line + 1;
}

export function docBefore(tokens: CToken[], start: number): number | undefined {
	let comments = 0;
	let first = start;
	let lineBreaks = 0;
	for (let index = start - 1; index >= 0; index--) {
		const token = tokens[index] as CToken;
		if (token.kind === "newline") {
			lineBreaks++;
			if (lineBreaks > comments + 1) break;
			continue;
		}
		if (token.kind !== "comment") break;
		if (token.doc === undefined) return undefined;
		comments++;
		first = index;
	}
	return comments === 0 ? undefined : first;
}

export function declarationRangeStart(tokens: CToken[], start: number): number {
	return docBefore(tokens, start) ?? start;
}

/** `range` grown to cover `more`. */
export function widened(range: OffsetRange | undefined, more: OffsetRange): OffsetRange {
	if (range === undefined) return more;
	return { start: Math.min(range.start, more.start), end: Math.max(range.end, more.end) };
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
