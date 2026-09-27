// Comments, blank lines and signatures, from the parser's tokens.

import { type CommentSpan, type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
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

/** The ranges starting inside the piece, from ranges sorted by start. */
function startingWithin(ranges: readonly OffsetRange[], piece: OffsetRange): OffsetRange[] {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((ranges[middle] as OffsetRange).start < piece.start) low = middle + 1;
		else high = middle;
	}
	const found: OffsetRange[] = [];
	for (let at = low; at < ranges.length; at++) {
		const range = ranges[at] as OffsetRange;
		if (range.start >= piece.end) break;
		found.push(range);
	}
	return found;
}

/** Each comment with whether the nearest other token on either side shares its line. */
export function commentSpans(w: Walk, tokens: readonly Token[]): CommentSpan[] {
	const spans: CommentSpan[] = [];
	let before: Token | undefined;
	let undecided = 0;
	for (const token of tokens) {
		if (LAYOUT.has(token.kind) || token.end <= token.pos) continue;
		if (token.kind !== "Comment") {
			for (; undecided < spans.length; undecided++) {
				const span = spans[undecided] as CommentSpan;
				span.codeAfter = span.range.end.line === token.line;
			}
			before = token;
			continue;
		}
		spans.push({
			range: rangeAt(w, token.pos, token.end),
			text: token.text,
			codeBefore: before !== undefined && lastLine(before) === token.line,
			codeAfter: false,
		});
	}
	return spans;
}

/** Lines no token touches. The empty remainder after a final line break is no line. */
export function blankLinesOf(w: Walk, tokens: readonly Token[]): number[] {
	const end = w.coordinates.positionAt(w.text.length);
	const count = end === undefined ? 0 : end.character === 0 ? end.line : end.line + 1;
	const blank: number[] = [];
	let line = 0;
	for (const token of tokens) {
		if (LAYOUT.has(token.kind) || token.end <= token.pos) continue;
		for (; line < token.line && line < count; line++) blank.push(line);
		line = Math.max(line, lastLine(token) + 1);
	}
	for (; line < count; line++) blank.push(line);
	return blank;
}

/** Every declaration's signature: comments and line continuations out, strings as written. */
export function signHeaders(w: Walk, tokens: readonly Token[]): void {
	const comments = spansOf(tokens, new Set(["Comment"]));
	const continuations = spansOf(tokens, new Set(["LineContinuation"]));
	const strings = spansOf(tokens, STRINGS);
	for (const { declaration, span } of w.headers) {
		const omit: OffsetRange[] = [...(span.omit ?? [])];
		const splices: OffsetRange[] = [];
		const verbatim: OffsetRange[] = [];
		for (const piece of span.lead === undefined ? [span] : [span.lead, span]) {
			omit.push(...startingWithin(comments, piece));
			splices.push(...startingWithin(continuations, piece));
			verbatim.push(...startingWithin(strings, piece));
		}
		const signature = renderHeader(w.text, { ...span, omit, splices, verbatim });
		if (signature !== undefined) declaration.signature = signature;
	}
}
