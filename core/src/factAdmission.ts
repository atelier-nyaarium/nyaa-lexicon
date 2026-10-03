// One reading of every symbol id a provider hands the index, before any of it is written.
// Refused before the transaction, so the file's previous facts survive.

import type {
	AllList,
	Declaration,
	DocRegion,
	Export,
	ExportTarget,
	FileRole,
	Import,
	Landing,
	Literal,
	Range,
	Reference,
	ScopeContribution,
} from "@nyaa-lexicon/protocol";
import { composeSymbolId, isCanonicalModule, moduleOf, parseSymbolIdResult } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** What a provider's parse contributes that carries a symbol id or names an import edge. */
export interface ProviderFacts {
	declarations: Declaration[];
	references: Reference[];
	literals: Literal[];
	docs: DocRegion[];
	role?: FileRole | undefined;
	imports?: Import[] | undefined;
	exports?: Export[] | undefined;
	allList?: AllList | undefined;
	/** Where the file's specifiers landed, and the provider that answered, which a scope must name. */
	landings?: readonly Landing[] | undefined;
	provider?: string | null | undefined;
	scopeContributions?: readonly ScopeContribution[] | undefined;
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
	const kinds = new Map<string, string>();
	for (const declaration of facts.declarations) {
		const why = notCanonical(declaration.symbolId);
		if (why !== null) refuse(module, `declaration id ${JSON.stringify(declaration.symbolId)} is refused: ${why}`);
		if (moduleOf(declaration.symbolId) !== module) {
			refuse(module, `declaration ${declaration.symbolId} names another module`);
		}
		// The store holds one row per id; a second would silently replace the first.
		if (kinds.has(declaration.symbolId)) refuse(module, `declaration ${declaration.symbolId} is declared twice`);
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
	if (facts.role?.kind === "entry" && facts.role.how === "main" && facts.role.symbolId !== undefined) {
		declaredHere("entry point", facts.role.symbolId);
	}

	// An import edge is named by its span, so no two may share one.
	const edges = new Set<string>();
	for (const statement of facts.imports ?? []) {
		for (const edge of statement.edges) {
			const key = spanKey(edge.span);
			if (edges.has(key)) refuse(module, `two import edges share the span ${key}`);
			edges.add(key);
		}
	}
	const targeted = (what: string, target: ExportTarget): void => {
		if (target.kind === "symbol") declaredHere(what, target.symbolId);
		else if (target.kind === "import" && !edges.has(spanKey(target.span))) {
			refuse(module, `${what} names no import edge at ${spanKey(target.span)}`);
		}
	};
	for (const edge of facts.exports ?? []) targeted(`export ${edge.name ?? "*"}`, edge.target);
	if (facts.allList?.state === "static") {
		for (const entry of facts.allList.entries) targeted(`allList entry ${entry.name}`, entry.target);
	}
	for (const reference of facts.references) {
		if (reference.origin?.kind === "import" && !edges.has(spanKey(reference.origin.span))) {
			refuse(module, `reference ${reference.name} resolves through no import edge`);
		}
	}
	for (const landing of facts.landings ?? []) {
		if (landing.kind === "module" && !isCanonicalModule(landing.module)) {
			refuse(module, `a landing names ${JSON.stringify(landing.module)}, which is no workspace module`);
		}
		if (landing.kind !== "module" && landing.providerId !== facts.provider) {
			refuse(module, `a scope landing names provider ${landing.providerId}`);
		}
	}
	const contributions = facts.scopeContributions ?? [];
	if (contributions.length > 0 && !facts.provider) refuse(module, "a scope contribution names no provider");
	for (const scope of contributions) {
		for (const member of scope.members) declaredHere(`scope ${scope.scopeId} member`, member);
	}
}

/** An edge's span, as one key. */
export function spanKey(range: Range): string {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}
