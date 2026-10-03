// What a file's `use` trees and `pub` items state about the names crossing its boundary.

import type {
	Certainty,
	Conflict,
	Export,
	Import,
	ImportEdge,
	ScopeContribution,
	Selector,
} from "@nyaa-lexicon/protocol";
import type { RawDeclaration } from "./model.js";

////////////////////////////////
//  Interfaces & Types

/** A fact before ordering, at the offset that orders it. */
export interface Placed<Fact> {
	fact: Fact;
	offset: number;
}

export interface PlacedEdge extends Placed<ImportEdge> {
	specifier: string;
}

////////////////////////////////
//  Constants

/** An item or explicit import shadows a glob's name; two explicit imports of one name collide. */
export const EXPLICIT: Conflict = { priority: 1, amongTransfers: "exclude", againstLocal: "localWins" };

/** Two globs bringing one name leave it ambiguous. */
export const GLOBBED: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

export const KNOWN: Certainty = { status: "known" };

export const VISIBLE: Selector = { kind: "visible" };

////////////////////////////////
//  Functions & Helpers

/** Each `pub` item at the file's top, exported where it is declared. */
export function directExports(declarations: readonly RawDeclaration[]): Placed<Export>[] {
	const placed: Placed<Export>[] = [];
	for (const raw of declarations) {
		const { declaration } = raw;
		if (declaration.containerId !== undefined || !declaration.exported || raw.scope !== undefined) continue;
		const span = declaration.selectionRange ?? declaration.range;
		placed.push({
			fact: {
				form: "direct",
				span,
				name: declaration.name,
				range: span,
				target: { kind: "symbol", symbolId: declaration.symbolId },
				conflict: EXPLICIT,
				visibility: declaration.visibility,
				certainty: KNOWN,
				order: 0,
			},
			offset: raw.startOffset,
		});
	}
	return placed;
}

/** An inline module's `pub` items and an enum's variants, each scope named by its declaration's id. */
export function scopeContributions(declarations: readonly RawDeclaration[]): ScopeContribution[] {
	const children = new Map<string, RawDeclaration[]>();
	for (const raw of declarations) {
		const holder = raw.declaration.containerId;
		if (holder === undefined) continue;
		const held = children.get(holder);
		if (held === undefined) children.set(holder, [raw]);
		else held.push(raw);
	}
	const contributions: ScopeContribution[] = [];
	for (const raw of declarations) {
		const { declaration } = raw;
		const inline = declaration.kind === "module" && raw.fileModule === undefined;
		if (!inline && declaration.languageKind !== "enum") continue;
		const members = (children.get(declaration.symbolId) ?? []).filter((member) =>
			inline
				? member.declaration.exported && member.scope === undefined
				: member.declaration.languageKind === "variant",
		);
		contributions.push({
			kind: "symbolScope",
			scopeId: declaration.symbolId,
			members: members.map((member) => member.declaration.symbolId),
		});
	}
	return contributions;
}

/** Imports and exports in one source order; an edge and the export forwarding it share a place. */
export function ordered(
	edges: readonly PlacedEdge[],
	exports: readonly Placed<Export>[],
): { imports: Import[]; exports: Export[] } {
	const offsets = [...new Set([...edges, ...exports].map((each) => each.offset))].sort((left, right) => left - right);
	const rank = new Map(offsets.map((offset, order) => [offset, order]));
	return {
		imports: edges.map(({ specifier, fact, offset }) => ({
			specifier,
			edges: [{ ...fact, order: rank.get(offset) ?? 0 }],
		})),
		exports: exports
			.map(({ fact, offset }) => ({ ...fact, order: rank.get(offset) ?? 0 }))
			.sort((left, right) => left.order - right.order),
	};
}
