// Comments, blank lines and signatures, from the parser's tokens.

import {
	blankLinesFromTrivia,
	type CommentSpan,
	commentsFromTrivia,
	headerTriviaGroups,
	type NormalizedTrivia,
	normalizeTriviaRanges,
	type OffsetRange,
	renderHeader,
} from "@nyaa-lexicon/protocol";
import { rangeAt, type Walk } from "./context.js";
import type { Token, TokenKind } from "./syntax/tokens.js";

////////////////////////////////
//  Constants

const STRINGS: ReadonlySet<TokenKind> = new Set([
	"StringLiteral",
	"StringExpandable",
	"HereStringLiteral",
	"HereStringExpandable",
]);

/** Tokens that are layout, not text a line holds. */
const LAYOUT: ReadonlySet<TokenKind> = new Set(["NewLine", "EndOfInput"]);

////////////////////////////////
//  Functions & Helpers

/** The last line a token holds text on; one ending in a line break, as a continuation does, ends before it. */
function lastLine(token: Token): number {
	return token.endColumn === 0 && token.endLine > token.line ? token.endLine - 1 : token.endLine;
}

function spansOf(tokens: readonly Token[], kinds: ReadonlySet<TokenKind>): OffsetRange[] {
	return tokens.flatMap((token) => (kinds.has(token.kind) ? [{ start: token.pos, end: token.end }] : []));
}

function normalizedTrivia(w: Walk, tokens: readonly Token[]): NormalizedTrivia[] {
	const trivia: NormalizedTrivia[] = [];
	for (const token of tokens) {
		if (LAYOUT.has(token.kind) || token.end <= token.pos) continue;
		const common = { range: rangeAt(w, token.pos, token.end), firstLine: token.line, lastLine: lastLine(token) };
		trivia.push(
			token.kind === "Comment" ? { kind: "comment", ...common, text: token.text } : { kind: "token", ...common },
		);
	}
	return trivia;
}

/** Each comment with whether the nearest other token on either side shares its line. */
export function commentSpans(w: Walk, tokens: readonly Token[]): CommentSpan[] {
	return commentsFromTrivia(normalizedTrivia(w, tokens));
}

/** Lines no token touches. The empty remainder after a final line break is no line. */
export function blankLinesOf(w: Walk, tokens: readonly Token[]): number[] {
	const end = w.coordinates.positionAt(w.text.length);
	const lineCount = end === undefined ? 0 : end.character === 0 ? end.line : end.line + 1;
	return blankLinesFromTrivia(normalizedTrivia(w, tokens), lineCount);
}

/** Every declaration's signature: comments and line continuations out, strings as written. */
export function signHeaders(w: Walk, tokens: readonly Token[]): void {
	const comments = normalizeTriviaRanges(spansOf(tokens, new Set(["Comment"])));
	const continuations = normalizeTriviaRanges(spansOf(tokens, new Set(["LineContinuation"])));
	const strings = normalizeTriviaRanges(spansOf(tokens, STRINGS));
	for (const { declaration, span } of w.headers) {
		const omit: OffsetRange[] = [...(span.omit ?? [])];
		omit.push(...headerTriviaGroups(comments, span).flat());
		const splices = headerTriviaGroups(continuations, span).flat();
		const verbatim = headerTriviaGroups(strings, span).flat();
		const signature = renderHeader(w.text, { ...span, omit, splices, verbatim });
		if (signature !== undefined) declaration.signature = signature;
	}
}
