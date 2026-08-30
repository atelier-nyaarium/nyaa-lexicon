// A declaration's pattern digest: kind, name, and its text with the reported comments removed and
// whitespace collapsed. Evidence that a vanished declaration reappeared elsewhere, never a key.

import { type CommentSpan, coordinatesOf, type Declaration, hashContent } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** What a digest covers: the provider reported comment spans, or it reported none. */
export type PatternCoverage = "commentsStripped" | "commentsKept";

export interface PatternDigest {
	symbolId: string;
	patternDigest: string;
	patternCoverage: PatternCoverage;
}

////////////////////////////////
//  Functions & Helpers

/** The first span, in start order, at or after which some span reaches `offset`. Searched over the
 * running maximum of span ends, which is monotonic where the ends themselves need not be. */
function firstSpanReaching(reach: number[], offset: number): number {
	let low = 0;
	let high = reach.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((reach[mid] as number) <= offset) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** Every declaration with a range, from a full parse only: a shallow parse reports no comments
 * even from a provider that has them, and the same text must not digest two ways. */
export function patternDigests(
	declarations: Declaration[],
	comments: CommentSpan[] | undefined,
	text: string,
): PatternDigest[] {
	const coordinates = coordinatesOf(text);
	const coverage: PatternCoverage = comments === undefined ? "commentsKept" : "commentsStripped";
	const spans = (comments ?? [])
		.map((comment) => coordinates.offsetsForRange(comment.range))
		.filter((span): span is NonNullable<typeof span> => span !== undefined)
		.sort((a, b) => a.start - b.start);
	const reach: number[] = [];
	for (const span of spans) reach.push(Math.max(span.end, reach[reach.length - 1] ?? 0));

	const digests: PatternDigest[] = [];
	for (const declaration of declarations) {
		const range = coordinates.offsetsForRange(declaration.range);
		if (range === undefined) continue;
		let body = "";
		let cursor = range.start;
		for (let i = firstSpanReaching(reach, range.start); i < spans.length; i++) {
			const span = spans[i] as { start: number; end: number };
			if (span.start >= range.end) break;
			if (span.end <= cursor) continue;
			body += text.slice(cursor, Math.max(cursor, span.start));
			cursor = Math.max(cursor, span.end);
		}
		body += text.slice(cursor, Math.max(cursor, range.end));
		const collapsed = body.replace(/\s+/g, " ").trim();
		digests.push({
			symbolId: declaration.symbolId,
			patternDigest: hashContent(`${declaration.kind}\n${declaration.name}\n${collapsed}`),
			patternCoverage: coverage,
		});
	}
	return digests;
}
