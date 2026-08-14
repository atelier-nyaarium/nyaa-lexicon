// The unit every rewriting operation answers in, and the one way to apply a set of them.
//
// Its own module rather than rename's, because move needs the same type and a contract importing
// from a sibling contract makes either one impossible to reshape alone. Application lives here
// too so the conformance suite can check a provider's edits without a second implementation of
// the splice, which is the bug class where two appliers disagree about overlapping ranges.

import { z } from "zod";
import { coordinatesOf, type TextCoordinates } from "./coordinates.js";
import { RangeSchema } from "./symbols.js";

////////////////////////////////
//  Schemas

/** One replacement, in the coordinates of the text the request carried. */
export const TextEditSchema = z.object({ range: RangeSchema, newText: z.string() }).meta({ id: "TextEdit" });

export type TextEdit = z.infer<typeof TextEditSchema>;

////////////////////////////////
//  Interfaces & Types

/**
 * Why an edit cannot travel with the others. A closed set, because a caller has to map each one
 * into its own vocabulary and an open string would let a new case pass unnoticed.
 */
export type EditConflict =
	/** Its range does not address text in this file. */
	| "unaddressable"
	/** Another edit claims the same characters and says something different. */
	| "duplicate"
	/** It starts inside a span an earlier edit already claims. */
	| "overlapping";

export interface EditPlan {
	/** Applicable together, ordered by position, identical spans folded to one. */
	edits: TextEdit[];
	/** What had to be left out, in the order the conflicts were found. */
	conflicts: Array<{ edit: TextEdit; conflict: EditConflict }>;
	/**
	 * Points where two or more DIFFERENT insertions were joined into one, in the order given.
	 *
	 * Reported rather than hidden because the two callers of this analysis disagree about it, and
	 * that disagreement is a policy worth seeing. A provider joins them, since collecting several
	 * insertions for one point is how it adds two imports. The applier refuses them, since by the
	 * time a final edit set reaches it, an ambiguous order is a provider bug rather than a shorthand.
	 */
	joined: Array<{ offset: number; edit: TextEdit }>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Work out what a set of edits means, without applying any of them.
 *
 * ONE analysis, because there were five: the applier below, and a `validateEdits` in each of the
 * four provider modules that rewrite text. They agreed by luck rather than by construction, and had
 * already drifted on joined insertions. Deciding twice what a set of edits means is the bug class
 * this module's header claims to have closed, so it had better only be decided here.
 *
 * What each caller does with the result is still the caller's. This function has no policy, only
 * findings.
 */
export function planEdits(coordinates: TextCoordinates, edits: TextEdit[]): EditPlan {
	const conflicts: EditPlan["conflicts"] = [];
	const unique = new Map<string, { edit: TextEdit; start: number; end: number }>();
	const joinedPoints = new Set<number>();

	for (const edit of edits) {
		const offsets = coordinates.offsetsForRange(edit.range);
		if (offsets === undefined) {
			conflicts.push({ edit, conflict: "unaddressable" });
			continue;
		}

		const key = `${offsets.start}:${offsets.end}`;
		const previous = unique.get(key);
		if (previous === undefined) {
			unique.set(key, { edit, ...offsets });
			continue;
		}
		// Identical text at identical coordinates is one edit collected twice, not a conflict.
		if (previous.edit.newText === edit.newText) continue;

		if (offsets.start === offsets.end) {
			unique.set(key, {
				edit: { range: edit.range, newText: `${previous.edit.newText}${edit.newText}` },
				...offsets,
			});
			joinedPoints.add(offsets.start);
			continue;
		}
		conflicts.push({ edit, conflict: "duplicate" });
	}

	// Read back after the fold, so the edit reported is the joined one a caller can point at.
	const joined = [...joinedPoints].map((offset) => ({
		offset,
		edit: (unique.get(`${offset}:${offset}`) as { edit: TextEdit }).edit,
	}));

	const sorted = [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end);
	const safe: TextEdit[] = [];
	let previousEnd = -1;
	for (const item of sorted) {
		if (item.start < previousEnd) {
			conflicts.push({ edit: item.edit, conflict: "overlapping" });
			continue;
		}
		safe.push(item.edit);
		previousEnd = Math.max(previousEnd, item.end);
	}
	return { edits: safe, conflicts, joined };
}

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
	const plan = planEdits(coordinates, edits);

	const first = plan.conflicts[0];
	if (first !== undefined) {
		const { line, character } = first.edit.range.start;
		if (first.conflict === "unaddressable") {
			return { problem: `an edit does not address text, at line ${line} character ${character}` };
		}
		return { problem: "two edits overlap, so the result would depend on order" };
	}

	const joined = plan.joined[0];
	if (joined !== undefined) {
		return {
			problem: `two insertions share one point, so the result would depend on order at offset ${joined.offset}`,
		};
	}

	let out = text;
	for (const edit of [...plan.edits].reverse()) {
		const offsets = coordinates.offsetsForRange(edit.range) as { start: number; end: number };
		out = out.slice(0, offsets.start) + edit.newText + out.slice(offsets.end);
	}
	return { text: out };
}
