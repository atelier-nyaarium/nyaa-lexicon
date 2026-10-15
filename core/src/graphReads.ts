import {
	type CallHierarchy,
	type CallHierarchyEdge,
	type GraphSummary,
	languageOf,
	type MostReferencedResult,
	ProvenanceSchema,
	type Range,
	type ReferencesResult,
	type ReferenceUse,
	type SymbolEdges,
	type SymbolSummary,
	type TypeHierarchy,
	UnknownReasonSchema,
	type UseFrom,
	type UsesFromResult,
} from "@nyaa-lexicon/protocol";
import { isEdgeRole, NameCount, type NamespaceTarget, PeerTally } from "./edges.js";
import { ReadContext, toSummary } from "./readContext.js";
import { DEFAULT_REFERENCE_LIMIT } from "./readLimits.js";
import { contains, resolveScope } from "./scope.js";
import type { IndexStore, StoredDeclaration, StoredReference } from "./store.js";

/** A provenance when bound or ambiguous; a reason when not. */
function bindingOf(reference: StoredReference): Pick<UseFrom, "status" | "reason"> {
	if (reference.targetId !== null) return { status: "bound" };
	if (ProvenanceSchema.safeParse(reference.provenance).success) return { status: "ambiguous" };
	const reason = UnknownReasonSchema.safeParse(reference.provenance);
	return { status: "unbound", ...(reason.success ? { reason: reason.data } : {}) };
}

/** Locals' evidence belongs to their owner. */
function ownerOf(context: ReadContext, reference: StoredReference): StoredDeclaration | null {
	return reference.fromId === null ? null : context.ownerIn(reference.module, reference.fromId);
}

/** A use's owner is read in the use's own file. */
function topLevelOf(context: ReadContext, reference: StoredReference): StoredDeclaration | null {
	return reference.fromId === null ? null : context.topLevelIn(reference.module, reference.fromId);
}

function useOf(context: ReadContext, reference: StoredReference): ReferenceUse {
	const top = topLevelOf(context, reference);
	// Target head is file head; daemon-protocol.md holds why.
	const language = languageOf(reference.fromId ?? reference.targetId ?? "");
	return {
		...reference,
		...(top === null ? {} : { topLevel: toSummary(top) }),
		...(language === null ? {} : { language }),
	};
}

////////////////////////////////
//  Graph reads

export class GraphReadModel {
	constructor(private readonly store: IndexStore) {}

	graphSummaryForDescribe(context: ReadContext, symbolId: string): GraphSummary {
		return this.graphSummary(context, symbolId);
	}

	hierarchyForDescribe(context: ReadContext, symbolId: string, maxDepth = 16): TypeHierarchy {
		return this.hierarchyOf(context, symbolId, maxDepth);
	}

	/**
	 * Fan-in and fan-out.
	 *
	 * Every number here is bounded by what binding reached, so it is a fact about the INDEX rather
	 * than about the code. A caller told otherwise would read a low fan-in as "barely used" when it
	 * may only mean "barely resolved".
	 */
	private graphSummary(context: ReadContext, symbolId: string): GraphSummary {
		// Members counted too, because a reference inside a method belongs to the METHOD. Asking a
		// class for its own fan-out returned zero however much it used, since nothing is written
		// directly in a class body, and a reader takes zero as "depends on nothing".
		const members = context.declaredChildren(symbolId);
		// A local's references belong to its owner.
		const owners = [symbolId, ...members.map((m) => m.symbolId)].flatMap((id) => context.ownedIds(id));
		const uses = new Set<string>();
		for (const owner of owners) {
			for (const reference of this.store.usesFrom(owner)) {
				if (reference.targetId !== null) uses.add(reference.targetId);
			}
		}

		const incoming = this.store.usesTo(symbolId);
		const dependents = new Set(
			incoming.map((reference) => topLevelOf(context, reference)?.symbolId ?? `module ${reference.module}`),
		);

		return {
			symbolId,
			fanOut: uses.size,
			fanIn: incoming.length,
			...(members.length === 0 ? {} : { viaMembers: members.length }),
			dependents: dependents.size,
		};
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
		return this.hierarchyOf(new ReadContext(this.store), symbolId, maxDepth);
	}

	private hierarchyOf(context: ReadContext, symbolId: string, maxDepth = 16): TypeHierarchy {
		const isHeritage = (role: string) => role === "extends" || role === "implements";

		const supertypeIdsOf = (id: string) =>
			this.store
				.usesFrom(id)
				.filter((reference) => isHeritage(reference.role))
				.map((reference) => reference.targetId)
				.filter((target): target is string => target !== null);

		const summariesOf = (ids: string[]) =>
			[...new Set(ids)]
				.map((id) => context.summaryOf(id))
				.filter((found): found is SymbolSummary => found !== null);

		const supertypes = summariesOf(supertypeIdsOf(symbolId));
		const subtypes = summariesOf(
			this.store
				.usesTo(symbolId)
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

		// usesFrom excludes unbound rows.
		const declaration = context.declaration(symbolId);
		const unresolved =
			declaration === null
				? []
				: this.store
						.usesIn(declaration.module)
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
			unboundSupertypes: [...new Set(unresolved)],
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
		const context = new ReadContext(this.store);
		const spansBy = (
			rows: StoredReference[],
			endOf: (reference: StoredReference) => string | null,
		): Map<string, Range[]> => {
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
			return byPeer;
		};
		const edges = (byPeer: Map<string, Range[]>): CallHierarchyEdge[] => {
			const found: CallHierarchyEdge[] = [];
			for (const [peer, ranges] of byPeer) {
				const symbol = context.summaryOf(peer);
				if (symbol !== null) found.push({ symbol, ranges });
			}
			return found;
		};

		const callers = this.store.usesTo(symbolId);
		// Local calls belong to their owner.
		const callerOf = (reference: StoredReference) => ownerOf(context, reference)?.symbolId ?? null;
		// A top-level call has no calling symbol, so it groups by the module it sits in.
		const fromModules = spansBy(callers, (reference) => (callerOf(reference) === null ? reference.module : null));
		const written = context
			.ownedIds(symbolId)
			.flatMap((id) => this.store.usesFrom(id))
			.sort((a, b) => a.startLine - b.startLine || a.startCharacter - b.startCharacter);
		return {
			symbolId,
			incoming: edges(spansBy(callers, callerOf)),
			outgoing: edges(spansBy(written, (reference) => reference.targetId)),
			incomingFromModules: [...fromModules].map(([module, ranges]) => ({ module, ranges })),
		};
	}

	/**
	 * Count sites before caps.
	 * Service resolves namespace targets.
	 */
	symbolEdges(
		symbolId: string,
		namespaces: ReadonlyMap<string, NamespaceTarget>,
		limit = DEFAULT_REFERENCE_LIMIT,
	): SymbolEdges {
		const context = new ReadContext(this.store);
		const focus = context.declaration(symbolId);
		const empty = { names: [], total: 0 };
		if (focus === null) {
			return {
				symbolId,
				incoming: { groups: [], internal: 0 },
				outgoing: { groups: [], internal: 0, modules: [], library: empty, unresolved: empty },
			};
		}
		const inside = context.descendantIds(symbolId);

		const users = new PeerTally(focus.module);
		let self = 0;
		for (const reference of this.store.usesTo(symbolId)) {
			if (!isEdgeRole(reference.role)) continue;
			const owner = ownerOf(context, reference);
			if (owner !== null && inside.has(owner.symbolId)) {
				self++;
				continue;
			}
			users.add(owner === null ? null : toSummary(owner), reference.module, reference.role);
		}

		const used = new PeerTally(focus.module);
		const internal = new Set<string>();
		const modules = new NameCount();
		const library = new NameCount();
		const unresolved = new NameCount();
		for (const reference of this.store.usesIn(focus.module)) {
			if (reference.fromId === null || !inside.has(reference.fromId) || !isEdgeRole(reference.role)) continue;
			const holder = ownerOf(context, reference)?.symbolId;
			const target = reference.targetId === null ? null : context.summaryOf(reference.targetId);
			if (reference.targetId !== null && inside.has(reference.targetId)) internal.add(reference.targetId);
			else if (target !== null) used.add(target, target.module, reference.role, holder);
			else if (bindingOf(reference).status === "ambiguous") unresolved.add(reference.name);
			else {
				const landed = namespaces.get(reference.name);
				if (landed !== undefined && "module" in landed) modules.add(landed.module);
				else if (landed !== undefined || bindingOf(reference).reason === "ExternalDependency") {
					library.add(reference.name);
				} else unresolved.add(reference.name);
			}
		}

		return {
			symbolId,
			incoming: { groups: users.groups(limit, false), internal: self },
			outgoing: {
				groups: used.groups(limit, true),
				internal: internal.size,
				modules: modules.entries().map(([module, sites]) => ({ module, sites })),
				library: library.tally(limit),
				unresolved: unresolved.tally(limit),
			},
		};
	}

	/** Who uses a symbol, import and export lines left out. Capped, and the caller is told when it was. */
	findReferences(
		symbolId: string,
		limit = DEFAULT_REFERENCE_LIMIT,
		within?: string,
		module?: string,
	): ReferencesResult {
		const context = new ReadContext(this.store);
		const scope = within === undefined ? undefined : resolveScope(context, within);
		// A use at module level sits inside no symbol, so no scope holds it.
		const all = this.store.usesTo(symbolId);
		const filtered = all.filter(
			(reference) =>
				(scope === undefined || (reference.fromId !== null && contains(scope, reference.fromId))) &&
				(module === undefined || reference.module === module || reference.module.startsWith(`${module}/`)),
		);
		return {
			symbolId,
			references: filtered.slice(0, limit).map((reference) => useOf(context, reference)),
			total: filtered.length,
			truncated: filtered.length > limit,
			tier: "bound",
		};
	}

	/** What a symbol and everything declared inside it reference, bound or not, in source order. */
	usesFrom(symbolId: string, limit = DEFAULT_REFERENCE_LIMIT): UsesFromResult {
		const context = new ReadContext(this.store);
		const declaration = context.declaration(symbolId);
		if (declaration === null) return { symbolId, references: [], total: 0, truncated: false, tier: "bound" };
		const inside = context.descendantIds(symbolId);
		const written = this.store
			.usesIn(declaration.module)
			.filter((reference) => reference.fromId !== null && inside.has(reference.fromId));
		return {
			symbolId,
			references: written.slice(0, limit).map((reference): UseFrom => {
				const target = reference.targetId === null ? null : context.summaryOf(reference.targetId);
				return {
					...useOf(context, reference),
					...(target === null ? {} : { target }),
					...bindingOf(reference),
				};
			}),
			total: written.length,
			truncated: written.length > limit,
			tier: "bound",
		};
	}

	/** The most-referenced symbols, which is hub rank. */
	mostReferenced(limit = 20): MostReferencedResult {
		const context = new ReadContext(this.store);
		return this.store
			.mostReferenced(limit)
			.map((row) => ({ ...row, declaration: context.summaryOf(row.symbolId) }));
	}
}
