// One read's view of declaration topology: which declarations a module holds, how they nest, and
// the summary each one answers as.
//
// Built once per read and handed down, so a read asking three things about one module loads it
// once. Every reader asks here rather than deriving containment a second way; a residue test holds
// the containment, the container walk and the summary to this file and `locals.ts`, and a module's
// rows to the readers it names.
//
// Each module is stamped at its first touch, in the same synchronous span as the rows, so a writer
// planning from this context can prove those rows were not committed again before it wrote.

import {
	type AllList,
	defined,
	GROUPING_KINDS,
	type Landing,
	type QuestionClass,
	questionsFor,
	type Range,
	type StoredExport,
	type SymbolSummary,
} from "@nyaa-lexicon/protocol";
import { type EffectiveExport, type ScopeLanding, scopeKey, scopeOfKey } from "./exportProjection.js";
import { ancestryOf, Containment } from "./locals.js";
import { contains, type Scope } from "./scope.js";
import type {
	FactsStamp,
	StoredComment,
	StoredDeclaration,
	StoredImport,
	StoredLiteral,
	StoredReference,
} from "./store.js";

////////////////////////////////
//  Interfaces & Types

/** The declaration reads a context is built from. Narrow, so a double supplies only these. */
export interface DeclarationReads {
	declaration(symbolId: string): StoredDeclaration | null;
	declarationsIn(module: string): StoredDeclaration[];
	declarationsNamed(name: string): StoredDeclaration[];
	referencesTo(symbolId: string): StoredReference[];
	referencesIn(module: string): StoredReference[];
	referencesSpelled(name: string, excludingTarget: string): StoredReference[];
	importsBinding(localName: string): StoredImport[];
	importsNamed(name: string): StoredImport[];
	importsIn(module: string): StoredImport[];
	exposuresNamed(name: string): Array<{ module: string; originSymbolId: string | null }>;
	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null;
	/** Advanced by every write a contributor to the scope makes. */
	scopeGeneration(key: string): number;
	/** Every stored id for a module: the id grammar's own subtree, not this file's containment. */
	symbolIdsIn(module: string): string[];
	stampOf(module: string): FactsStamp | null;
	fileOf(module: string): { exportsKnown: boolean; allList: AllList | null } | null;
	exportsIn(module: string): StoredExport[];
	importEdgeAt(module: string, span: Range): StoredImport | null;
	exportedDeclarations(module: string): Array<{ symbolId: string; name: string }>;
	scopeExports(landing: ScopeLanding): Array<{ module: string; edge: StoredExport }>;
	effectiveExportsOf(module: string): EffectiveExport[];
	importEdgesLandingOn(landing: Landing): StoredImport[];
	modulesExposing(symbolId: string): string[];
	scopesHolding(symbolId: string): ScopeLanding[];
	modulesHoldingNamespace(landing: Landing): string[];
	scopeKeysOf(module: string): string[];
	commentsIn(module: string): StoredComment[];
	literalsIn(module: string): StoredLiteral[];
	writerOf(module: string): string | null;
	/** Advanced by every fact admission, replacement and removal. */
	factsGeneration(): number;
}

/**
 * A module as a context first touched it, null where the index held nothing; a scope at the
 * generation it read; or the whole index at its facts generation, once pinned.
 */
export type FactsSeen =
	| { module: string; stamp: FactsStamp | null }
	| { scope: string; scopeId: string; generation: number }
	| { index: number };

////////////////////////////////
//  Functions & Helpers

/** Named in place of a module when only the pinned index moved. */
export const UNREAD_FILE = "a file the plan did not read";

/** Modules whose rows were committed again since a context saw them: a re-parse of unchanged bytes
 * or a depth upgrade, neither of which a content hash can see. A moved scope is named by its id. */
export function factsMovedSince(
	seen: FactsSeen[],
	reads: Pick<DeclarationReads, "stampOf" | "scopeGeneration" | "factsGeneration">,
): string[] {
	const moved = seen.flatMap((entry) => {
		if ("index" in entry) return [];
		if ("scope" in entry) return reads.scopeGeneration(entry.scope) === entry.generation ? [] : [entry.scopeId];
		const now = reads.stampOf(entry.module);
		const { stamp } = entry;
		const changed =
			stamp === null || now === null
				? stamp !== now
				: now.depth !== stamp.depth || now.indexedAt !== stamp.indexedAt;
		return changed ? [entry.module] : [];
	});
	const pinned = seen.flatMap((entry) => ("index" in entry ? [entry.index] : []));
	if (moved.length > 0 || pinned.every((generation) => generation === reads.factsGeneration())) return moved;
	return [UNREAD_FILE];
}

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
	private readonly stamps = new Map<string, FactsStamp | null>();
	private readonly scopes = new Map<string, { scopeId: string; generation: number }>();
	private index: number | null = null;

	constructor(private readonly store: DeclarationReads) {}

	/** Read once per context, a miss included. */
	declaration(symbolId: string): StoredDeclaration | null {
		const known = this.declarations.get(symbolId);
		if (known !== undefined) return known;
		const found = this.store.declaration(symbolId);
		if (found !== null) this.touch(found.module);
		this.declarations.set(symbolId, found);
		return found;
	}

	/** Every module read, stamped at its first touch; every scope read; and the pinned index. */
	seen(): FactsSeen[] {
		return [
			...[...this.stamps].map(([module, stamp]) => ({ module, stamp })),
			...[...this.scopes].map(([scope, { scopeId, generation }]) => ({ scope, scopeId, generation })),
			...(this.index === null ? [] : [{ index: this.index }]),
		];
	}

	/** Pins the index's facts generation, the first call standing: then any file's write moves this context. */
	pinIndex(): void {
		if (this.index === null) this.index = this.store.factsGeneration();
	}

	/** Every row's own module stamped, wherever it falls. */
	declarationsNamed(name: string): StoredDeclaration[] {
		const rows = this.store.declarationsNamed(name);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** Bound edges into this id, each row's own module stamped. */
	referencesTo(symbolId: string): StoredReference[] {
		const rows = this.store.referencesTo(symbolId);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** Every reference written in a module, the module stamped once. */
	referencesIn(module: string): StoredReference[] {
		this.touch(module);
		return this.store.referencesIn(module);
	}

	/** Occurrences spelled like a name that did not bind to it, each row's own module stamped. */
	referencesSpelled(name: string, excludingTarget: string): StoredReference[] {
		const rows = this.store.referencesSpelled(name, excludingTarget);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** Imports binding a name, each row's own module stamped. */
	importsBinding(localName: string): StoredImport[] {
		const rows = this.store.importsBinding(localName);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** Every import writing a name, wherever it falls, each row's own module stamped. */
	importsNamed(name: string): StoredImport[] {
		const rows = this.store.importsNamed(name);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** Every import statement in a module, the module stamped once. */
	importsIn(module: string): StoredImport[] {
		this.touch(module);
		return this.store.importsIn(module);
	}

	/** Each module exposing a name, each row's own module stamped. */
	exposuresNamed(name: string): Array<{ module: string; originSymbolId: string | null }> {
		const rows = this.store.exposuresNamed(name);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** A scope's members, the scope stamped at the generation first read. */
	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null {
		this.touchScope(landing);
		return this.store.scopeMembers(landing);
	}

	/** The file row, the module stamped; null where the index holds no such module. */
	fileOf(module: string): { exportsKnown: boolean; allList: AllList | null } | null {
		this.touch(module);
		return this.store.fileOf(module);
	}

	/** Export edges a module states, the module stamped. */
	exportsIn(module: string): StoredExport[] {
		this.touch(module);
		return this.store.exportsIn(module);
	}

	/** The import edge written at exactly `span`, the module stamped. */
	importEdgeAt(module: string, span: Range): StoredImport | null {
		this.touch(module);
		return this.store.importEdgeAt(module, span);
	}

	/** Top-level declarations another module may reach, the module stamped. */
	exportedDeclarations(module: string): Array<{ symbolId: string; name: string }> {
		this.touch(module);
		return this.store.exportedDeclarations(module);
	}

	/** Export edges contributors state from a scope: the scope stamped, and each row's module. */
	scopeExports(landing: ScopeLanding): Array<{ module: string; edge: StoredExport }> {
		this.touchScope(landing);
		const rows = this.store.scopeExports(landing);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** The effective exports last settled for a module; a settlement that moves them restamps it. */
	effectiveExportsOf(module: string): EffectiveExport[] {
		this.touch(module);
		return this.store.effectiveExportsOf(module);
	}

	/** Edges landing on `landing` when written, each row's module stamped; a new one moves only the pinned index. */
	importEdgesLandingOn(landing: Landing): StoredImport[] {
		const rows = this.store.importEdgesLandingOn(landing);
		for (const row of rows) this.touch(row.module);
		return rows;
	}

	/** Modules exposing a declaration under some name, each stamped. */
	modulesExposing(symbolId: string): string[] {
		const modules = this.store.modulesExposing(symbolId);
		for (const module of modules) this.touch(module);
		return modules;
	}

	/** Scopes listing a declaration as a member, each stamped at its generation. */
	scopesHolding(symbolId: string): ScopeLanding[] {
		const scopes = this.store.scopesHolding(symbolId);
		for (const scope of scopes) this.touchScope(scope);
		return scopes;
	}

	/** Modules exposing a landing as a namespace or a module value, each stamped. */
	modulesHoldingNamespace(landing: Landing): string[] {
		const modules = this.store.modulesHoldingNamespace(landing);
		for (const module of modules) this.touch(module);
		return modules;
	}

	/** The scopes a module contributes to, the module stamped and each scope at its generation. */
	scopesOf(module: string): ScopeLanding[] {
		this.touch(module);
		const scopes = this.store.scopeKeysOf(module).map(scopeOfKey);
		for (const scope of scopes) this.touchScope(scope);
		return scopes;
	}

	/** Comments written in a module, the module stamped. */
	commentsIn(module: string): StoredComment[] {
		this.touch(module);
		return this.store.commentsIn(module);
	}

	/** Literals written in a module, the module stamped. */
	literalsIn(module: string): StoredLiteral[] {
		this.touch(module);
		return this.store.literalsIn(module);
	}

	/** The provider that wrote a module's facts, the module stamped. */
	writerOf(module: string): string | null {
		this.touch(module);
		return this.store.writerOf(module);
	}

	/** Every id the module holds, for a rename's own id-grammar walk; asks nothing about
	 * containment, so the module asked is stamped and nothing else. */
	symbolIdsIn(module: string): string[] {
		this.touch(module);
		return this.store.symbolIdsIn(module);
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

	/** Every declaration a module holds, in source order. */
	heldIn(module: string): StoredDeclaration[] {
		return this.topology(module).held();
	}

	/** Direct children in source order, locals included; undefined asks the module level. */
	heldBy(module: string, containerId: string | undefined): StoredDeclaration[] {
		return this.topology(module).heldBy(containerId);
	}

	/** Whether the module's rows carry this id. */
	holds(module: string, symbolId: string): boolean {
		return this.topology(module).holds(symbolId);
	}

	/** Parameter or local-holding ancestor, read in the declaration's own module. */
	isLocal(declaration: StoredDeclaration): boolean {
		return this.topology(declaration.module).isLocal(declaration);
	}

	/** The knowledge questions its kind takes; none when local. */
	questionsOf(declaration: StoredDeclaration): readonly QuestionClass[] {
		return questionsFor({ kind: declaration.kind, local: this.isLocal(declaration) });
	}

	/** Resolve ownership in the use's module. */
	ownerIn(module: string, symbolId: string): StoredDeclaration | null {
		return this.topology(module).ownerOf(symbolId);
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
		this.touch(module);
		const rows = this.store.declarationsIn(module);
		// First answer for an id stands.
		for (const row of rows) if (!this.declarations.has(row.symbolId)) this.declarations.set(row.symbolId, row);
		const built = new Containment(rows);
		this.modules.set(module, built);
		return built;
	}

	/** First stamp stands, as the first row does. */
	private touch(module: string): void {
		if (!this.stamps.has(module)) this.stamps.set(module, this.store.stampOf(module));
	}

	/** First generation stands, as the first stamp does. */
	private touchScope(landing: ScopeLanding): void {
		const key = scopeKey(landing);
		if (this.scopes.has(key)) return;
		this.scopes.set(key, { scopeId: landing.scopeId, generation: this.store.scopeGeneration(key) });
	}

	/** The topology of the module holding this id, or null where the index does not hold it. */
	private topologyOf(symbolId: string): Containment | null {
		const declaration = this.declaration(symbolId);
		return declaration === null ? null : this.topology(declaration.module);
	}
}
