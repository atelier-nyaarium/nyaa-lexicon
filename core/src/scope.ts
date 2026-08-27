import {
	ANONYMOUS_NAMESPACE,
	composeSymbolId,
	isSymbolId,
	isWithin,
	moduleOf,
	parseSymbolId,
	type SymbolId,
} from "@nyaa-lexicon/protocol";
import type { IndexStore, StoredDeclaration } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** A resolved `within`: one declaration whose descriptors every match must extend. */
export interface Scope {
	id: string;
	declaration: StoredDeclaration;
}

/** A SQL prefilter, over-inclusive by design; `contains` is the check that counts. */
export interface ScopeFilter {
	/** Same-module scope: ids in `[low, high)` share the scope's prefix. */
	module?: string;
	low?: string;
	high?: string;
	/** Namespace scope: `head` is the id up to the module field, `like` the descriptors after it. */
	head?: string;
	like?: string;
}

////////////////////////////////
//  Functions & Helpers

/** Every character a descriptor chain can end on, so a prefix always ends on one of these. */
const DESCRIPTOR_SUFFIXES = new Set(["/", "#", ".", ":", ")", "]"]);

/** The smallest string sorting after every id that extends `prefix`. */
export function successor(prefix: string): string {
	const points = Array.from(prefix);
	const last = points.at(-1);
	if (last === undefined || !DESCRIPTOR_SUFFIXES.has(last)) throw new Error("scope prefix has no safe successor");
	const code = last.codePointAt(0) as number;
	if (code === 0x10ffff) throw new Error("scope prefix has no safe successor");
	points[points.length - 1] = String.fromCodePoint(code + 1);
	return points.join("");
}

function samePath(left: StoredDeclaration, right: StoredDeclaration): boolean {
	const a = parseSymbolId(left.symbolId);
	const b = parseSymbolId(right.symbolId);
	return JSON.stringify(a?.descriptors) === JSON.stringify(b?.descriptors);
}

/** A namespace-qualified path names one thing wherever it is reopened; a bare one is per file. */
function spansModules(id: SymbolId): boolean {
	return id.descriptors.some((descriptor) => descriptor.kind === "namespace");
}

function ambiguous(within: string, matches: StoredDeclaration[]): Error {
	const candidates = matches
		.slice(0, 5)
		.map((candidate) => `\`${candidate.symbolId}\``)
		.join(", ");
	return new Error(`declaration named ${within} is ambiguous: ${candidates}. Pass one candidate id.`);
}

/** A symbol id, or a name that resolves to one declaration; a named public namespace spans files. */
export function resolveScope(store: IndexStore, within: string): Scope {
	if (isSymbolId(within)) {
		const declaration = store.declaration(within);
		if (declaration === null) throw new Error("no declaration has this id");
		if (parseSymbolId(within)?.local !== undefined) throw new Error("a local names no scope");
		return { id: within, declaration };
	}

	const named = store.declarationsNamed(within);
	if (named.length === 0) throw new Error(`no declaration named ${within}`);
	if (within === ANONYMOUS_NAMESPACE) throw ambiguous(within, named);
	// A constructor carries its class's name and sits inside it; the class is the scope meant.
	const matches = named.filter(
		(candidate) =>
			!named.some(
				(other) => other.symbolId !== candidate.symbolId && isWithin(candidate.symbolId, other.symbolId),
			),
	);
	if (matches.length === 1) {
		const declaration = matches[0] as StoredDeclaration;
		if (parseSymbolId(declaration.symbolId)?.local !== undefined) throw new Error("a local names no scope");
		return { id: declaration.symbolId, declaration };
	}

	const first = matches[0] as StoredDeclaration;
	const parsed = parseSymbolId(first.symbolId);
	const mergeable =
		parsed !== null &&
		spansModules(parsed) &&
		matches.every((candidate) => candidate.visibility === "public" && samePath(first, candidate));
	if (mergeable) return { id: first.symbolId, declaration: first };
	throw ambiguous(within, matches);
}

/** Structural, on the id alone: a dangling id still answers by what it spells. */
export function contains(scope: Scope, candidateId: string): boolean {
	const parsed = parseSymbolId(scope.id);
	const candidateModule = moduleOf(candidateId);
	if (parsed !== null && spansModules(parsed) && candidateModule !== null) {
		return isWithin(candidateId, composeSymbolId({ ...parsed, module: candidateModule }));
	}
	return isWithin(candidateId, scope.id);
}

/** Inside, and not the scope itself or one of its reopenings: a declaration is not within itself. */
export function strictlyContains(scope: Scope, candidateId: string): boolean {
	if (!contains(scope, candidateId)) return false;
	const depth = parseSymbolId(scope.id)?.descriptors.length ?? 0;
	return (parseSymbolId(candidateId)?.descriptors.length ?? 0) > depth;
}

/** Stands in for the module field so the grammar, not this file, decides where it sits. */
const MODULE_MARKER = "m";

export function filterFor(scope: Scope): ScopeFilter {
	const parsed = parseSymbolId(scope.id);
	if (parsed === null) return {};
	if (spansModules(parsed)) {
		const marked = composeSymbolId({ ...parsed, module: MODULE_MARKER });
		const at = marked.indexOf(` ${MODULE_MARKER} `);
		return { head: marked.slice(0, at + 1), like: marked.slice(at + MODULE_MARKER.length + 2) };
	}
	return { module: parsed.module, low: scope.id, high: successor(scope.id) };
}
