// Token-derived comment trivia, blank lines and member insertion points.

import { COMMENT_TYPES, type LineTable, type SyntaxNode } from "./tree.js";

////////////////////////////////
//  Interfaces & Types

export interface Trivia {
	codeBefore: boolean;
	codeAfter: boolean;
}

////////////////////////////////
//  Functions & Helpers

/** First index whose leaf starts at or after `offset`; leaves in source order. */
function firstFrom(leaves: readonly SyntaxNode[], offset: number): number {
	let low = 0;
	let high = leaves.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((leaves[middle] as SyntaxNode).start < offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

function lineOf(lines: LineTable, offset: number): number {
	return lines.position(offset).line;
}

/** Tokens with width, comments excluded. */
export function codeLeaves(leaves: readonly SyntaxNode[]): SyntaxNode[] {
	return leaves.filter((leaf) => leaf.end > leaf.start && !COMMENT_TYPES.has(leaf.type));
}

/** Code on the comment's first line before it, and on its last line after it. */
export function triviaOf(code: readonly SyntaxNode[], lines: LineTable, start: number, end: number): Trivia {
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

/** Hidden tokens, such as a statement's `;`, leave no leaf; their characters still touch a line. */
function touchHidden(text: string, lines: LineTable, from: number, to: number, touched: Set<number>): void {
	for (let at = from; at < to; at++) if (text.charAt(at).trim() !== "") touched.add(lineOf(lines, at));
}

/** Lines no token touches. `unclosed` starts a comment running to the end. */
export function blankLines(
	text: string,
	leaves: readonly SyntaxNode[],
	lines: LineTable,
	unclosed: number | undefined,
): number[] {
	const touched = new Set<number>();
	let from = 0;
	for (const leaf of leaves) {
		if (leaf.end === leaf.start) continue;
		touchHidden(text, lines, from, leaf.start, touched);
		touchLines(lines, leaf.start, leaf.end, touched);
		from = leaf.end;
	}
	touchHidden(text, lines, from, text.length, touched);
	if (unclosed !== undefined && unclosed < text.length) touchLines(lines, unclosed, text.length, touched);
	// A final line break ends the last line.
	const tail = lines.position(text.length);
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
