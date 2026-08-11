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

import { isFactId } from "@nyaa-lexicon/protocol";
import type { StoredFact } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/**
 * The closed question vocabulary from `docs/knowledge-layer.md`.
 *
 * Closed rather than free-form for the same reason every other vocabulary here is: a class the core
 * cannot render is worse than one it refuses, and an open string turns a cache into a junk drawer.
 */
export type QuestionClass = "describe" | "why" | "relate" | "contract" | "effects" | "usage";

export const QUESTION_CLASSES: readonly QuestionClass[] = ["describe", "why", "relate", "contract", "effects", "usage"];

/**
 * A declared invalidation: someone read the code and no longer trusts this answer.
 *
 * The middle state between fresh and rewritten. Mechanical staleness cannot see semantic drift, so
 * an agent that just changed a function's purpose declares doubt instead of waiting for a citation
 * to die. Doubt does NOT retire the answer's fact id: parents' citations still resolve, and the
 * recall walk is what carries the doubt downstream as SHAKY.
 */
export interface Doubt {
	/** The handshake token. Clearing this doubt requires citing it, which proves the writer saw it. */
	factId: string;
	reason: string;
	at: number;
	/** Who declared it. Absent when the caller did not say. */
	by?: string;
}

export interface Answer {
	symbolId: string;
	question: QuestionClass;
	/**
	 * The answer's own citable id, in the fact grammar with kind `answer`.
	 *
	 * This is what lets a parent's description cite a child's: answers are facts one layer up.
	 * Re-recording retires the id, so everything citing the old one reports stale by the same
	 * lookup that catches an edited file.
	 */
	factId: string;
	prose: string;
	/** Fact ids consumed, in the order the author gave them. May include other answers' ids. */
	citations: string[];
	/**
	 * True when nothing cited reaches beyond the subject's own declaration.
	 *
	 * Structurally a paraphrase: grounded, legitimate, and adding little, since the declaration is
	 * what a reader already sees. Stored rather than refused, because refusing would teach citation
	 * padding; a visible grade invites a better answer instead.
	 */
	thin: boolean;
	/** Who wrote it. Absent when the caller did not say, which is different from claiming nobody. */
	model?: string;
	createdAt: number;
	/**
	 * Present while someone's declared distrust stands. A re-record that does not cite the doubt's
	 * id carries this forward onto the new answer rather than clearing it, so a writer who never
	 * looked cannot erase a warning.
	 */
	doubt?: Doubt;
}

/** What a recall gives back: the answer, and whether its ground has moved since. */
export interface RecalledAnswer {
	answer: Answer;
	/** Cited facts that no longer resolve. Empty means every input still holds. */
	stale: string[];
	/**
	 * Cited answers that still resolve but are themselves stale underneath.
	 *
	 * The cascade, walked rather than bookkept: a description leaning on a child's description
	 * inherits its doubt. Separate from `stale` because the remedies differ, re-affirm the child
	 * first versus rewrite this one.
	 */
	inheritedStale: string[];
	/**
	 * Cited answers that are doubted, directly or anywhere beneath them.
	 *
	 * Separate from `inheritedStale` for the same reason it is separate from `stale`: a doubted
	 * child needs its doubt addressed by someone who read the reason, while a stale one needs
	 * re-grounding on current facts.
	 */
	doubtedUpstream: string[];
}

export type RecordOutcome =
	| {
			recorded: true;
			answer: Answer;
			/**
			 * A doubt the previous answer carried that this write did NOT cite, so it rode forward.
			 * Stated on the outcome because the writer is the one person who can still address it.
			 */
			doubtCarried?: Doubt;
	  }
	| {
			recorded: false;
			reason: string;
			unresolved?: string[];
			/**
			 * Set when the supersede gate refused: the incumbent's still-live citations this write
			 * failed to cover. Re-cite them, or explain the omission in `omitting`.
			 */
			uncovered?: string[];
	  };

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
