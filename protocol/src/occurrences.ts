// A name path declared twice in one file is two declarations; the later ones carry an occurrence.
// Positional only: what sits inside a changed declaration follows it, and a binding is left alone.

import { comparePositions } from "./coordinates.js";
import type { FileFacts } from "./project.js";
import {
	composeSymbolId,
	type Descriptor,
	isWithin,
	parseSymbolId,
	rebaseSymbolId,
	type SymbolId,
} from "./symbolId.js";
import type { Declaration, Range } from "./symbols.js";

////////////////////////////////
//  Interfaces & Types

interface Moved {
	from: string;
	to: string;
	range: Range;
}

////////////////////////////////
//  Functions & Helpers

function within(inner: Range, outer: Range): boolean {
	return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;
}

function depthOf(id: string): number {
	return parseSymbolId(id)?.descriptors.length ?? 0;
}

/** The id without its last occurrence, and which occurrence it was; null for a local, which has none. */
function split(id: string): { base: string; occurrence: number } | null {
	const parsed = parseSymbolId(id);
	const last = parsed?.descriptors.at(-1);
	if (parsed === null || parsed === undefined || parsed.local !== undefined || last === undefined) return null;
	const bare: Descriptor = {
		kind: last.kind,
		name: last.name,
		...(last.disambiguator === undefined ? {} : { disambiguator: last.disambiguator }),
	};
	return {
		base: composeSymbolId({ ...parsed, descriptors: [...parsed.descriptors.slice(0, -1), bare] }),
		occurrence: last.occurrence ?? 1,
	};
}

function mint(base: string, occurrence: number): string {
	const parsed = parseSymbolId(base) as SymbolId;
	const last = parsed.descriptors.at(-1) as Descriptor;
	return composeSymbolId({ ...parsed, descriptors: [...parsed.descriptors.slice(0, -1), { ...last, occurrence }] });
}

/** The innermost changed declaration holding `range` whose old id is exactly `id`. */
function movedOwner(moved: Moved[], id: string, range: Range): Moved | undefined {
	let best: Moved | undefined;
	for (const entry of moved) {
		if (entry.from !== id || !within(range, entry.range)) continue;
		if (best === undefined || within(entry.range, best.range)) best = entry;
	}
	return best;
}

/** The deepest changed declaration holding `range` whose old id is an ancestor of `id`. */
function movedAncestor(moved: Moved[], id: string, range: Range): Moved | undefined {
	let best: Moved | undefined;
	for (const entry of moved) {
		if (!isWithin(id, entry.from) || !within(range, entry.range)) continue;
		if (best === undefined || depthOf(entry.from) > depthOf(best.from)) best = entry;
	}
	return best;
}

/** Re-mints a repeated name path as its next free occurrence, in source order, re-parenting what it holds. */
export function withOccurrences(facts: FileFacts): FileFacts {
	// Source order; at one start the wider range is the container and comes first.
	const order = facts.declarations
		.map((_, index) => index)
		.sort((a, b) => {
			const left = facts.declarations[a] as Declaration;
			const right = facts.declarations[b] as Declaration;
			return (
				comparePositions(left.range.start, right.range.start) ||
				comparePositions(right.range.end, left.range.end) ||
				a - b
			);
		});
	const moved: Moved[] = [];
	const finalIds = new Map<number, string>();
	const used = new Map<string, Set<number>>();

	for (const index of order) {
		const declaration = facts.declarations[index] as Declaration;
		let id = declaration.symbolId;
		const ancestor = movedAncestor(moved, id, declaration.range);
		if (ancestor !== undefined) id = rebaseSymbolId(id, ancestor.from, ancestor.to) ?? id;
		const parts = split(id);
		if (parts !== null) {
			const taken = used.get(parts.base) ?? new Set<number>();
			if (taken.has(parts.occurrence)) {
				let next = 2;
				while (taken.has(next)) next++;
				id = mint(parts.base, next);
				taken.add(next);
			} else {
				taken.add(parts.occurrence);
			}
			used.set(parts.base, taken);
		}
		if (id !== declaration.symbolId) moved.push({ from: declaration.symbolId, to: id, range: declaration.range });
		finalIds.set(index, id);
	}
	if (moved.length === 0) return facts;

	const declared = new Set(finalIds.values());
	// An owner named from outside its own range, an out-of-line member, follows the deepest moved
	// ancestor holding it, when that names a declaration; the class may live in an earlier reopening.
	const repoint = (id: string, range: Range): string => {
		const own = movedOwner(moved, id, range);
		if (own !== undefined) return own.to;
		const ancestor = movedAncestor(moved, id, range);
		const rebased = ancestor === undefined ? null : rebaseSymbolId(id, ancestor.from, ancestor.to);
		return rebased !== null && declared.has(rebased) ? rebased : id;
	};
	return {
		...facts,
		declarations: facts.declarations.map((declaration, index) => ({
			...declaration,
			symbolId: finalIds.get(index) as string,
			...(declaration.containerId === undefined
				? {}
				: { containerId: repoint(declaration.containerId, declaration.range) }),
		})),
		references: facts.references.map((reference) =>
			reference.fromId === undefined
				? reference
				: { ...reference, fromId: repoint(reference.fromId, reference.range) },
		),
		literals: facts.literals.map((literal) =>
			literal.containerId === undefined
				? literal
				: { ...literal, containerId: repoint(literal.containerId, literal.range) },
		),
		...(facts.docs === undefined
			? {}
			: {
					docs: facts.docs.map((region) =>
						region.anchorId === undefined
							? region
							: { ...region, anchorId: repoint(region.anchorId, region.range) },
					),
				}),
	};
}
