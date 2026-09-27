// Token-derived comment trivia, blank lines and member insertion points.

import type { LineTable, SyntaxNode } from "./tree.js";

////////////////////////////////
//  Interfaces & Types

export interface Trivia {
	codeBefore: boolean;
	codeAfter: boolean;
}

/** A token's or comment's extent. */
export interface Span {
	start: number;
	end: number;
}

////////////////////////////////
//  Functions & Helpers

/** First index whose span starts at or after `offset`; spans in source order. */
function firstFrom(spans: readonly Span[], offset: number): number {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((spans[middle] as Span).start < offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

function lineOf(lines: LineTable, offset: number): number {
	return lines.position(offset).line;
}

/** Code on the comment's first line before it, and on its last line after it. */
export function triviaOf(code: readonly Span[], lines: LineTable, start: number, end: number): Trivia {
	const before = code[firstFrom(code, start) - 1];
	const after = code[firstFrom(code, end)];
	return {
		codeBefore: before !== undefined && lineOf(lines, before.end - 1) === lineOf(lines, start),
		codeAfter: after !== undefined && lineOf(lines, after.start) === lineOf(lines, end - 1),
	};
}

function touchLines(lines: LineTable, from: number, to: number, touched: Set<number>): void {
	const last = lineOf(lines, to - 1);
	for (let line = lineOf(lines, from); line <= last; line++) touched.add(line);
}

/** Lines no token or comment touches, of a text `length` long. */
export function blankLines(spans: readonly Span[], lines: LineTable, length: number): number[] {
	const touched = new Set<number>();
	for (const span of spans) if (span.end > span.start) touchLines(lines, span.start, span.end, touched);
	// A final line break ends the last line.
	const tail = lines.position(length);
	const count = tail.character === 0 ? tail.line : tail.line + 1;
	const blank: number[] = [];
	for (let line = 0; line < count; line++) if (!touched.has(line)) blank.push(line);
	return blank;
}

/** A body's closing line when its `}` starts the line, comments included; otherwise none. */
export function memberInsertLine(
	leaves: readonly SyntaxNode[],
	lines: LineTable,
	body: SyntaxNode | undefined,
): number | undefined {
	const closer = body?.children.at(-1);
	if (closer === undefined || closer.type !== "}" || closer.end === closer.start) return undefined;
	let index = firstFrom(leaves, closer.start) - 1;
	while (index >= 0 && (leaves[index] as SyntaxNode).end === (leaves[index] as SyntaxNode).start) index--;
	const previous = leaves[index];
	const line = lineOf(lines, closer.start);
	return previous !== undefined && lineOf(lines, previous.end - 1) < line ? line : undefined;
}
