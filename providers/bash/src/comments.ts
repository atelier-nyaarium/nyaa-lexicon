// Comments and blank lines from the parser's tokens.

import {
	blankLinesFromTrivia,
	type CommentSpan,
	commentsFromTrivia,
	type NormalizedTrivia,
	type OffsetRange,
} from "@nyaa-lexicon/protocol";
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

function triviaOf(w: Walk, tokens: readonly Token[]): NormalizedTrivia[] {
	const trivia: NormalizedTrivia[] = [];
	for (const token of tokens) {
		if (!visible(w, token)) continue;
		const range = rangeAt(w, token.pos, token.end);
		const lines = { firstLine: firstLine(w, token), lastLine: lastLine(w, token) };
		if (token.kind === "comment") {
			trivia.push({
				kind: "comment",
				range,
				...lines,
				text: w.text.slice(token.pos, contentOffset(w, token.end)),
			});
		} else {
			trivia.push({ kind: "token", range, ...lines });
		}
	}
	return trivia;
}

/** Each comment with whether the nearest other token on either side shares its line. */
export function commentSpans(w: Walk, tokens: readonly Token[]): CommentSpan[] {
	return commentsFromTrivia(triviaOf(w, tokens));
}

/** Lines no token touches. The empty remainder after a final line break is no line. */
export function blankLinesOf(w: Walk, tokens: readonly Token[]): number[] {
	const end = w.coordinates.positionAt(w.shift + w.text.length);
	const count = end === undefined ? 0 : end.character === 0 ? end.line : end.line + 1;
	return blankLinesFromTrivia(triviaOf(w, tokens), count);
}
