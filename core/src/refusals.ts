// Every refusal the knowledge layer composes. A refusal names what the author did and what to do
// instead; the ledger and the checker call in and compose none: the brand refuses a raw string
// and a residue refuses the cast.

import { decodeModuleField, FACT_SCHEME, parseSymbolIdResult } from "@nyaa-lexicon/protocol";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Types

declare const refusalBrand: unique symbol;

/** A sentence this module minted; a reason slot typed with it refuses a raw string. */
export type Refusal = string & { readonly [refusalBrand]: true };

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
	const more = rest > 0 ? `, and ${rest} more` : "";
	return mint(`${symbolId} is not in the index. ${module} holds ${shown.join(", ")}${more}`);
}

export function unknownModule(symbolId: string, module: string): Refusal {
	return mint(`${symbolId} is not in the index, and neither is ${module}`);
}

/** A spelling the grammar refuses, with no module readable from it to shortlist. */
export function unparsableId(symbolId: string, failure: string): Refusal {
	return mint(`${symbolId} is not a symbol id: ${failure}`);
}

/**
 * Why a subject id names no declaration: a fact id in the subject slot, an id the module never
 * minted, a module not indexed, or a spelling the grammar refuses. Never "not in the index" alone.
 */
export function subjectRefused(symbolId: string, store: IndexStore): Refusal {
	if (symbolId.startsWith(`${FACT_SCHEME} `)) return factIdAsSubject(symbolId);

	const parsed = parseSymbolIdResult(symbolId);
	const module = parsed.ok ? parsed.value.module : moduleFieldOf(symbolId);
	const neighbours = module === null ? [] : store.declarationsIn(module);
	if (module !== null && neighbours.length > 0) {
		// The name the author typed is somewhere in the bad id, so declarations carrying it lead.
		const named = (declaration: { name: string }) => Number(symbolId.includes(declaration.name));
		const shown = [...neighbours]
			.sort((a, b) => named(b) - named(a))
			.slice(0, NEIGHBOURS_SHOWN)
			.map((declaration) => `\`${declaration.symbolId}\``);
		return unmintedId(symbolId, module, shown, neighbours.length - shown.length);
	}

	if (!parsed.ok) return unparsableId(symbolId, parsed.failure.message);
	return unknownModule(symbolId, parsed.value.module);
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
