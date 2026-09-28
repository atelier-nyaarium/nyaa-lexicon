// A declaration's header over its tokens, handed to the protocol's one renderer.

import { type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import type { CToken } from "./tokens.js";
import { syntaxValue } from "./tokenWalk.js";

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
	/** Each directive line's tokens, to its end; a header of code leaves them out. */
	directives?: ReadonlyMap<number, number>;
}

interface Cuts {
	folds: OffsetRange[];
	omit: OffsetRange[];
	splices: OffsetRange[];
	verbatim: OffsetRange[];
}

////////////////////////////////
//  Functions & Helpers

/** The cuts inside one span, walking only its own tokens. */
function collect(
	tokens: readonly CToken[],
	pairs: ReadonlyMap<number, number>,
	span: TokenSpan,
	directives: ReadonlyMap<number, number> | undefined,
	cuts: Cuts,
): void {
	for (let index = span.first; index <= span.last; index++) {
		const token = tokens[index] as CToken;
		if (index > span.first && token.hiddenBefore !== undefined) cuts.omit.push(token.hiddenBefore);
		if (token.splices !== undefined) cuts.splices.push(...token.splices);
		const directiveEnd = directives?.get(index);
		if (directiveEnd !== undefined) {
			const last = Math.min(directiveEnd - 1, span.last);
			cuts.omit.push({ start: token.startOffset, end: (tokens[last] as CToken).endOffset });
			index = last;
			continue;
		}
		if (token.kind === "comment") {
			// Retokenized suffixes start inside.
			const end = Math.min(token.endOffset, tokens[index + 1]?.startOffset ?? token.endOffset);
			cuts.omit.push({ start: token.startOffset, end });
			continue;
		}
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
			cuts.folds.push({ start: token.startOffset, end: (tokens[close] as CToken).endOffset });
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
	const cuts: Cuts = { folds: [], omit: [], splices: [], verbatim: [] };
	const lead = header.lead === undefined ? undefined : offsets(tokens, header.lead);
	if (header.lead !== undefined && lead !== undefined) collect(tokens, pairs, header.lead, header.directives, cuts);
	collect(tokens, pairs, header, header.directives, cuts);
	return renderHeader(text, { ...own, ...(lead === undefined ? {} : { lead }), ...cuts });
}
