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
 * Whether an answer may be written down.
 *
 * Four refusals, and each closes a different way of recording something ungrounded:
 *
 * - No citations at all. This is the cold answer the whole layer exists to prevent.
 * - A citation that is not a fact id at all. Diagnosed separately from unresolved, because the
 *   common cause is copying only the trailing digest, and the unresolved wording sends that author
 *   off to re-fetch ids that were never the problem. One agent burned three full write rounds on
 *   exactly that misdirection.
 * - A citation that resolves to nothing. A fact id is a digest of its own contents, so an id that
 *   does not resolve was either invented or describes something that has since changed, and both
 *   are reasons to refuse rather than to store.
 * - Nothing cited about the SUBJECT. An answer can legitimately cite a neighbour, since answers
 *   compound, but one citing only neighbours is not about the symbol it claims to describe.
 */
export function checkCitations(
	symbolId: string,
	citations: string[],
	resolve: (factId: string) => StoredFact | null,
	subjectFacts: Set<string>,
): { ok: true } | { ok: false; reason: string; unresolved?: string[] } {
	if (citations.length === 0) {
		return { ok: false, reason: "an answer must cite the facts it was drawn from, and this cites none" };
	}

	const malformed = citations.filter((factId) => !isFactId(factId));
	if (malformed.length > 0) {
		return {
			ok: false,
			reason: `${malformed.length} citation${malformed.length === 1 ? " is" : "s are"} not a fact id at all. Cite the id exactly as symbol_facts prints it, the whole space-separated line ending in the digest, never the trailing digest alone`,
			unresolved: malformed,
		};
	}

	const unresolved = citations.filter((factId) => resolve(factId) === null);
	if (unresolved.length > 0) {
		// Two innocent explanations and one bad one share this failure, and the wording carries all
		// three: a re-index since the ids were fetched retires them legitimately, and telling an
		// honest author only "you invented this" teaches distrust of a system that was healing.
		return {
			ok: false,
			reason: `${unresolved.length} cited fact${unresolved.length === 1 ? " does" : "s do"} not resolve. Either the index re-derived its facts since these ids were fetched, in which case call symbol_facts again and cite the current ids, or the id was invented, which this check exists to refuse`,
			unresolved,
		};
	}

	if (!citations.some((factId) => subjectFacts.has(factId))) {
		return {
			ok: false,
			reason: `nothing cited here is a fact about ${symbolId}. Citing only its neighbours describes them, not it`,
		};
	}

	return { ok: true };
}
