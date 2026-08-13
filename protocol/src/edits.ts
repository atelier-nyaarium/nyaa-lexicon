// The unit every rewriting operation answers in, and the one way to apply a set of them.
//
// Its own module rather than rename's, because move needs the same type and a contract importing
// from a sibling contract makes either one impossible to reshape alone. Application lives here
// too so the conformance suite can check a provider's edits without a second implementation of
// the splice, which is the bug class where two appliers disagree about overlapping ranges.

import { z } from "zod";
import { RangeSchema } from "./symbols.js";

////////////////////////////////
//  Schemas

/** One replacement, in the coordinates of the text the request carried. */
export const TextEditSchema = z.object({ range: RangeSchema, newText: z.string() }).meta({ id: "TextEdit" });

export type TextEdit = z.infer<typeof TextEditSchema>;

////////////////////////////////
//  Functions & Helpers

/** Line and character to an index, so edits can be sorted and spliced in one coordinate system. */
function offsetOf(lineStarts: number[], position: { line: number; character: number }): number | null {
	const start = lineStarts[position.line];
	if (start === undefined) return null;
	return start + position.character;
}

function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	return starts;
}

/**
 * Apply every edit to one file's text.
 *
 * Applied back to front, so an earlier edit never moves the coordinates of a later one. Sorting
 * here rather than trusting the provider means a provider that returns edits in reading order and
 * one that returns them in any other order both produce the same file.
 *
 * Overlapping edits are refused rather than resolved. Two edits claiming the same characters is a
 * provider bug, and picking a winner would turn it into a silently wrong file.
 */
export function applyEdits(text: string, edits: TextEdit[]): { text: string } | { problem: string } {
	const lineStarts = lineStartsOf(text);
	const spans: Array<{ start: number; end: number; newText: string }> = [];

	for (const edit of edits) {
		const start = offsetOf(lineStarts, edit.range.start);
		const end = offsetOf(lineStarts, edit.range.end);
		if (start === null || end === null)
			return { problem: `an edit is outside the file at line ${edit.range.start.line}` };
		if (end < start) return { problem: `an edit ends before it starts at line ${edit.range.start.line}` };
		spans.push({ start, end, newText: edit.newText });
	}

	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		const previous = spans[i - 1] as { end: number };
		const current = spans[i] as { start: number };
		if (current.start < previous.end) return { problem: "two edits overlap, so the result would depend on order" };
	}

	let out = text;
	for (const span of [...spans].reverse()) out = out.slice(0, span.start) + span.newText + out.slice(span.end);
	return { text: out };
}
