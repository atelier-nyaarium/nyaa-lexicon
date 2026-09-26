// A declaration's header spans over its tokens, handed to the protocol's one renderer.

import { angleDelta, type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import { isSignificant, type Token } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** `type` folds only a top-level aggregate body; `value` folds every brace list and lambda. */
export type HeaderKind = "type" | "value";

/** Token indices, end exclusive. */
export interface TokenSpan {
	start: number;
	end: number;
}

interface Cuts {
	folds: OffsetRange[];
	omit: OffsetRange[];
	verbatim: OffsetRange[];
}

////////////////////////////////
//  Functions & Helpers

/** Non-whitespace source between tokens: an inactive branch or continuation. */
function hidden(text: string, from: number, to: number): boolean {
	return from < to && text.slice(from, to).trim() !== "";
}

function isPunctuation(token: Token, value: string): boolean {
	return token.kind === "punctuation" && token.text === value;
}

/** Depth delta for parens, brackets and template angles. */
function nesting(token: Token): number {
	if (token.kind !== "punctuation") return 0;
	if (token.text === "(" || token.text === "[") return 1;
	if (token.text === ")" || token.text === "]") return -1;
	return angleDelta(token.text);
}

/** The last token of the directive opening at `index`. */
function directiveLast(tokens: Token[], index: number, last: number): number {
	let current = index;
	while (current < last && tokens[current + 1]?.kind !== "newline") current++;
	return current;
}

/** The brace closing the one at `index`, or -1 past `last`. */
function closingBrace(tokens: Token[], index: number, last: number): number {
	let depth = 0;
	for (let current = index; current <= last; current++) {
		const token = tokens[current] as Token;
		if (isPunctuation(token, "{")) depth++;
		else if (isPunctuation(token, "}")) {
			depth--;
			if (depth === 0) return current;
		}
	}
	return -1;
}

/** From the first to the last significant token in `span`; undefined when there is none. */
function trimmed(tokens: Token[], span: TokenSpan): TokenSpan | undefined {
	let first = span.start;
	while (first < span.end && !isSignificant(tokens[first] as Token)) first++;
	let last = span.end - 1;
	while (last > first && !isSignificant(tokens[last] as Token)) last--;
	if (first >= span.end) return undefined;
	return { start: first, end: last + 1 };
}

function offsetsOf(tokens: Token[], span: TokenSpan): OffsetRange {
	return { start: (tokens[span.start] as Token).startOffset, end: (tokens[span.end - 1] as Token).endOffset };
}

/** Comments, directives and inactive text out, literals verbatim, braces folded by `kind`. */
function collectCuts(text: string, tokens: Token[], span: TokenSpan, kind: HeaderKind, cuts: Cuts): void {
	const last = span.end - 1;
	let depth = 0;
	for (let index = span.start; index <= last; index++) {
		const token = tokens[index] as Token;
		const previous = tokens[index - 1];
		if (index > span.start && previous !== undefined && hidden(text, previous.endOffset, token.startOffset))
			cuts.omit.push({ start: previous.endOffset, end: token.startOffset });
		if (token.kind === "comment") {
			cuts.omit.push({ start: token.startOffset, end: token.endOffset });
		} else if (token.kind === "string" || token.kind === "character") {
			cuts.verbatim.push({ start: token.startOffset, end: token.endOffset });
		} else if (isPunctuation(token, "#")) {
			const end = directiveLast(tokens, index, last);
			cuts.omit.push({ start: token.startOffset, end: (tokens[end] as Token).endOffset });
			index = end;
		} else if (isPunctuation(token, "{") && (kind === "value" || depth === 0)) {
			const close = closingBrace(tokens, index, last);
			if (close < 0) continue;
			cuts.folds.push({ start: token.startOffset, end: (tokens[close] as Token).endOffset });
			index = close;
		} else {
			depth += nesting(token);
		}
	}
}

/**
 * Header over `[startIndex, endIndex)`, comments, directives and inactive branches dropped. A later
 * declarator names its shared specifiers as `lead`, so it never walks its siblings.
 */
export function headerOf(
	text: string,
	tokens: Token[],
	startIndex: number,
	endIndex: number,
	kind: HeaderKind,
	lead?: TokenSpan,
): string | undefined {
	const own = trimmed(tokens, { start: startIndex, end: endIndex });
	if (own === undefined) return undefined;
	const shared = lead === undefined ? undefined : trimmed(tokens, lead);
	const cuts: Cuts = { folds: [], omit: [], verbatim: [] };
	collectCuts(text, tokens, own, kind, cuts);
	if (shared !== undefined) collectCuts(text, tokens, shared, kind, cuts);
	const { start, end } = offsetsOf(tokens, own);
	return renderHeader(text, {
		...(shared === undefined ? {} : { lead: offsetsOf(tokens, shared) }),
		start,
		end,
		...cuts,
	});
}
