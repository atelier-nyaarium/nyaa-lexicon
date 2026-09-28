// A name path declared twice in one file is two declarations; the later ones carry an occurrence.
// Positional only: what sits inside a changed declaration follows it, a binding target included.

import { comparePositions } from "./coordinates.js";
import { defined } from "./defined.js";
import type { FileFacts } from "./project.js";
import { composeSymbolId, type Descriptor, parseSymbolId, rebaseSymbolId, type SymbolId } from "./symbolId.js";
import type { Declaration, Range, Reference } from "./symbols.js";

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

/** The id without its last occurrence, and which occurrence it was; null for a local, which has none. */
function split(id: string): { base: string; occurrence: number } | null {
	const parsed = parseSymbolId(id);
	const last = parsed?.descriptors.at(-1);
	if (parsed === null || parsed === undefined || parsed.local !== undefined || last === undefined) return null;
	const bare: Descriptor = {
		kind: last.kind,
		name: last.name,
		...defined({ disambiguator: last.disambiguator }),
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

/** One old id's changes in source order, each with the furthest end reached so far. */
interface Bucket {
	entries: Moved[];
	reach: Range["end"][];
}

/**
 * Changed declarations by old id. A lookup walks one id's ancestors, and within each only the
 * changes that start before the range and reach past it.
 */
class MovedIndex {
	readonly entries: Moved[] = [];
	private readonly byFrom = new Map<string, Bucket>();
	/** Each id's own key, then its ancestors' keys, deepest first; empty for a local or a malformed id. */
	private readonly chains = new Map<string, readonly string[]>();

	/** Added in source order, the wider first at one start. */
	add(entry: Moved): void {
		this.entries.push(entry);
		const key = this.chain(entry.from)[0];
		if (key === undefined) return;
		const bucket = this.byFrom.get(key) ?? { entries: [], reach: [] };
		const before = bucket.reach.at(-1);
		bucket.entries.push(entry);
		bucket.reach.push(
			before !== undefined && comparePositions(before, entry.range.end) > 0 ? before : entry.range.end,
		);
		this.byFrom.set(key, bucket);
	}

	/** The innermost changed declaration holding `range` whose old id is exactly `id`. */
	owner(id: string, range: Range): Moved | undefined {
		const key = this.chain(id)[0];
		const holding = key === undefined ? [] : this.holding(key, range);
		return holding.find((entry) => entry.from === id);
	}

	/** The deepest changed declaration holding `range` whose old id is `id` or an ancestor of it. */
	ancestor(id: string, range: Range): Moved | undefined {
		for (const key of this.chain(id)) {
			const outermost = this.holding(key, range).at(-1);
			if (outermost !== undefined) return outermost;
		}
		return undefined;
	}

	/** Changes under `key` holding `range`, innermost first. */
	private holding(key: string, range: Range): Moved[] {
		const bucket = this.byFrom.get(key);
		if (bucket === undefined) return [];
		let low = 0;
		let high = bucket.entries.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			const start = (bucket.entries[middle] as Moved).range.start;
			if (comparePositions(start, range.start) <= 0) low = middle + 1;
			else high = middle;
		}
		const found: Moved[] = [];
		for (let index = low - 1; index >= 0; index--) {
			if (comparePositions(bucket.reach[index] as Range["end"], range.end) < 0) break;
			const entry = bucket.entries[index] as Moved;
			if (within(range, entry.range)) found.push(entry);
		}
		return found;
	}

	private chain(id: string): readonly string[] {
		let chain = this.chains.get(id);
		if (chain !== undefined) return chain;
		const parsed = parseSymbolId(id);
		const keys: string[] = [];
		if (parsed !== null && parsed.local === undefined) {
			for (let depth = parsed.descriptors.length; depth > 0; depth--) {
				keys.push(composeSymbolId({ ...parsed, descriptors: parsed.descriptors.slice(0, depth) }));
			}
		}
		chain = keys;
		this.chains.set(id, chain);
		return chain;
	}
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
	const moved = new MovedIndex();
	const finalIds = new Map<number, string>();
	const used = new Map<string, Set<number>>();

	for (const index of order) {
		const declaration = facts.declarations[index] as Declaration;
		let id = declaration.symbolId;
		const ancestor = moved.ancestor(id, declaration.range);
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
		if (id !== declaration.symbolId) moved.add({ from: declaration.symbolId, to: id, range: declaration.range });
		finalIds.set(index, id);
	}
	if (moved.entries.length === 0) return facts;

	const declared = new Set(finalIds.values());
	// An owner named from outside its own range, an out-of-line member, follows the deepest moved
	// ancestor holding it, when that names a declaration; the class may live in an earlier reopening.
	const repoint = (id: string, range: Range): string => {
		const own = moved.owner(id, range);
		if (own !== undefined) return own.to;
		const ancestor = moved.ancestor(id, range);
		const rebased = ancestor === undefined ? null : rebaseSymbolId(id, ancestor.from, ancestor.to);
		return rebased !== null && declared.has(rebased) ? rebased : id;
	};
	const reminted = new Set(moved.entries.map((entry) => entry.to));
	/**
	 * A target STRICTLY inside a re-minted declaration, read from inside it, follows that
	 * declaration, and only to an id this settlement minted. An id the provider minted itself is
	 * one it knew to bind.
	 */
	const follow = (id: string, range: Range): string => {
		const ancestor = moved.ancestor(id, range);
		if (ancestor === undefined || ancestor.from === id) return id;
		const rebased = rebaseSymbolId(id, ancestor.from, ancestor.to);
		return rebased !== null && reminted.has(rebased) ? rebased : id;
	};
	/**
	 * A binding into a re-minted declaration follows it. One naming the declaration itself stays,
	 * since the bare id still declares it and which reopening a name means is the provider's to say.
	 */
	const rebind = (binding: Reference["binding"], range: Range): Reference["binding"] => {
		if (binding.status === "bound") return { ...binding, symbolId: follow(binding.symbolId, range) };
		if (binding.status === "ambiguous")
			return { ...binding, candidates: binding.candidates.map((candidate) => follow(candidate, range)) };
		return binding;
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
		references: facts.references.map((reference) => ({
			...reference,
			binding: rebind(reference.binding, reference.range),
			...(reference.fromId === undefined ? {} : { fromId: repoint(reference.fromId, reference.range) }),
		})),
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
