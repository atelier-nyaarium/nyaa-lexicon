// The knowledge layer's vocabulary and its one rule.
//
// An answer is prose PLUS the fact ids it consumed. That pairing is the whole design: it makes
// "never ask the model cold" a property of the store rather than a slogan, because an answer that
// cites nothing cannot be written down at all.
//
// Nothing here calls a model, and nothing here should. The consumer of this tool is already an AI
// agent reading the code, so a second model call inside the core would pay twice and bind the tool
// to a model, a key and a bill. The core hands over facts, takes back prose and citations, refuses
// what it cannot verify, and remembers. That split is also what keeps narration from ever editing
// facts: this module can only read them.

import { isFactId, QUESTION_CLASSES, type QuestionClass, type StoredFact } from "@nyaa-lexicon/protocol";
import * as refusal from "./refusals.js";

export {
	type Answer,
	type Doubt,
	QUESTION_CLASSES,
	type QuestionClass,
	type RecalledAnswer,
	type RecordOutcome,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Constants

/** Enough for a sentence and a paragraph, which is what `describe` is specified to be. */
export const MAX_PROSE = 4000;

////////////////////////////////
//  Functions & Helpers

export function isQuestionClass(text: string): text is QuestionClass {
	return (QUESTION_CLASSES as readonly string[]).includes(text);
}

/**
 * Whether an answer may be written down: cited, by fact ids, that resolve, at least one about the
 * subject. Malformed is split from unresolved because the remedies differ.
 */
export function checkCitations(
	symbolId: string,
	citations: string[],
	resolve: (factId: string) => StoredFact | null,
	subjectFacts: Set<string>,
): { ok: true } | { ok: false; reason: refusal.Refusal; unresolved?: string[] } {
	if (citations.length === 0) return { ok: false, reason: refusal.citesNothing() };

	const malformed = citations.filter((factId) => !isFactId(factId));
	if (malformed.length > 0) {
		return { ok: false, reason: refusal.malformedCitations(malformed.length), unresolved: malformed };
	}

	const unresolved = citations.filter((factId) => resolve(factId) === null);
	if (unresolved.length > 0) {
		return { ok: false, reason: refusal.unresolvedCitations(unresolved.length), unresolved };
	}

	if (!citations.some((factId) => subjectFacts.has(factId))) {
		return { ok: false, reason: refusal.citesOnlyNeighbours(symbolId) };
	}

	return { ok: true };
}
