// One module's containment: what groups, what is local, and who owns a local's evidence.

import { GROUPING_KINDS, parseSymbolId, type Range, RUNNING_KINDS } from "@nyaa-lexicon/protocol";
import type { StoredDeclaration } from "./store.js";

////////////////////////////////
//  Functions & Helpers

/** Explicit contains, else kind. */
function containsLocals(declaration: StoredDeclaration): boolean {
	if (declaration.contains !== undefined) return declaration.contains === "locals";
	return RUNNING_KINDS.has(declaration.kind);
}

function bySource(a: StoredDeclaration, b: StoredDeclaration): number {
	return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
}

function isParameter(declaration: StoredDeclaration): boolean {
	if (declaration.visibility === "local") return true;
	const parsed = parseSymbolId(declaration.symbolId);
	return parsed?.local !== undefined || parsed?.descriptors.at(-1)?.kind === "parameter";
}

/** Rows read for each id, merged in source order. */
export function inSourceOrder<T extends { range: Range }>(
	ids: readonly string[],
	read: (symbolId: string) => T[],
): T[] {
	return ids
		.flatMap(read)
		.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

////////////////////////////////
//  Class

export class Containment {
	private readonly byId: Map<string, StoredDeclaration>;
	private readonly ordered: StoredDeclaration[];
	private readonly children = new Map<string, StoredDeclaration[]>();
	private readonly locality = new Map<string, boolean>();
	private members: Map<string | undefined, StoredDeclaration[]> | undefined;
	private owned: Map<string, string[]> | undefined;

	constructor(declarations: readonly StoredDeclaration[]) {
		this.byId = new Map(declarations.map((declaration) => [declaration.symbolId, declaration]));
		this.ordered = [...declarations].sort(bySource);
		for (const declaration of this.ordered) {
			if (declaration.containerId === undefined) continue;
			const siblings = this.children.get(declaration.containerId);
			if (siblings === undefined) this.children.set(declaration.containerId, [declaration]);
			else siblings.push(declaration);
		}
	}

	/** Containers above a declaration, nearest first, and whether the chain loops. */
	private ancestry(declaration: StoredDeclaration): { ancestors: StoredDeclaration[]; cyclic: boolean } {
		const ancestors: StoredDeclaration[] = [];
		const seen = new Set([declaration.symbolId]);
		let next = declaration.containerId;
		while (next !== undefined) {
			if (seen.has(next)) return { ancestors, cyclic: true };
			const container = this.byId.get(next);
			if (container === undefined) break;
			seen.add(next);
			ancestors.push(container);
			next = container.containerId;
		}
		return { ancestors, cyclic: false };
	}

	/** Parameter or local-holding ancestor. */
	isLocal(declaration: StoredDeclaration): boolean {
		const known = this.locality.get(declaration.symbolId);
		if (known !== undefined) return known;
		const local = isParameter(declaration) || this.ancestry(declaration).ancestors.some(containsLocals);
		this.locality.set(declaration.symbolId, local);
		return local;
	}

	/** The declaration itself when it is not local, else the nearest container that is not. */
	private nearestNonLocal(declaration: StoredDeclaration): StoredDeclaration | null {
		if (!this.isLocal(declaration)) return declaration;
		return this.ancestry(declaration).ancestors.find((ancestor) => !this.isLocal(ancestor)) ?? null;
	}

	/** Locals whose evidence belongs to this declaration, in source order. */
	localsOwnedBy(symbolId: string): string[] {
		if (this.owned === undefined) {
			const owned = new Map<string, string[]>();
			for (const declaration of this.ordered) {
				if (!this.isLocal(declaration)) continue;
				const owner = this.nearestNonLocal(declaration);
				if (owner === null) continue;
				const locals = owned.get(owner.symbolId);
				if (locals === undefined) owned.set(owner.symbolId, [declaration.symbolId]);
				else locals.push(declaration.symbolId);
			}
			this.owned = owned;
		}
		return this.owned.get(symbolId) ?? [];
	}

	/** The outermost declaration below the grouping kinds; null for a grouping alone or a loop. */
	topLevel(symbolId: string): StoredDeclaration | null {
		const declaration = this.byId.get(symbolId);
		if (declaration === undefined) return null;
		const { ancestors, cyclic } = this.ancestry(declaration);
		if (cyclic) return null;
		return [declaration, ...ancestors].findLast((candidate) => !GROUPING_KINDS.has(candidate.kind)) ?? null;
	}

	/**
	 * Declared members in source order, grouping kinds seen through: a namespace's classes are top level.
	 * A grouping declaration's members are what sits in it through groupings alone.
	 */
	membersOf(symbolId: string | undefined): StoredDeclaration[] {
		const container = symbolId === undefined ? undefined : this.byId.get(symbolId);
		if (container !== undefined && GROUPING_KINDS.has(container.kind)) {
			return this.ordered.filter((candidate) => {
				if (GROUPING_KINDS.has(candidate.kind)) return false;
				const { ancestors } = this.ancestry(candidate);
				const at = ancestors.findIndex((ancestor) => ancestor.symbolId === symbolId);
				return at !== -1 && ancestors.slice(0, at).every((ancestor) => GROUPING_KINDS.has(ancestor.kind));
			});
		}
		if (this.members === undefined) {
			const members = new Map<string | undefined, StoredDeclaration[]>();
			for (const declaration of this.ordered) {
				if (GROUPING_KINDS.has(declaration.kind)) continue;
				const holder = this.ancestry(declaration).ancestors.find(
					(ancestor) => !GROUPING_KINDS.has(ancestor.kind),
				)?.symbolId;
				const list = members.get(holder);
				if (list === undefined) members.set(holder, [declaration]);
				else list.push(declaration);
			}
			this.members = members;
		}
		return this.members.get(symbolId) ?? [];
	}

	/** Direct children that are not local, in source order. */
	declaredChildren(symbolId: string): StoredDeclaration[] {
		return (this.children.get(symbolId) ?? []).filter((child) => !this.isLocal(child));
	}

	/** A declaration and everything whose container chain reaches it. */
	descendantIds(symbolId: string): Set<string> {
		const found = new Set<string>();
		const pending = [symbolId];
		while (pending.length > 0) {
			const next = pending.pop() as string;
			if (found.has(next)) continue;
			found.add(next);
			for (const child of this.children.get(next) ?? []) pending.push(child.symbolId);
		}
		return found;
	}
}
