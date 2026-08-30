// Every refusal the knowledge layer composes. A refusal names what the author did and what to do
// instead; the ledger and the checker call in and compose none: the brand refuses a raw string
// and a residue refuses the cast.

import { decodeModuleField, FACT_SCHEME, isLocalSymbol, parseSymbolIdResult, spellsName } from "@nyaa-lexicon/protocol";
import { candidatesFor } from "./candidates.js";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Types

declare const refusalBrand: unique symbol;

/** A sentence this module minted; a reason slot typed with it refuses a raw string. */
export type Refusal = string & { readonly [refusalBrand]: true };

/** The closed outcomes of asking about an id that names no declaration. */
export type DiagnosisKind = "factIdAsSubject" | "unminted" | "moved" | "stranded" | "waiting" | "unknown";

/** One diagnosis, reached from every tool: the kind, its sentence, and what a reader might mean instead. */
interface Diagnosed<K extends DiagnosisKind> {
	kind: K;
	reason: Refusal;
	/** The shortlist for an unminted id, the same-name-and-kind declarations for a stranded one. */
	candidates: string[];
}

/** Only a vacated address forwards, so only `moved` carries where. */
export type SubjectDiagnosis =
	| Diagnosed<Exclude<DiagnosisKind, "moved">>
	| (Diagnosed<"moved"> & { forwardedTo: string });

////////////////////////////////
//  Constants

/** How many neighbours a refusal names before the list stops helping. */
const NEIGHBOURS_SHOWN = 8;

////////////////////////////////
//  Functions & Helpers

/** The one cast. */
function mint(text: string): Refusal {
	return text as Refusal;
}

////////////////////////////////
//  Recording

export function needsProse(): Refusal {
	return mint(`an answer needs prose. Send the sentence or two the cited facts establish in \`prose\``);
}

export function proseTooLong(max: number, length: number): Refusal {
	return mint(`an answer is at most ${max} characters, and this is ${length}`);
}

export function noDoubtStands(question: string, symbolId: string): Refusal {
	return mint(
		`no doubt stands on the ${question} answer about ${symbolId}, so omit \`resolvesDoubt\`. To raise one, call \`invalidate_answer\``,
	);
}

export function wrongDoubtId(): Refusal {
	return mint(`resolvesDoubt does not name the standing doubt. Recall the answer and cite the doubt id it shows`);
}

export function replacesSoundAnswer(): Refusal {
	return mint(
		`this replaces an answer whose every cited input still holds. Cite the facts it cited too, or explain what you are dropping and why in \`omitting\``,
	);
}

////////////////////////////////
//  Doubting

export function doubtNeedsReason(): Refusal {
	return mint(`a doubt needs a reason: it is what the next writer reads`);
}

export function nothingToDoubt(symbolId: string): Refusal {
	return mint(
		`nothing is recorded about ${symbolId}, so there is no answer to doubt. Doubting an unwritten answer asks for one, and \`record_answer\` writes it`,
	);
}

////////////////////////////////
//  Re-affirming

export function noAnswerToReaffirm(question: string, symbolId: string): Refusal {
	return mint(`no ${question} answer is recorded about ${symbolId}. record_answer writes a new one`);
}

export function citationsNoLongerResolve(count: number): Refusal {
	return mint(
		`${count} citation${count === 1 ? "" : "s"} no longer resolve${count === 1 ? "s" : ""}. Check the prose against symbol_facts, then re-affirm again passing the replacement citations`,
	);
}

export function nothingToReaffirm(): Refusal {
	return mint(
		`this answer is already sound: every citation resolves and no doubt stands. Re-affirming changes nothing. To replace its prose call \`record_answer\`; to doubt it call \`invalidate_answer\``,
	);
}

export function clearingRequiresCiting(): Refusal {
	return mint(
		`clearing a doubt requires citing it. Recall the answer, read the doubt's reason, and pass its id as resolvesDoubt`,
	);
}

////////////////////////////////
//  Citations

export function citesNothing(): Refusal {
	return mint(`an answer must cite the facts it was drawn from, and this cites none`);
}

export function malformedCitations(count: number): Refusal {
	return mint(
		`${count} citation${count === 1 ? " is" : "s are"} not a fact id at all. Cite the id exactly as symbol_facts prints it, the whole space-separated line ending in the digest, never the trailing digest alone`,
	);
}

export function unresolvedCitations(count: number): Refusal {
	return mint(
		`${count} cited fact${count === 1 ? " does" : "s do"} not resolve. Either the index re-derived its facts since these ids were fetched, in which case call symbol_facts again and cite the current ids, or the id was invented, which this check exists to refuse`,
	);
}

export function citesOnlyNeighbours(symbolId: string): Refusal {
	return mint(`nothing cited here is a fact about ${symbolId}. Citing only its neighbours describes them, not it`);
}

////////////////////////////////
//  Subject diagnoses

export function factIdAsSubject(symbolId: string): Refusal {
	return mint(
		`${symbolId} is a fact id, not a symbol id. Cite it in \`citations\` and name the symbol it belongs to in \`symbolId\``,
	);
}

export function unmintedId(symbolId: string, module: string, shown: string[], rest: number): Refusal {
	const held = shown.length === 0 ? "no declarations" : `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
	return mint(`${symbolId} is not in the index. ${module} holds ${held}`);
}

export function unknownModule(symbolId: string, module: string): Refusal {
	return mint(`${symbolId} is not in the index, and neither is ${module}`);
}

/** A spelling the grammar refuses, with no module readable from it to shortlist. */
export function unparsableId(symbolId: string, failure: string): Refusal {
	return mint(`${symbolId} is not a symbol id: ${failure}`);
}

export function movedId(symbolId: string, to: string, evidence: string): Refusal {
	return mint(
		`${symbolId} was rebound to ${to} (${evidence}), and the knowledge recorded about it is recalled there. Ask about ${to}`,
	);
}

/** An address a subject still names and the index no longer holds; the candidates are for a person to read. */
export function strandedId(
	symbolId: string,
	held: "answers" | "demand",
	since: number | null,
	evidence: string | null,
	candidates: string[],
	local: boolean,
): Refusal {
	const what = held === "answers" ? `the answers about ${symbolId}` : `the demand recorded against ${symbolId}`;
	const dated =
		since === null ? "" : `, orphaned at ${new Date(since).toISOString()}, and deletion follows thirty days after`;
	const judged = evidence === "ambiguous" ? " (more than one declaration could have been it)" : "";
	const shown = candidates.slice(0, NEIGHBOURS_SHOWN).map((candidate) => `\`${candidate}\``);
	const rest = candidates.length - shown.length;
	const where = local
		? "; a local has no candidates, since its ordinal names no chain"
		: candidates.length === 0
			? "; nothing else in the index carries its name and kind"
			: `: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
	return mint(
		`${what} belong to a subject whose address no longer resolves${dated}${judged}. Record the prose again where a reader will find it${where}`,
	);
}

export function waitingOnParseFailure(symbolId: string, module: string, reason: string): Refusal {
	return mint(
		`${symbolId} is waiting on ${module}, which is present and not parsing (${reason}); nothing about it is orphaned or deleted while that holds. Fix the parse, then ask again`,
	);
}

/**
 * Why a subject id names no declaration, as one value every tool reaches: the closed kind, the
 * sentence, the ids a reader might mean, and where a vacated address forwards. Never "not in the
 * index" alone.
 */
export function diagnoseSubject(symbolId: string, store: IndexStore): SubjectDiagnosis {
	if (symbolId.startsWith(`${FACT_SCHEME} `)) {
		return { kind: "factIdAsSubject", reason: factIdAsSubject(symbolId), candidates: [] };
	}

	const parsed = parseSymbolIdResult(symbolId);
	const module = parsed.ok ? parsed.value.module : moduleFieldOf(symbolId);

	// What the identity owner last left at the address decides the wording before any shortlist.
	const status = store.subjects.stateOf(symbolId, (of) => store.parseFailureOf(of)?.reason ?? null);
	if (status.subject === null && status.forwardedTo !== null) {
		return {
			kind: "moved",
			reason: movedId(symbolId, status.forwardedTo, status.evidence ?? "none"),
			candidates: [],
			forwardedTo: status.forwardedTo,
		};
	}
	if (status.subject !== null && !status.resolves) {
		// Only a bound subject waits; an orphan under a failing module was judged before it failed.
		if (status.exempt && status.state === "bound") {
			return {
				kind: "waiting",
				reason: waitingOnParseFailure(symbolId, module ?? "", status.reason ?? ""),
				candidates: [],
			};
		}
		const candidates = candidatesFor(store, symbolId);
		return {
			kind: "stranded",
			reason: strandedId(
				symbolId,
				status.answers > 0 ? "answers" : "demand",
				status.orphanedAt,
				status.evidence,
				candidates,
				isLocalSymbol(symbolId),
			),
			candidates,
		};
	}
	// An indexed module is unminted territory even when it holds nothing; an unindexed one is unknown.
	const neighbours = module !== null && store.depthOf(module) !== null ? store.declarationsIn(module) : null;
	if (module !== null && neighbours !== null) {
		// Declarations the bad id spells lead: a parsed descriptor, or a whole token of the unparsed rest.
		const spells = spellsName(symbolId);
		const named = (declaration: { name: string }) => Number(spells(declaration.name));
		const shown = [...neighbours]
			.sort((a, b) => named(b) - named(a))
			.slice(0, NEIGHBOURS_SHOWN)
			.map((declaration) => declaration.symbolId);
		return {
			kind: "unminted",
			reason: unmintedId(
				symbolId,
				module,
				shown.map((id) => `\`${id}\``),
				neighbours.length - shown.length,
			),
			candidates: shown,
		};
	}

	if (!parsed.ok) return { kind: "unknown", reason: unparsableId(symbolId, parsed.failure.message), candidates: [] };
	return { kind: "unknown", reason: unknownModule(symbolId, parsed.value.module), candidates: [] };
}

/** The diagnosis's sentence, for a reason slot. */
export function subjectRefused(symbolId: string, store: IndexStore): Refusal {
	return diagnoseSubject(symbolId, store).reason;
}

/** The module an unparseable id still names in its third field, decoded as the grammar would. */
function moduleFieldOf(symbolId: string): string | null {
	const field = symbolId.split(" ")[2];
	if (field === undefined || field === "") return null;
	try {
		return decodeModuleField(field);
	} catch {
		return null;
	}
}
