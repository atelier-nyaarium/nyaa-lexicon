// The C# workspace as the module store holds it: each module's facts, each type's declarations and
// parts, and the declarations around a use.

import {
	comparePositions,
	type Declaration,
	type ModuleStore,
	parseSymbolId,
	type Reference,
	type WorkMeter,
} from "@nyaa-lexicon/protocol";
import type { CsharpFacts, DeclarationMeta } from "./model.js";
import { type IndexEntry, type IndexedType, type NamespaceIndex, typeKey } from "./namespaces.js";
import { type CsharpProjectState, contextFor } from "./project.js";

////////////////////////////////
//  Constants

export const TYPE_DECLARATION_KINDS = new Set(["class", "interface", "struct", "enum"]);

////////////////////////////////
//  Interfaces & Types

export type Range = Declaration["range"];

/** A type declaration where it lives. */
export interface TypeAt {
	module: string;
	facts: IndexedFacts;
	meta: DeclarationMeta;
}

/** A module's facts with the lookups binding reads, built once per parse. */
export interface IndexedFacts extends CsharpFacts {
	byName: ReadonlyMap<string, readonly DeclarationMeta[]>;
	/** Each type's `extends` references, by the type's id. */
	bases: ReadonlyMap<string, readonly Reference[]>;
}

////////////////////////////////
//  Functions & Helpers

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list === undefined) map.set(key, [value]);
	else list.push(value);
}

export function indexed(facts: CsharpFacts): IndexedFacts {
	const byName = new Map<string, DeclarationMeta[]>();
	for (const meta of facts.metadata.values()) pushTo(byName, meta.declaration.name, meta);
	const bases = new Map<string, Reference[]>();
	for (const reference of facts.references)
		if (reference.role === "extends" && reference.fromId !== undefined) pushTo(bases, reference.fromId, reference);
	return { ...facts, byName, bases };
}

export function contains(range: Range, position: Range["start"]): boolean {
	// Inclusive both ends
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

/** Half-open: a use starting where the range ends is past it. */
export function within(range: Range, position: Range["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) < 0;
}

////////////////////////////////
//  Classes

export abstract class CsharpWorkspace {
	constructor(protected readonly meter?: WorkMeter) {}

	/** Every module's facts, and the index entries they add. */
	abstract readonly store: ModuleStore<IndexedFacts, CsharpProjectState, IndexEntry>;

	/** The workspace's namespaces and types, read through the store. */
	protected abstract readonly index: NamespaceIndex;

	protected factsForModule(module: string, depth?: "full"): IndexedFacts | null {
		return this.store.load(module, depth) ?? null;
	}

	/** A module's project, "" outside every one. */
	protected projectOf(module: string): string {
		return contextFor(this.store.project, module)?.project ?? "";
	}

	/**
	 * One type identity's declarations as candidates: a partial type once per project, by its first
	 * part; namesakes are other projects' (C# refuses two in one, and prefers its own to an imported
	 * one), so the referring file's, then its project's, win.
	 */
	protected indexed(namespace: string, key: string, module: string): IndexedType[] {
		const projects = new Set<string>();
		const types: IndexedType[] = [];
		for (const entry of this.index.types(namespace, key, module)) {
			if (entry.partial) {
				const project = this.projectOf(entry.module);
				if (projects.has(project)) continue;
				projects.add(project);
			}
			types.push(entry);
		}
		if (types.length < 2) return types;
		const own = types.filter((type) => type.module === module);
		if (own.length > 0) return own;
		const project = this.projectOf(module);
		const sameProject = types.filter((type) => this.projectOf(type.module) === project);
		return sameProject.length > 0 ? sameProject : types;
	}

	/** The namespace declaration holding a declaration, or the declaration itself when it is one. */
	protected enclosingNamespace(facts: IndexedFacts, from: DeclarationMeta | undefined): DeclarationMeta | undefined {
		let current = from;
		const seen = new Set<string>();
		while (current !== undefined && current.declaration.kind !== "namespace") {
			if (seen.has(current.declaration.symbolId)) return undefined;
			seen.add(current.declaration.symbolId);
			current = current.parentId === undefined ? undefined : facts.metadata.get(current.parentId);
		}
		return current;
	}

	/** A type's declarations: a partial type's parts in every file of its project. */
	protected typeParts(type: TypeAt): TypeAt[] {
		if (type.meta.isPartial !== true) return [type];
		// Memos keep ids, never facts a later parse replaces.
		const ids = this.store.memo(`parts\0${type.meta.declaration.symbolId}`, () => {
			const project = this.projectOf(type.module);
			return this.index
				.types(type.meta.namespaceName, typeKey(type.meta), type.module)
				.filter((entry) => entry.partial && this.projectOf(entry.module) === project)
				.map((entry) => entry.symbolId);
		});
		const parts = this.typesAt(ids);
		return parts.length > 0 ? parts : [type];
	}

	protected typesAt(symbolIds: readonly string[]): TypeAt[] {
		return symbolIds.map((symbolId) => this.typeAt(symbolId)).filter((type): type is TypeAt => type !== undefined);
	}

	protected enclosingType(facts: IndexedFacts, from: DeclarationMeta | undefined): DeclarationMeta | undefined {
		let current = from;
		const seen = new Set<string>();
		while (current !== undefined && !TYPE_DECLARATION_KINDS.has(current.declaration.kind)) {
			if (seen.has(current.declaration.symbolId)) return undefined;
			seen.add(current.declaration.symbolId);
			current = current.parentId === undefined ? undefined : facts.metadata.get(current.parentId);
		}
		return current;
	}

	protected typeAt(symbolId: string | undefined): TypeAt | undefined {
		if (symbolId === undefined) return undefined;
		const module = this.store.memo(`module\0${symbolId}`, () => parseSymbolId(symbolId)?.module);
		const facts = module === undefined ? null : this.factsForModule(module);
		const meta = facts?.metadata.get(symbolId);
		return module === undefined || facts === null || meta === undefined ? undefined : { module, facts, meta };
	}

	/** A declaration's id, with a partial type's other parts in the same file: one type identity's. */
	protected partsOf(facts: IndexedFacts, meta: DeclarationMeta): string[] {
		if (meta.isPartial !== true) return [meta.declaration.symbolId];
		const parts = (facts.byName.get(meta.declaration.name) ?? []).filter(
			(other) =>
				other.isPartial === true &&
				other.declaration.kind === meta.declaration.kind &&
				other.namespaceName === meta.namespaceName &&
				typeKey(other) === typeKey(meta),
		);
		return [meta.declaration.symbolId, ...parts.map((other) => other.declaration.symbolId)];
	}
}
