// One reading of every symbol id a provider hands the index, before any of it is written.
// Refused before the transaction, so the file's previous facts survive.

import type { Declaration, DocRegion, Literal, Reference } from "@nyaa-lexicon/protocol";
import { composeSymbolId, moduleOf, parseSymbolIdResult } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** What a provider's parse contributes that carries a symbol id. */
export interface ProviderFacts {
	declarations: Declaration[];
	references: Reference[];
	literals: Literal[];
	docs: DocRegion[];
}

/** A provider contract violation; the file is not written. */
export class FactAdmissionError extends Error {}

////////////////////////////////
//  Functions & Helpers

function refuse(module: string, what: string): never {
	throw new FactAdmissionError(`${module}: ${what}`);
}

/** Null when the text is a symbol id spelled the one way the composer spells it. */
export function notCanonical(id: string): string | null {
	const parsed = parseSymbolIdResult(id);
	if (!parsed.ok) return parsed.failure.message;
	const spelled = composeSymbolId(parsed.value);
	return spelled === id ? null : `its canonical spelling is ${JSON.stringify(spelled)}`;
}

/** Throws on the first id that does not mean what its field says. */
export function admitFacts(module: string, facts: ProviderFacts): void {
	// Last declaration wins, as the store keeps it.
	const kinds = new Map<string, string>();
	for (const declaration of facts.declarations) {
		const why = notCanonical(declaration.symbolId);
		if (why !== null) refuse(module, `declaration id ${JSON.stringify(declaration.symbolId)} is refused: ${why}`);
		if (moduleOf(declaration.symbolId) !== module) {
			refuse(module, `declaration ${declaration.symbolId} names another module`);
		}
		kinds.set(declaration.symbolId, declaration.kind);
	}

	// Only canonical, same-module ids reach the map.
	const declaredHere = (what: string, id: string): void => {
		if (kinds.has(id)) return;
		const why = notCanonical(id);
		if (why !== null) refuse(module, `${what} ${JSON.stringify(id)} is refused: ${why}`);
		refuse(module, `${what} ${id} is not declared in this file`);
	};

	for (const declaration of facts.declarations) {
		if (declaration.containerId === undefined) continue;
		if (declaration.containerId === declaration.symbolId) refuse(module, `${declaration.symbolId} contains itself`);
		declaredHere("container", declaration.containerId);
	}
	for (const reference of facts.references) {
		if (reference.fromId !== undefined) declaredHere("reference owner", reference.fromId);
		if (reference.binding.status !== "bound") continue;
		const why = notCanonical(reference.binding.symbolId);
		if (why !== null)
			refuse(module, `binding target ${JSON.stringify(reference.binding.symbolId)} is refused: ${why}`);
	}
	for (const literal of facts.literals) {
		if (literal.containerId !== undefined) declaredHere("literal container", literal.containerId);
	}
	for (const region of facts.docs) {
		if (region.anchorId === undefined) continue;
		declaredHere("document anchor", region.anchorId);
		if (kinds.get(region.anchorId) !== "heading")
			refuse(module, `document anchor ${region.anchorId} is not a heading`);
	}
}
