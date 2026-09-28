// Name lookup through the scopes a C declaration sits in: its container's, then each around it, then
// the file's. Tags and ordinary names are separate namespaces. A block's name is in scope from just
// past its declarator to the block's end, and an inner block's hides an outer one's; the file's names
// are one linkage, so order does not hide them.

import { MAX_NESTING, parseSymbolId } from "@nyaa-lexicon/protocol";
import type { CDeclaration } from "./model.js";

////////////////////////////////
//  Interfaces & Types

/** A parse's declarations by name and by id. */
export interface DeclarationIndex {
	declarationsByName: ReadonlyMap<string, CDeclaration[]>;
	declarationsById: ReadonlyMap<string, CDeclaration>;
	/** By `scopeKey`: each name's declarations directly in one scope. */
	declarationsByScope: ReadonlyMap<string, CDeclaration[]>;
}

/** Where a name is looked up: the innermost scope, and the token it is read at when known. */
export interface Place {
	scopeId: string | undefined;
	at?: number;
}

////////////////////////////////
//  Constants

const TAG_KINDS: ReadonlySet<string> = new Set(["struct", "enum"]);

const TYPEDEF_KINDS: ReadonlySet<string> = new Set(["class"]);

/** What an ordinary name can declare besides a typedef; a field is a member, not in scope. */
const OBJECT_KINDS: ReadonlySet<string> = new Set(["variable", "constant", "function"]);

////////////////////////////////
//  Functions & Helpers

/** The `declarationsByScope` key of `name` in `scopeId`, the file when undefined. */
export function scopeKey(scopeId: string | undefined, name: string): string {
	return `${scopeId ?? ""}\u0000${name}`;
}

/** The declarations of `name` directly in `scopeId`, in source order. */
export function declaredIn(index: DeclarationIndex, name: string, scopeId: string | undefined): CDeclaration[] {
	return index.declarationsByScope.get(scopeKey(scopeId, name)) ?? [];
}

/**
 * The scope C gives `declaration`'s name when that is not its container: an enumerator's or a tag's
 * nested in an aggregate belongs to the function or file around the aggregates. Undefined is the file.
 */
export function lexicalScope(
	index: Pick<DeclarationIndex, "declarationsById">,
	declaration: CDeclaration,
): { scope: string | undefined } | undefined {
	const holder =
		declaration.containerId === undefined ? undefined : index.declarationsById.get(declaration.containerId);
	if (holder === undefined || holder.kind === "function") return undefined;
	// Only an enumerator is a constant with a holder other than a function.
	if (declaration.kind !== "constant" && !TAG_KINDS.has(declaration.kind)) return undefined;
	let scope = holder.containerId;
	for (let depth = 0; scope !== undefined && depth < MAX_NESTING; depth++) {
		const around = index.declarationsById.get(scope);
		if (around === undefined || around.kind === "function") break;
		scope = around.containerId;
	}
	return { scope };
}

/** Whether `declaration` is in scope at token `at`: a file's name always, a block's from its declarator to the block's end. */
export function visibleAt(declaration: CDeclaration, at: number | undefined): boolean {
	const scope = declaration.scope;
	return at === undefined || scope === undefined || (scope.from <= at && at <= scope.close);
}

/** The declarations of the innermost block among `found`, which hide the rest. */
export function innermost(found: CDeclaration[]): CDeclaration[] {
	let open = -1;
	for (const declaration of found) open = Math.max(open, declaration.scope?.open ?? -1);
	return open < 0 ? found : found.filter((declaration) => declaration.scope?.open === open);
}

/** `scopeId`, each container around it, then the file as undefined. */
function scopeChain(index: DeclarationIndex, scopeId: string | undefined): Array<string | undefined> {
	const chain: Array<string | undefined> = [];
	for (let scope = scopeId; scope !== undefined && !chain.includes(scope); ) {
		chain.push(scope);
		scope = index.declarationsById.get(scope)?.containerId;
	}
	chain.push(undefined);
	return chain;
}

/** The declarations of `name` whose kind is in `kinds`, in the nearest scope holding any in scope. */
function nearest(index: DeclarationIndex, name: string, kinds: ReadonlySet<string>, place: Place): CDeclaration[] {
	if (!index.declarationsByName.has(name)) return [];
	for (const scope of scopeChain(index, place.scopeId)) {
		const found = declaredIn(index, name, scope).filter(
			(declaration) =>
				kinds.has(declaration.kind) && declaration.languageKind !== "macro" && visibleAt(declaration, place.at),
		);
		if (found.length > 0) return innermost(found);
	}
	return [];
}

/** The type `name` names at `place`: a tag after `struct`, else a typedef, else a bare tag. */
export function typeCandidates(index: DeclarationIndex, name: string, tag: boolean, place: Place): CDeclaration[] {
	if (tag) return nearest(index, name, TAG_KINDS, place);
	const aliases = nearest(index, name, TYPEDEF_KINDS, place);
	return aliases.length > 0 ? aliases : nearest(index, name, TAG_KINDS, place);
}

/** The one type among `found`, a definition over forward declarations. */
export function oneType(found: readonly CDeclaration[]): CDeclaration | undefined {
	if (found.length === 1) return found[0];
	const defined = found.filter((candidate) => candidate.isDefinition === true);
	return defined.length === 1 ? defined[0] : undefined;
}

/**
 * `candidates` less each ordinary name a macro of its file hides: one whose branch holds the name's,
 * as preprocessing replaces the name first.
 */
export function macrosFirst(candidates: CDeclaration[]): CDeclaration[] {
	const macros = candidates.filter((candidate) => candidate.languageKind === "macro");
	if (macros.length === 0) return candidates;
	const moduleOf = (declaration: CDeclaration) => parseSymbolId(declaration.symbolId)?.module;
	return candidates.filter(
		(candidate) =>
			candidate.languageKind === "macro" ||
			!macros.some(
				(macro) =>
					encloses(macro.conditionalKey, candidate.conditionalKey) && moduleOf(macro) === moduleOf(candidate),
			),
	);
}

/** Whether branch key `outer` is `inner` or a branch around it. */
function encloses(outer: string, inner: string): boolean {
	return outer === "" || inner === outer || inner.startsWith(`${outer}|`);
}

/** The object-like macros among `candidates`, which may spell a type. */
export function typeMacros(candidates: readonly CDeclaration[]): CDeclaration[] {
	return candidates.filter((candidate) => candidate.languageKind === "macro" && candidate.kind === "constant");
}

/** Whether an object `name` is in scope at `place`. */
export function namesObject(index: DeclarationIndex, name: string, place: Place): boolean {
	return nearest(index, name, OBJECT_KINDS, place).length > 0;
}

/** Whether the ordinary `name` seen at `place` is a typedef; an object declared nearer hides one. */
export function namesTypedef(index: DeclarationIndex, name: string, place: Place): boolean {
	const types = nearest(index, name, TYPEDEF_KINDS, place)[0];
	if (types === undefined) return false;
	const objects = nearest(index, name, OBJECT_KINDS, place)[0];
	if (objects === undefined) return true;
	const chain = scopeChain(index, place.scopeId);
	return chain.indexOf(types.containerId) <= chain.indexOf(objects.containerId);
}
