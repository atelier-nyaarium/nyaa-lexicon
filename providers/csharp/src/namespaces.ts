// The workspace's namespaces and the types in them, kept by the module store as each file changes.

import type { Declaration, ModuleStore } from "@nyaa-lexicon/protocol";
import { type CsharpFacts, type DeclarationMeta, type Segment, segmentKey } from "./model.js";

////////////////////////////////
//  Interfaces & Types

/** A type declaration as the index holds it. */
export interface IndexedType {
	module: string;
	symbolId: string;
	partial: boolean;
	/** Declared `file`, or nested in a type that is: named from its own module alone. */
	fileLocal: boolean;
}

/** A `global using`, which every file of its project reads. */
export interface GlobalUsing {
	module: string;
	specifier: string;
	alias?: string;
	static: boolean;
	target: Segment[];
	qualifier?: string;
}

/** A type declaration's identity: its namespace and `typeKey`. */
export interface NamedType {
	namespace: string;
	key: string;
}

/** A namespace declaration's id where it stands. */
export interface IndexedNamespace {
	module: string;
	symbolId: string;
}

/** A module declaring a namespace, a type, a namespace declaration, or a global using; or a type identity by name. */
export type IndexEntry = string | IndexedType | IndexedNamespace | GlobalUsing;

////////////////////////////////
//  Constants

const TYPE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "struct", "enum"]);

const GLOBAL_USINGS = "usings:global";

////////////////////////////////
//  Functions & Helpers

export function isTypeKind(declaration: Declaration): boolean {
	return TYPE_KINDS.has(declaration.kind) || declaration.languageKind === "delegate";
}

/** A type declaration's own name with its type parameters: `Inner`, or `Outer`1`. */
function ownKey(meta: DeclarationMeta): string {
	return segmentKey([{ name: meta.declaration.name, arity: meta.arity ?? 0 }]);
}

/** A type declaration's name with the types around it, each with its type parameters: `Outer`1.Inner`. */
export function typeKey(meta: DeclarationMeta): string {
	return meta.typePath === "" ? ownKey(meta) : `${meta.typePath}.${ownKey(meta)}`;
}

/** The enclosing namespaces of one, innermost first, through the global namespace. */
export function namespaceLevels(namespace: string): string[] {
	const levels: string[] = [];
	const parts = namespace === "" ? [] : namespace.split(".");
	for (let length = parts.length; length >= 0; length--) levels.push(parts.slice(0, length).join("."));
	return levels;
}

export function joinNamespace(...parts: string[]): string {
	return parts.filter((part) => part !== "").join(".");
}

/** A `file` type, or one nested in it. */
export function inFileType(meta: DeclarationMeta, metadata: ReadonlyMap<string, DeclarationMeta>): boolean {
	for (let current: DeclarationMeta | undefined = meta; current !== undefined; ) {
		if (current.declaration.visibility === "fileLocal") return true;
		current = current.parentId === undefined ? undefined : metadata.get(current.parentId);
	}
	return false;
}

function isIndexedType(entry: IndexEntry): entry is IndexedType {
	return typeof entry === "object" && "partial" in entry;
}

function isIndexedNamespace(entry: IndexEntry): entry is IndexedNamespace {
	return typeof entry === "object" && "symbolId" in entry && !("partial" in entry);
}

function isGlobalUsing(entry: IndexEntry): entry is GlobalUsing {
	return typeof entry === "object" && "specifier" in entry;
}

/** What one module adds to the index. */
export function namespaceEntries(module: string, facts: CsharpFacts): Iterable<readonly [string, IndexEntry]> {
	const entries: [string, IndexEntry][] = [];
	const namespaces = new Set<string>();
	for (const name of facts.namespaceNames) {
		const parts = name.split(".");
		for (let length = 1; length <= parts.length; length++) namespaces.add(parts.slice(0, length).join("."));
	}
	for (const name of namespaces) entries.push([`ns:${name}`, module]);
	for (const meta of facts.metadata.values()) {
		const declaration = meta.declaration;
		if (declaration.visibility === "local") continue;
		if (declaration.kind === "namespace")
			entries.push([
				`nsdecl:${joinNamespace(meta.namespaceName, declaration.name)}`,
				{ module, symbolId: declaration.symbolId },
			]);
		else if (isTypeKind(declaration)) {
			entries.push([
				`type:${meta.namespaceName}\0${typeKey(meta)}`,
				{
					module,
					symbolId: declaration.symbolId,
					partial: meta.isPartial === true,
					fileLocal: inFileType(meta, facts.metadata),
				},
			]);
			entries.push([`name:${ownKey(meta)}`, `${meta.namespaceName}\0${typeKey(meta)}`]);
		}
	}
	for (const imported of facts.imports)
		if (imported.global)
			entries.push([
				GLOBAL_USINGS,
				{
					module,
					specifier: imported.specifier,
					static: imported.static,
					target: imported.target,
					...(imported.qualifier === undefined ? {} : { qualifier: imported.qualifier }),
					...(imported.alias === undefined ? {} : { alias: imported.alias }),
				},
			]);
	return entries;
}

////////////////////////////////
//  Classes

/** Reads the index; every answer is an indexed lookup, never a scan of the workspace. */
export class NamespaceIndex {
	constructor(private readonly store: Pick<ModuleStore<unknown, unknown, IndexEntry>, "get">) {}

	isNamespace(namespace: string): boolean {
		return namespace === "" || this.store.get(`ns:${namespace}`).length > 0;
	}

	/** A namespace's declarations, sorted by module. */
	declarationsOf(namespace: string): IndexedNamespace[] {
		return this.store.get(`nsdecl:${namespace}`).filter(isIndexedNamespace);
	}

	/** Every project's `global using` directives, sorted by module. */
	globalUsings(): GlobalUsing[] {
		return this.store.get(GLOBAL_USINGS).filter(isGlobalUsing);
	}

	/** Every declaration of one type identity `from` may name, by its namespace and `typeKey`, sorted by module. */
	types(namespace: string, key: string, from: string): IndexedType[] {
		return this.store
			.get(`type:${namespace}\0${key}`)
			.filter(
				(entry): entry is IndexedType => isIndexedType(entry) && (!entry.fileLocal || entry.module === from),
			);
	}

	/** The type identities whose own name with its type parameters is `own`, in any namespace or type. */
	typesNamed(own: string): NamedType[] {
		const named = this.store.get(`name:${own}`).filter((entry): entry is string => typeof entry === "string");
		return [...new Set(named)].map((entry) => {
			const [namespace = "", key = ""] = entry.split("\0");
			return { namespace, key };
		});
	}
}
