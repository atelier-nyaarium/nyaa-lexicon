// The unit every rewriting operation answers in, and the one way to apply a set of them.
//
// Its own module rather than rename's, because move needs the same type and a contract importing
// from a sibling contract makes either one impossible to reshape alone. Application lives here
// too so the conformance suite can check a provider's edits without a second implementation of
// the splice, which is the bug class where two appliers disagree about overlapping ranges.

import { z } from "zod";
import { coordinatesOf } from "./coordinates.js";
import { RangeSchema } from "./symbols.js";

////////////////////////////////
//  Schemas

/** One replacement, in the coordinates of the text the request carried. */
export const TextEditSchema = z.object({ range: RangeSchema, newText: z.string() }).meta({ id: "TextEdit" });

export type TextEdit = z.infer<typeof TextEditSchema>;

////////////////////////////////
//  Functions & Helpers

/**
 * Apply every edit to one file's text.
 *
 * Applied back to front, so an earlier edit never moves the coordinates of a later one, and the
 * result does not depend on the order the caller happened to collect them in.
 *
 * Refuses rather than resolves, in three ways, because each alternative is a silently wrong file:
 * a position that does not address a character, two edits claiming the same characters, and two
 * insertions at one point whose order would decide the output. A caller that means to combine two
 * insertions says so by passing one edit.
 */
export function applyEdits(text: string, edits: TextEdit[]): { text: string } | { problem: string } {
	const coordinates = coordinatesOf(text);
	const spans: Array<{ start: number; end: number; newText: string }> = [];

	for (const edit of edits) {
		const offsets = coordinates.offsetsForRange(edit.range);
		if (offsets === undefined) {
			const { line, character } = edit.range.start;
			return { problem: `an edit does not address text, at line ${line} character ${character}` };
		}
		spans.push({ start: offsets.start, end: offsets.end, newText: edit.newText });
	}

	spans.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let i = 1; i < spans.length; i++) {
		const previous = spans[i - 1] as { start: number; end: number; newText: string };
		const current = spans[i] as { start: number; end: number; newText: string };
		if (current.start < previous.end) return { problem: "two edits overlap, so the result would depend on order" };
		if (current.start === current.end && previous.start === previous.end && current.start === previous.start) {
			if (current.newText === previous.newText) continue;
			return {
				problem: `two insertions share one point, so the result would depend on order at offset ${current.start}`,
			};
		}
	}

	let out = text;
	const seen = new Set<string>();
	for (const span of [...spans].reverse()) {
		const key = `${span.start}:${span.end}:${span.newText}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out = out.slice(0, span.start) + span.newText + out.slice(span.end);
	}
	return { text: out };
}
