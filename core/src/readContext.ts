// One read's view of declaration topology: which declarations a module holds, how they nest, and
// the summary each one answers as.
//
// Built once per read and handed down, so a read asking three things about one module loads it
// once. Every reader asks here rather than deriving containment a second way; a residue test holds
// the containment, the container walk and the summary to this file and `locals.ts`.

import { defined, GROUPING_KINDS, type SymbolSummary } from "@nyaa-lexicon/protocol";
import { ancestryOf, Containment } from "./locals.js";
import { contains, type Scope } from "./scope.js";
import type { StoredDeclaration, StoredLiteral } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** The declaration reads a context is built from. Narrow, so a double supplies only these. */
export interface DeclarationReads {
	declaration(symbolId: string): StoredDeclaration | null;
	declarationsIn(module: string): StoredDeclaration[];
	declarationsNamed(name: string): StoredDeclaration[];
}

////////////////////////////////
//  Functions & Helpers

export function toSummary(declaration: StoredDeclaration): SymbolSummary {
	return {
		symbolId: declaration.symbolId,
		name: declaration.name,
		kind: declaration.kind,
		module: declaration.module,
		visibility: declaration.visibility,
		...defined({
			containerId: declaration.containerId,
			exported: declaration.exported,
			signature: declaration.signature,
		}),
		...(declaration.range === undefined
			? {}
			: { lines: { start: declaration.range.start.line, end: declaration.range.end.line } }),
	};
}

////////////////////////////////
//  Class

export class ReadContext {
	private readonly modules = new Map<string, Containment>();
	private readonly declarations = new Map<string, StoredDeclaration | null>();

	constructor(private readonly store: DeclarationReads) {}

	/** Read once per context, a miss included. */
	declaration(symbolId: string): StoredDeclaration | null {
		const known = this.declarations.get(symbolId);
		if (known !== undefined) return known;
		const found = this.store.declaration(symbolId);
		this.declarations.set(symbolId, found);
		return found;
	}

	declarationsNamed(name: string): StoredDeclaration[] {
		return this.store.declarationsNamed(name);
	}

	summaryOf(symbolId: string): SymbolSummary | null {
		const declaration = this.declaration(symbolId);
		return declaration === null ? null : toSummary(declaration);
	}

	/** Declared members in source order, grouping kinds seen through; undefined asks the module. */
	membersOf(module: string, symbolId: string | undefined): StoredDeclaration[] {
		return this.topology(module).membersOf(symbolId);
	}

	/** Direct children that are not local, in source order. */
	declaredChildren(symbolId: string): StoredDeclaration[] {
		return this.topologyOf(symbolId)?.declaredChildren(symbolId) ?? [];
	}

	/** Locals whose evidence belongs to this declaration, in source order. */
	localsOwnedBy(symbolId: string): string[] {
		return this.topologyOf(symbolId)?.localsOwnedBy(symbolId) ?? [];
	}

	/** The declaration and the locals whose evidence it owns. */
	ownedIds(symbolId: string): string[] {
		return [symbolId, ...this.localsOwnedBy(symbolId)];
	}

	/** A declaration and everything whose container chain reaches it. */
	descendantIds(symbolId: string): Set<string> {
		return this.topologyOf(symbolId)?.descendantIds(symbolId) ?? new Set([symbolId]);
	}

	/** Parameter or local-holding ancestor, read in the declaration's own module. */
	isLocal(declaration: StoredDeclaration): boolean {
		return this.topology(declaration.module).isLocal(declaration);
	}

	/** The outermost holder below the grouping kinds. A use's containers stay in its own file. */
	topLevelIn(module: string, symbolId: string): StoredDeclaration | null {
		return this.topology(module).topLevel(symbolId);
	}

	/** Containers above a declaration, nearest first, stopping where `holds` refuses one. */
	ancestorsOf(
		declaration: StoredDeclaration,
		holds?: (container: StoredDeclaration) => boolean,
	): StoredDeclaration[] {
		const { ancestors } = ancestryOf(declaration, (symbolId) => {
			const container = this.declaration(symbolId);
			if (container === null) return null;
			return holds === undefined || holds(container) ? container : null;
		});
		return ancestors;
	}

	/** A literal sits in a scope when the declaration holding it does; one at module level does not. */
	literalWithin(scope: Scope, literal: StoredLiteral): boolean {
		return literal.containerId !== null && contains(scope, literal.containerId);
	}

	/** Held by a grouping anywhere above it, so a path reopened in another file names one thing. */
	spansModules(declaration: StoredDeclaration): boolean {
		return [declaration, ...this.ancestorsOf(declaration)].some((held) => GROUPING_KINDS.has(held.kind));
	}

	/** One module's declarations and their nesting, loaded once per context. */
	private topology(module: string): Containment {
		const known = this.modules.get(module);
		if (known !== undefined) return known;
		const rows = this.store.declarationsIn(module);
		// First answer for an id stands.
		for (const row of rows) if (!this.declarations.has(row.symbolId)) this.declarations.set(row.symbolId, row);
		const built = new Containment(rows);
		this.modules.set(module, built);
		return built;
	}

	/** The topology of the module holding this id, or null where the index does not hold it. */
	private topologyOf(symbolId: string): Containment | null {
		const declaration = this.declaration(symbolId);
		return declaration === null ? null : this.topology(declaration.module);
	}
}
