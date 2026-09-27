// Comments and blank lines from the parser's tokens.

import type { CommentSpan, OffsetRange } from "@nyaa-lexicon/protocol";
import { contentOffset, rangeAt, type Walk } from "./context.js";
import type { Token } from "./syntax/ast.js";

////////////////////////////////
//  Functions & Helpers

export function rangesOf(tokens: readonly Token[], kind: Token["kind"]): OffsetRange[] {
	return tokens.flatMap((token) => (token.kind === kind ? [{ start: token.pos, end: token.end }] : []));
}

/** A token holding only a line ending's `\r` touches no text. */
function visible(w: Walk, token: Token): boolean {
	return contentOffset(w, token.end) > token.pos;
}

function firstLine(w: Walk, token: Token): number {
	return w.coordinates.positionAt(token.pos + w.shift)?.line ?? 0;
}

/** A token ending with its line break ends on that line. */
function lastLine(w: Walk, token: Token): number {
	return w.coordinates.positionAt(Math.max(token.pos, token.end - 1) + w.shift)?.line ?? 0;
}

/** Each comment with whether the nearest other token on either side shares its line. */
export function commentSpans(w: Walk, tokens: readonly Token[]): CommentSpan[] {
	const spans: CommentSpan[] = [];
	let before: Token | undefined;
	let undecided = 0;
	for (const token of tokens) {
		if (!visible(w, token)) continue;
		if (token.kind !== "comment") {
			const line = firstLine(w, token);
			for (; undecided < spans.length; undecided++) {
				const span = spans[undecided] as CommentSpan;
				span.codeAfter = span.range.end.line === line;
			}
			before = token;
			continue;
		}
		spans.push({
			range: rangeAt(w, token.pos, token.end),
			text: w.text.slice(token.pos, contentOffset(w, token.end)),
			codeBefore: before !== undefined && lastLine(w, before) === firstLine(w, token),
			codeAfter: false,
		});
	}
	return spans;
}

/** Lines no token touches. The empty remainder after a final line break is no line. */
export function blankLinesOf(w: Walk, tokens: readonly Token[]): number[] {
	const end = w.coordinates.positionAt(w.shift + w.text.length);
	const count = end === undefined ? 0 : end.character === 0 ? end.line : end.line + 1;
	const blank: number[] = [];
	let line = 0;
	for (const token of tokens) {
		if (!visible(w, token)) continue;
		for (const first = firstLine(w, token); line < first && line < count; line++) blank.push(line);
		line = Math.max(line, lastLine(w, token) + 1);
	}
	for (; line < count; line++) blank.push(line);
	return blank;
}
