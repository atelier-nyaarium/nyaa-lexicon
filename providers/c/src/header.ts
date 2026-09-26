// A declaration's header over its tokens, handed to the protocol's one renderer.

import { type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import { type CToken, syntaxValue } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** Token indices, both ends inclusive. */
export interface TokenSpan {
	first: number;
	last: number;
}

/** One header; `lead` holds what sibling declarators share. */
export interface TokenHeader extends TokenSpan {
	lead?: TokenSpan;
}

interface Cuts {
	folds: OffsetRange[];
	omit: OffsetRange[];
	verbatim: OffsetRange[];
}

////////////////////////////////
//  Functions & Helpers

/** Non-blank text between tokens: a removed branch. */
function removedText(text: string, start: number, end: number): OffsetRange | undefined {
	if (end <= start) return undefined;
	const gap = text.slice(start, end);
	const lead = gap.length - gap.trimStart().length;
	if (lead === gap.length) return undefined;
	return { start: start + lead, end: end - (gap.length - gap.trimEnd().length) };
}

/** The cuts inside one span, walking only its own tokens. */
function collect(
	text: string,
	tokens: readonly CToken[],
	pairs: ReadonlyMap<number, number>,
	span: TokenSpan,
	cuts: Cuts,
): void {
	let reached = (tokens[span.first] as CToken).startOffset;
	for (let index = span.first; index <= span.last; index++) {
		const token = tokens[index] as CToken;
		const removed = removedText(text, reached, token.startOffset);
		if (removed !== undefined) cuts.omit.push(removed);
		if (token.kind === "comment") {
			// Retokenized suffixes start inside.
			const end = Math.min(token.endOffset, tokens[index + 1]?.startOffset ?? token.endOffset);
			cuts.omit.push({ start: token.startOffset, end });
			reached = end;
			continue;
		}
		reached = Math.max(reached, token.endOffset);
		if (token.kind === "string" || token.kind === "char") {
			cuts.verbatim.push({ start: token.startOffset, end: token.endOffset });
			continue;
		}
		const value = syntaxValue(token);
		if (value === "\\" && tokens[index + 1]?.kind === "newline") {
			cuts.omit.push({ start: token.startOffset, end: token.endOffset });
			continue;
		}
		const close = value === "{" ? pairs.get(index) : undefined;
		if (close !== undefined && close > index && close <= span.last) {
			const end = (tokens[close] as CToken).endOffset;
			cuts.folds.push({ start: token.startOffset, end });
			reached = end;
			index = close;
		}
	}
}

function offsets(tokens: readonly CToken[], span: TokenSpan): OffsetRange | undefined {
	const first = tokens[span.first];
	const last = tokens[span.last];
	if (first === undefined || last === undefined || span.last < span.first) return undefined;
	return { start: first.startOffset, end: last.endOffset };
}

/**
 * Source spelling; comments, splices and removed branches out; brace pairs folded; literals kept
 * as written.
 */
export function tokenHeader(
	text: string,
	tokens: readonly CToken[],
	pairs: ReadonlyMap<number, number>,
	header: TokenHeader,
): string | undefined {
	const own = offsets(tokens, header);
	if (own === undefined) return undefined;
	const cuts: Cuts = { folds: [], omit: [], verbatim: [] };
	const lead = header.lead === undefined ? undefined : offsets(tokens, header.lead);
	if (header.lead !== undefined && lead !== undefined) collect(text, tokens, pairs, header.lead, cuts);
	collect(text, tokens, pairs, header, cuts);
	return renderHeader(text, { ...own, ...(lead === undefined ? {} : { lead }), ...cuts });
}
