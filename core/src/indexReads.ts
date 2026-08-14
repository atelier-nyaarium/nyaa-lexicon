// Every question answered from the index alone.
//
// A store and nothing else, held by a residue test. A query that could start a provider or touch
// the disk would stop being knowably cheap.

import type { Range } from "@nyaa-lexicon/protocol";
import { findCycles } from "./graph.js";
import { compileSearchRegex } from "./search.js";
import type { IndexStore, StoredDeclaration, StoredLiteral, StoredReference } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** How a fact was obtained, carried on every answer so a consumer can weigh it. */
export type AnswerTier = "bound" | "nameMatched" | "unknown";

export interface SymbolSummary {
	symbolId: string;
	name: string;
	kind: string;
	module: string;
	/** Absent when the provider's language has no answer, which is not the same as false. */
	exported?: boolean;
	visibility: string;
	signature?: string;
	docComment?: string;
	/** Where the body lives, 0-based source lines. The pointer that makes reading it a range read. */
	lines?: { start: number; end: number };
}

export interface DescribeResult {
	symbol: SymbolSummary;
	/** Direct members, the compression tier: a class as its surface rather than its body. */
	members: SymbolSummary[];
	/** How many places use it, so a caller decides whether to ask for the list. */
	referenceCount: number;
	graph: GraphSummary;
	hierarchy: TypeHierarchy;
	tier: AnswerTier;
}

export interface ReferencesResult {
	symbolId: string;
	/** Capped, because an agent pays for every row and a hub symbol has thousands. */
	references: StoredReference[];
	total: number;
	truncated: boolean;
	tier: AnswerTier;
}

/** How a literal search was expressed. Carried back so an answer says what it answered. */
export interface LiteralQuery {
	value?: string | undefined;
	regex?: string | undefined;
	kind?: string | undefined;
	min?: number | undefined;
	max?: number | undefined;
}

export interface LiteralsResult {
	query: LiteralQuery;
	literals: StoredLiteral[];
	total: number;
	truncated: boolean;
	/** Set when a regex search stopped reading before the end of the table. */
	scanIncomplete?: boolean;
}

/**
 * Immediate supertypes and subtypes, which is the shape LSP's typeHierarchy asks for.
 *
 * Read entirely out of `extends` and `implements` reference rows the providers already emit, so
 * this needed no new provider method: the dual inverted index means one direction is
 * `referencesFrom` and the other is `referencesTo` on the same table.
 */
export interface TypeHierarchy {
	symbolId: string;
	supertypes: SymbolSummary[];
	subtypes: SymbolSummary[];
	/** Supertypes reached transitively, nearest first, bounded and cycle-guarded. */
	ancestors: SymbolSummary[];
	/** Unresolved heritage names, so an engine base class is visibly absent rather than missing. */
	unboundSupertypes: string[];
}

/** One end of a call relationship, with every span where that call is written. */
export interface CallHierarchyEdge {
	symbol: SymbolSummary;
	ranges: Range[];
}

export interface CallHierarchy {
	symbolId: string;
	incoming: CallHierarchyEdge[];
	outgoing: CallHierarchyEdge[];
}

export interface GraphSummary {
	symbolId: string;
	/** Distinct symbols this one uses, its members included. */
	fanOut: number;
	/** Places that use it. */
	fanIn: number;
	/** How many members contributed, so a container's number is readable as one. */
	viaMembers?: number;
	/** Present only when this symbol sits in a cycle. */
	cycle?: string[];
}

////////////////////////////////
//  Constants & Helpers

/**
 * How many literals a regex search will read before giving up.
 *
 * SQLite has no REGEXP here, so a regex is matched in application code and the read is what
 * costs. Stopping is fine; stopping SILENTLY is not, which is why the result carries a flag saying
 * the scan did not finish.
 */
export const REGEX_SCAN_LIMIT = 20_000;

/** Default page for a reference list. A hub symbol would otherwise flood a caller's context. */
export const DEFAULT_REFERENCE_LIMIT = 50;

/** Page for a literal search. Literals outnumber symbols by a lot, so this is the tighter cap. */
export const DEFAULT_LITERAL_LIMIT = 50;

/** One place that decides what "more than a page" means, so no caller reports a cap as a total. */
function page(query: LiteralQuery, found: StoredLiteral[], limit: number): LiteralsResult {
	return {
		query,
		literals: found.slice(0, limit),
		total: found.length,
		truncated: found.length > limit,
	};
}

export function toSummary(declaration: StoredDeclaration): SymbolSummary {
	return {
		symbolId: declaration.symbolId,
		name: declaration.name,
		kind: declaration.kind,
		module: declaration.module,
		visibility: declaration.visibility,
		...(declaration.exported === undefined ? {} : { exported: declaration.exported }),
		...(declaration.signature === undefined ? {} : { signature: declaration.signature }),
		...(declaration.docComment === undefined ? {} : { docComment: declaration.docComment }),
		...(declaration.range === undefined
			? {}
			: { lines: { start: declaration.range.start.line, end: declaration.range.end.line } }),
	};
}

////////////////////////////////
//  Class

/** Read queries against one index. Usable alone by anything holding a store. */
export class IndexReadModel {
	constructor(private readonly store: IndexStore) {}

	/** Symbols matching a name, so a caller holding a name rather than an id can start. */
	findByName(name: string, module?: string): SymbolSummary[] {
		const matches =
			module === undefined
				? this.store.declarationsNamed(name)
				: this.store.declarationsIn(module).filter((d) => d.name === name);
		return matches.map(toSummary);
	}

	/**
	 * What a symbol is, plus its surface and how used it is.
	 *
	 * The member list is the compression tier: a four-hundred-line class answers as its signature
	 * surface, which is the thing that beats reading the file.
	 */
	describe(symbolId: string): DescribeResult | null {
		const declaration = this.store.declaration(symbolId);
		if (!declaration) return null;

		const members = this.store
			.declarationsIn(declaration.module)
			.filter((d) => d.containerId === symbolId)
			.map(toSummary);

		return {
			symbol: toSummary(declaration),
			members,
			referenceCount: this.store.referencesTo(symbolId).length,
			graph: this.graphSummary(symbolId),
			hierarchy: this.typeHierarchy(symbolId),
			tier: "bound",
		};
	}

	/** One declaration with its ranges, which `describe` deliberately does not carry. */
	declarationOf(symbolId: string): StoredDeclaration | null {
		return this.store.declaration(symbolId);
	}

	/** Everything declared in one file, in source order. What an editor outline is built from. */
	declarationsIn(module: string): StoredDeclaration[] {
		return this.store.declarationsIn(module);
	}

	/** The same, as summaries plus the container, which is what renders an outline. */
	outline(module: string): Array<SymbolSummary & { containerId?: string }> {
		return this.store.declarationsIn(module).map((declaration) => ({
			...toSummary(declaration),
			...(declaration.containerId === undefined ? {} : { containerId: declaration.containerId }),
		}));
	}

	/** Search declared symbols by a name substring or regular expression. */
	searchSymbols(
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string | undefined;
			module?: string | undefined;
			limit?: number | undefined;
		} = {},
	) {
		if ((text === undefined) === (options.regex === undefined)) {
			throw new Error(`Set exactly one of text or regex.`);
		}
		const found = this.store.searchSymbols(text, {
			...(options.regex === undefined ? {} : { regex: options.regex }),
			...(options.kind === undefined ? {} : { kind: options.kind }),
			...(options.module === undefined ? {} : { module: options.module }),
			limit: (options.limit ?? DEFAULT_REFERENCE_LIMIT) + 1,
		});
		const limit = options.limit ?? DEFAULT_REFERENCE_LIMIT;
		return {
			text,
			...(options.regex === undefined ? {} : { regex: options.regex }),
			symbols: found.slice(0, limit).map(toSummary),
			total: found.length,
			truncated: found.length > limit,
		};
	}

	/** Who uses a symbol. Capped, and the caller is told when it was. */
	findReferences(symbolId: string, limit = DEFAULT_REFERENCE_LIMIT): ReferencesResult {
		const all = this.store.referencesTo(symbolId);
		return {
			symbolId,
			references: all.slice(0, limit),
			total: all.length,
			truncated: all.length > limit,
			tier: "bound",
		};
	}

	/**
	 * Find literal values: an exact one, a regex, or a numeric range.
	 *
	 * This is the tier that makes text searchable as facts. A name inside a string is not a
	 * reference and never was, so it appears in no other table: a rename could leave `__all__`
	 * stale and a GDScript signal reached by `connect("name")` was invisible entirely.
	 *
	 * An exact value and a numeric range are indexed reads. A regex is not, because SQLite has no
	 * REGEXP here, so it reads a bounded page and says when it stopped early.
	 */
	findLiterals(query: LiteralQuery, limit = DEFAULT_LITERAL_LIMIT): LiteralsResult {
		if (query.value !== undefined) {
			const found = this.store.literalsWithValue(query.value, limit + 1);
			return page(query, found, limit);
		}

		if (query.min !== undefined || query.max !== undefined) {
			const low = query.min ?? Number.NEGATIVE_INFINITY;
			const high = query.max ?? Number.POSITIVE_INFINITY;
			return page(query, this.store.literalsInRange(low, high, limit + 1), limit);
		}

		if (query.regex !== undefined) {
			const expression = compileSearchRegex(query.regex);
			const scanned = this.store.literalsOfKind(query.kind ?? "string", REGEX_SCAN_LIMIT);
			const matched = scanned.filter((literal) => {
				expression.lastIndex = 0;
				return expression.test(literal.value);
			});
			const result = page(query, matched, limit);
			// A truncated scan and a truncated page are different truncations, and a caller that
			// cannot tell them apart reads "50 results" as "50 exist".
			return scanned.length >= REGEX_SCAN_LIMIT ? { ...result, scanIncomplete: true } : result;
		}

		// The refusal shows the shapes, because naming the parameters alone was measured to fail: a
		// caller trying `text:` read the naming sentence and still never found `value`.
		throw new Error(
			'give a value, a regex, or a numeric range, e.g. { value: "cycleCheckpoint" } or { regex: "/^cycle/" } or { min: 0, max: 100 }',
		);
	}

	/** Values written in more than one file, which is the strongest textual signal of a relationship. */
	sharedLiterals(minimumFiles = 2, limit = DEFAULT_LITERAL_LIMIT) {
		return this.store.sharedLiterals(minimumFiles, limit);
	}

	/**
	 * Fan-in, fan-out, and whether this symbol sits in a cycle.
	 *
	 * Every number here is bounded by what binding reached, so it is a fact about the INDEX rather
	 * than about the code. A caller told otherwise would read a low fan-in as "barely used" when it
	 * may only mean "barely resolved".
	 */
	private graphSummary(symbolId: string): GraphSummary {
		const cycle = findCycles(this.store.allEdges()).find((found) => found.members.includes(symbolId));

		// Members counted too, because a reference inside a method belongs to the METHOD. Asking a
		// class for its own fan-out returned zero however much it used, since nothing is written
		// directly in a class body, and a reader takes zero as "depends on nothing".
		const declaration = this.store.declaration(symbolId);
		const members = declaration
			? this.store.declarationsIn(declaration.module).filter((d) => d.containerId === symbolId)
			: [];
		const uses = new Set<string>();
		for (const owner of [symbolId, ...members.map((m) => m.symbolId)]) {
			for (const reference of this.store.referencesFrom(owner)) {
				if (reference.targetId !== null) uses.add(reference.targetId);
			}
		}

		return {
			symbolId,
			fanOut: uses.size,
			fanIn: this.store.referencesTo(symbolId).length,
			...(members.length === 0 ? {} : { viaMembers: members.length }),
			...(cycle === undefined ? {} : { cycle: cycle.members }),
		};
	}

	/** Every cycle in the workspace, largest first. */
	cycles(limit = 20) {
		return findCycles(this.store.allEdges())
			.sort((a, b) => b.members.length - a.members.length)
			.slice(0, limit);
	}

	/**
	 * What this type extends and what extends it.
	 *
	 * Built from `extends` and `implements` reference rows rather than from a new provider method,
	 * because those rows already exist in every provider and the reference index is dual: the two
	 * directions are the same table read through two indexes.
	 *
	 * An unresolved heritage name is REPORTED rather than dropped. `extends Node2D` in GDScript names
	 * an engine class that is genuinely outside the workspace, and a hierarchy that silently omitted
	 * it would read as "this extends nothing".
	 */
	typeHierarchy(symbolId: string, maxDepth = 16): TypeHierarchy {
		const isHeritage = (role: string) => role === "extends" || role === "implements";

		const supertypeIdsOf = (id: string) =>
			this.store
				.referencesFrom(id)
				.filter((reference) => isHeritage(reference.role))
				.map((reference) => reference.targetId)
				.filter((target): target is string => target !== null);

		const summariesOf = (ids: string[]) =>
			[...new Set(ids)]
				.map((id) => this.store.declaration(id))
				.filter((found): found is StoredDeclaration => found !== null)
				.map(toSummary);

		const supertypes = summariesOf(supertypeIdsOf(symbolId));
		const subtypes = summariesOf(
			this.store
				.referencesTo(symbolId)
				.filter((reference) => isHeritage(reference.role) && reference.fromId !== null)
				.map((reference) => reference.fromId as string),
		);

		// Guarded rather than trusted: a cyclic hierarchy does not compile in any of these languages,
		// but the index holds what a provider reported, which is not the same as what compiles.
		const seen = new Set<string>([symbolId]);
		const ancestors: string[] = [];
		let frontier = supertypeIdsOf(symbolId);
		for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
			const next: string[] = [];
			for (const id of frontier) {
				if (seen.has(id)) continue;
				seen.add(id);
				ancestors.push(id);
				next.push(...supertypeIdsOf(id));
			}
			frontier = next;
		}

		const unboundSupertypes = this.store
			.referencesFrom(symbolId)
			.filter((reference) => isHeritage(reference.role) && reference.targetId === null)
			.map((reference) => reference.name);
		// referencesFrom already drops unbound rows, so the unresolved ones come from the file's own
		// reference list instead.
		const declaration = this.store.declaration(symbolId);
		const unresolved =
			declaration === null
				? []
				: this.store
						.referencesIn(declaration.module)
						.filter(
							(reference) =>
								isHeritage(reference.role) &&
								reference.fromId === symbolId &&
								reference.targetId === null,
						)
						.map((reference) => reference.name);

		return {
			symbolId,
			supertypes,
			subtypes,
			ancestors: summariesOf(ancestors),
			unboundSupertypes: [...new Set([...unboundSupertypes, ...unresolved])],
		};
	}

	/**
	 * Who calls this, and what it calls, with the exact spans of each call.
	 *
	 * The same rows as the type hierarchy read through the `call` role instead of the heritage ones.
	 * Grouped by the symbol at the other end, because an editor draws one row per caller however many
	 * times that caller calls it, and the individual spans are what it highlights inside that row.
	 */
	callHierarchy(symbolId: string): CallHierarchy {
		const group = (
			rows: StoredReference[],
			endOf: (reference: StoredReference) => string | null,
		): CallHierarchyEdge[] => {
			const byPeer = new Map<string, Range[]>();
			for (const reference of rows) {
				if (reference.role !== "call") continue;
				const peer = endOf(reference);
				if (peer === null) continue;
				const ranges = byPeer.get(peer) ?? [];
				ranges.push({
					start: { line: reference.startLine, character: reference.startCharacter },
					end: { line: reference.endLine, character: reference.endCharacter },
				});
				byPeer.set(peer, ranges);
			}

			const edges: CallHierarchyEdge[] = [];
			for (const [peer, ranges] of byPeer) {
				const declaration = this.store.declaration(peer);
				if (declaration !== null) edges.push({ symbol: toSummary(declaration), ranges });
			}
			return edges;
		};

		return {
			symbolId,
			incoming: group(this.store.referencesTo(symbolId), (reference) => reference.fromId),
			outgoing: group(this.store.referencesFrom(symbolId), (reference) => reference.targetId),
		};
	}

	/** The most-referenced symbols, which is hub rank. */
	mostReferenced(limit = 20): Array<{ symbolId: string; count: number; declaration: SymbolSummary | null }> {
		return this.store.mostReferenced(limit).map((row) => {
			const declaration = this.store.declaration(row.symbolId);
			return { ...row, declaration: declaration === null ? null : toSummary(declaration) };
		});
	}
}
