// Where a name lives and which declaration it reaches: the scope chain, identity, and settlement.

import { comparePositions, composeSymbolId, type Descriptor, type Position, type Range } from "@nyaa-lexicon/protocol";
import {
	type BashDeclaration,
	type BashReference,
	type DeclareOptions,
	LANGUAGE,
	pushReference,
	type Scope,
	type Walk,
} from "./context.js";

////////////////////////////////
//  Interfaces & Types

interface ResolveOptions extends Pick<DeclareOptions, "local" | "global"> {
	/** The use's position; a local of the same function declared after it is not reached. */
	at?: Position;
}

////////////////////////////////
//  Functions & Helpers

export function subshell(scope: Scope): Scope {
	return {
		...(scope.fromId === undefined ? {} : { fromId: scope.fromId }),
		...(scope.descriptor === undefined ? {} : { descriptor: scope.descriptor }),
		locals: new Map(),
		parent: scope,
		confined: true,
	};
}

/** Inside a subshell at any depth, nothing reaches the file's variables, `-g` included. */
export function confinedIn(scope: Scope): boolean {
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) if (s.confined) return true;
	return false;
}

function encloses(outer: Scope, inner: Scope): boolean {
	for (let s: Scope | undefined = inner; s !== undefined; s = s.parent) if (s === outer) return true;
	return false;
}

/** The declaration a name reaches: the nearest enclosing local, then the file's variable. */
export function resolve(w: Walk, scope: Scope, name: string, options: ResolveOptions): BashDeclaration | undefined {
	if (options.global) return w.out.globalsByName.get(name);
	if (options.local) return scope.locals.get(name);
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
		const local = s.locals.get(name);
		if (local === undefined) continue;
		// An enclosing function's local is live whenever this body runs, wherever it was declared.
		const live = options.at === undefined || s.fromId !== scope.fromId;
		if (live || comparePositions(local.range.start, options.at as Position) <= 0) return local;
	}
	return w.out.globalsByName.get(name);
}

/** A repeated name path carries an occurrence, so what it holds nests under its own definition. */
function mint(w: Walk, descriptors: Descriptor[]): string {
	const base = composeSymbolId({ language: LANGUAGE, module: w.module, descriptors });
	const seen = (w.minted.get(base) ?? 0) + 1;
	w.minted.set(base, seen);
	if (seen === 1) return base;
	const last = descriptors.at(-1) as Descriptor;
	return composeSymbolId({
		language: LANGUAGE,
		module: w.module,
		descriptors: [...descriptors.slice(0, -1), { ...last, occurrence: seen }],
	});
}

export function declare(
	w: Walk,
	scope: Scope,
	name: string,
	selection: Range,
	range: Range,
	options: DeclareOptions,
): BashDeclaration {
	const confined = options.local || scope.confined;
	const nested = confined && scope.descriptor !== undefined;
	const own: Descriptor = { kind: options.kind === "function" ? "method" : "term", name };
	const declaration: BashDeclaration = {
		symbolId: mint(w, nested && scope.descriptor !== undefined ? [scope.descriptor, own] : [own]),
		kind: options.kind,
		...(options.languageKind === undefined ? {} : { languageKind: options.languageKind }),
		name,
		range,
		selectionRange: selection,
		visibility: confined ? "local" : "public",
		...(options.exported === undefined ? {} : { exported: options.exported }),
		...(nested && scope.fromId !== undefined ? { containerId: scope.fromId } : {}),
		...(options.declaredType === undefined ? {} : { declaredType: options.declaredType }),
	};
	w.out.declarations.push(declaration);
	if (options.kind === "function") {
		w.definedIn.set(declaration, scope);
		const definitions = w.out.functionsByName.get(name);
		if (definitions === undefined) w.out.functionsByName.set(name, [declaration]);
		else definitions.push(declaration);
	} else if (confined) scope.locals.set(name, declaration);
	else w.out.globalsByName.set(name, declaration);
	return declaration;
}

/** An assignment declares a name the first time and writes it after. */
export function declareOrWrite(
	w: Walk,
	scope: Scope,
	name: string,
	selection: Range,
	range: Range,
	options: DeclareOptions,
): void {
	const existing = resolve(w, scope, name, options);
	if (existing !== undefined) {
		pushReference(w, scope, { name, range: selection, role: "write", target: existing.symbolId });
		return;
	}
	declare(w, scope, name, selection, range, options);
}

/** A call at the top level reaches the definition before it; inside a function, the last in the file. */
function functionFor(w: Walk, scope: Scope, reference: BashReference): BashDeclaration | undefined {
	const definitions = (w.out.functionsByName.get(reference.name) ?? []).filter((definition) => {
		const home = w.definedIn.get(definition);
		return home === undefined || !home.confined || encloses(home, scope);
	});
	if (scope.fromId !== undefined) return definitions.at(-1);
	let found: BashDeclaration | undefined;
	for (const definition of definitions) {
		if (comparePositions(definition.range.start, reference.range.start) < 0) found = definition;
	}
	return found;
}

/** A name settles once every declaration is known, against the scope it was read in. */
export function settle(w: Walk): void {
	for (const { reference, scope } of w.pending) {
		if (reference.role === "import") {
			w.out.references.push(reference);
			continue;
		}
		const target =
			reference.target ??
			(reference.ofFunction
				? functionFor(w, scope, reference)
				: resolve(w, scope, reference.name, { local: false, at: reference.range.start })
			)?.symbolId;
		w.out.references.push(target === undefined ? reference : { ...reference, target });
	}
}
