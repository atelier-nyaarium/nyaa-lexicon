// What a unit's includes reach, for every count of them that can stand before a reference: each
// header at its include depth, walked once, and each scope's names indexed once.

import type { ImportResolution, WorkMeter } from "@nyaa-lexicon/protocol";
import type { CppDeclarationRecord, CppFacts, ImportFact } from "./model.js";

////////////////////////////////
//  Interfaces & Types

/** What the headers at one include depth declare under one path and name. */
export interface DepthRecords {
	depth: number;
	records: CppDeclarationRecord[];
}

/** What the includes before a reference reach, and whether some reached none. */
export interface Reach {
	/** What the reached headers declare named `name` in the scope at `path`, nearest include depth first. */
	declared(path: string, name: string): readonly DepthRecords[];
	/** An include named a header outside the workspace. */
	external: boolean;
	/** An include named a workspace header no file answers, or one not indexed. */
	unresolved: boolean;
}

/** What a unit's includes reach, for any count of them. */
export interface Reaches {
	/** What the forced includes and the unit's first `count` includes reach. */
	before(count: number): Reach;
	/** Whether every header met was read; one that was not may read on a later try. */
	complete: boolean;
}

/** Where a walk resolves and reads the headers it meets. */
export interface ReachSources {
	/** An include written in `includer`, searched under the unit's lists. */
	resolve(includer: string, include: ImportFact): ImportResolution;
	load(module: string): CppFacts | undefined;
}

/** A reached header: from how many of the unit's includes on, how deep, and where its depth's walk met it. */
interface Walked {
	header: CppFacts;
	count: number;
	depth: number;
	order: number;
}

/** What one reached header declares in one scope. */
interface InScope {
	walked: Walked;
	names: ReadonlyMap<string, readonly CppDeclarationRecord[]>;
}

/** What one reached header declares under one name in one scope. */
interface Declaring {
	walked: Walked;
	records: readonly CppDeclarationRecord[];
}

////////////////////////////////
//  Functions & Helpers

/** How many of a file's includes start before token `at`; they stand in token order. */
export function includesBefore(facts: CppFacts, at: number): number {
	let low = 0;
	let high = facts.importFacts.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((facts.importFacts[middle] as ImportFact).tokenStart < at) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * Walks the forced includes, then the unit's own, breadth first. The includes standing between
 * two references walk together, so a header's depth is its nearest from them; a header keeps the
 * depth it was first reached at, and is never walked again.
 */
export function reachesOf(
	unit: string,
	forced: readonly ImportResolution[],
	facts: CppFacts,
	sources: ReachSources,
	meter?: WorkMeter,
): Reaches {
	const includes = facts.importFacts;
	const walked = new Map<string, Walked>();
	const unread = new Set<string>();
	let externalAt = Number.POSITIVE_INFINITY;
	let unresolvedAt = Number.POSITIVE_INFINITY;
	let order = 0;

	const enter = (resolution: ImportResolution, depth: number, count: number, into: string[]) => {
		if (resolution.status === "external") externalAt = Math.min(externalAt, count);
		if (resolution.status === "unresolved") unresolvedAt = Math.min(unresolvedAt, count);
		if (resolution.status !== "resolved" || resolution.landing.kind !== "module") return;
		const module = resolution.landing.module;
		if (module === unit || unread.has(module) || walked.has(module)) return;
		const header = sources.load(module);
		if (header === undefined) {
			unread.add(module);
			unresolvedAt = Math.min(unresolvedAt, count);
			return;
		}
		walked.set(module, { header, count, depth, order: order++ });
		into.push(module);
	};
	// Macro names resolve where they expand, never through the includes.
	const stops = new Set(
		facts.references
			.filter((reference) => !reference.macro)
			.map((reference) => includesBefore(facts, reference.tokenIndex)),
	);
	let from = -1;
	for (let count = 0; count <= includes.length; count++) {
		if (count < includes.length && !stops.has(count)) continue;
		let layer: string[] = [];
		if (from < 0) for (const resolution of forced) enter(resolution, 1, count, layer);
		for (const include of includes.slice(Math.max(from, 0), count))
			enter(sources.resolve(unit, include), 1, count, layer);
		from = count;
		for (let depth = 2; layer.length > 0; depth++) {
			const next: string[] = [];
			for (const module of layer)
				for (const include of (walked.get(module) as Walked).header.importFacts)
					enter(sources.resolve(module, include), depth, count, next);
			layer = next;
		}
	}

	// Each reached header's scopes, in one pass; a scope's names are indexed when first asked for.
	const byPath = new Map<string, InScope[]>();
	for (const entry of walked.values())
		for (const [path, names] of entry.header.membersByPath) {
			const found = byPath.get(path) ?? [];
			found.push({ walked: entry, names });
			byPath.set(path, found);
		}
	const scopes = new Map<string, Map<string, Declaring[]>>();
	const scope = (path: string) => {
		const known = scopes.get(path);
		if (known !== undefined) return known;
		const byName = new Map<string, Declaring[]>();
		for (const { walked: entry, names } of byPath.get(path) ?? [])
			for (const [name, records] of names) {
				if (meter !== undefined) meter.steps++;
				const found = byName.get(name) ?? [];
				found.push({ walked: entry, records });
				byName.set(name, found);
			}
		scopes.set(path, byName);
		return byName;
	};

	return {
		complete: unread.size === 0,
		before: (count) => {
			const answers = new Map<string, DepthRecords[]>();
			return {
				external: externalAt <= count,
				unresolved: unresolvedAt <= count,
				declared: (path, name) => {
					const key = `${path}\u0000${name}`;
					const known = answers.get(key);
					if (known !== undefined) return known;
					const visible = (scope(path).get(name) ?? [])
						.filter(({ walked: entry }) => entry.count <= count)
						.sort(
							(left, right) =>
								left.walked.depth - right.walked.depth || left.walked.order - right.walked.order,
						);
					const grouped: DepthRecords[] = [];
					for (const { walked: entry, records } of visible) {
						const last = grouped.at(-1);
						if (last?.depth === entry.depth) last.records.push(...records);
						else grouped.push({ depth: entry.depth, records: [...records] });
					}
					answers.set(key, grouped);
					return grouped;
				},
			};
		},
	};
}
