// C# type lookup: a type name through the scopes, namespaces and using directives around a use, and a
// type's members through its parts and bases.

import type { Binding, Declaration, Reference } from "@nyaa-lexicon/protocol";
import { CsharpImports, type Level } from "./imports.js";
import { type DeclarationMeta, type Segment, segmentKey } from "./model.js";
import { type IndexedType, typeKey } from "./namespaces.js";
import { type IndexedFacts, TYPE_DECLARATION_KINDS, type TypeAt } from "./workspace.js";

////////////////////////////////
//  Constants

const MEMBER_KINDS = new Set(["method", "constructor", "property", "field", "event", "constant", "variable"]);
const NO_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
/** A lookup's stand-in reference, never answered. */
const LOOKUP: Binding = { status: "unbound", reason: "NotImplemented", detail: "a lookup, never an answer" };
/** `global::` reads the global namespace alone, without using directives. */
const GLOBAL_LEVELS: readonly Level[] = [
	{ namespace: "", aliases: new Map(), namespaces: new Map(), statics: new Map(), staticTypes: [] },
];

////////////////////////////////
//  Interfaces & Types

/** How a type name is looked up. */
interface TypeLookup {
	/** The alias left of a `::` opening the name: `global`, a using alias, or an extern one. */
	qualifier?: string | undefined;
	/** Narrows a simple name's kinds. */
	role?: Reference["role"];
	/** The name stands in a type's base list, where the type's members are not in scope. */
	baseList?: boolean;
}

/** A base list's indexed classes, and whether one lies outside the workspace. */
export interface BaseTypes {
	types: TypeAt[];
	external: boolean;
}

////////////////////////////////
//  Functions & Helpers

function typeDeclaration(declaration: Declaration): boolean {
	return (
		TYPE_DECLARATION_KINDS.has(declaration.kind) ||
		declaration.kind === "typeParameter" ||
		declaration.languageKind === "delegate"
	);
}

function isMember(declaration: Declaration): boolean {
	return MEMBER_KINDS.has(declaration.kind);
}

////////////////////////////////
//  Classes

export abstract class CsharpTypeLookup extends CsharpImports {
	/** A reference's binding; a type's base list binds through it. */
	protected abstract bindingForReference(facts: IndexedFacts, reference: Reference): Binding;

	/**
	 * A type name as C# looks it up: the scopes around the use, then each enclosing namespace
	 * outward, then aliases and using directives. A dotted name's first name settles where the rest
	 * reads: in a type's nested types or a namespace. After `A::`, it reads in the namespace A names.
	 */
	protected lookupType(
		facts: IndexedFacts,
		from: DeclarationMeta | undefined,
		segments: readonly Segment[],
		{ qualifier, role = "typeUse", baseList = false }: TypeLookup = {},
	): { symbolId: string }[] {
		const [head, ...rest] = segments;
		if (head === undefined) return [];
		if (qualifier === undefined) {
			const scoped = this.scopedTypes(facts, from, head.name, {
				arity: head.arity,
				role: rest.length === 0 ? role : "typeUse",
				baseList,
			});
			if (rest.length === 0 && scoped.length > 0) return scoped;
			if (scoped.length > 0) {
				const meta = scoped.length === 1 ? this.typeAt(scoped[0]?.symbolId)?.meta : undefined;
				if (meta === undefined || meta.declaration.kind === "typeParameter") return [];
				return this.indexed(meta.namespaceName, `${typeKey(meta)}.${segmentKey(rest)}`, facts.module);
			}
		}
		// The namespace declaration around the use settles the levels and the using directives at each.
		const global = qualifier === "global";
		const scope = global ? undefined : this.enclosingNamespace(facts, from);
		const key = `type\0${facts.module}\0${scope?.declaration.symbolId ?? ""}\0${qualifier ?? ""}\0${segmentKey(segments)}`;
		return this.store.memo(key, () => {
			if (global) return this.indexedTypes(GLOBAL_LEVELS, segments, facts.module);
			const levels = this.levels(facts, scope);
			if (qualifier === undefined) return this.indexedTypes(levels, segments, facts.module);
			const namespace = this.aliasedNamespace(levels, qualifier);
			return namespace === undefined ? [] : this.underNamespace(namespace, segments, facts.module);
		});
	}

	/**
	 * Each level outward: its namespace's members, then the using directives there. The first name
	 * settles a level: a namespace the rest reads under, a type, or an alias.
	 */
	private indexedTypes(levels: readonly Level[], segments: readonly Segment[], module: string): IndexedType[] {
		const [head, ...rest] = segments;
		if (head === undefined) return [];
		for (const level of levels) {
			const members = this.settle(level.namespace, segments, module);
			if (members !== undefined) return members;
			const alias = head.arity === 0 ? level.aliases.get(head.name) : undefined;
			if (alias !== undefined)
				return this.resolveFrom(level.namespace, [...alias.target, ...rest], alias.qualifier, module);
			const found = this.usedTypes(level, segments, module);
			if (found.length > 0) return found;
		}
		return [];
	}

	/**
	 * A type name in the scopes around a use, innermost first: type parameters, then a type's nested
	 * types in any part or base. A type's base list sees only its type parameters.
	 */
	private scopedTypes(
		facts: IndexedFacts,
		from: DeclarationMeta | undefined,
		name: string,
		{ arity, role, baseList }: { arity: number; role: Reference["role"]; baseList: boolean },
	): { symbolId: string }[] {
		const use: Reference = { name, role, range: NO_RANGE, qualified: false, binding: LOOKUP };
		const seen = new Set<string>();
		let current = from;
		while (current !== undefined && current.declaration.kind !== "namespace") {
			if (seen.has(current.declaration.symbolId)) break;
			seen.add(current.declaration.symbolId);
			if (arity === 0) {
				const parts = new Set(this.partsOf(facts, current));
				const parameter = (facts.byName.get(name) ?? []).find(
					(meta) =>
						meta.declaration.kind === "typeParameter" && parts.has(meta.declaration.containerId ?? ""),
				);
				if (parameter !== undefined) return [parameter.declaration];
			}
			const type = current === from && baseList ? undefined : this.typeAt(current.declaration.symbolId);
			if (type !== undefined && TYPE_DECLARATION_KINDS.has(type.meta.declaration.kind)) {
				const own = this.ownMembers(type, use);
				const nested = own.length > 0 ? own : this.inherited(this.baseTypes(type), use).found;
				if (nested.length > 0) return this.canonicalTypes(nested, arity);
			}
			current = current.parentId === undefined ? undefined : facts.metadata.get(current.parentId);
		}
		return [];
	}

	/** Types of exactly `arity` type parameters, a partial one by its first part in its project. */
	private canonicalTypes(declarations: readonly Declaration[], arity: number): { symbolId: string }[] {
		const found = new Set<string>();
		for (const declaration of declarations) {
			const at = this.typeAt(declaration.symbolId);
			if (at === undefined || (at.meta.arity ?? 0) !== arity) continue;
			found.add(this.typeParts(at)[0]?.meta.declaration.symbolId ?? declaration.symbolId);
		}
		return [...found].map((symbolId) => ({ symbolId }));
	}

	/** Members on the nearest level of a base chain that declares one; `external` when the chain leaves the workspace. */
	protected inherited(bases: BaseTypes, reference: Reference): { found: Declaration[]; external: boolean } {
		const seen = new Set<string>();
		let level = bases;
		let external = false;
		while (level.types.length > 0) {
			external ||= level.external;
			const found: Declaration[] = [];
			for (const type of level.types) {
				seen.add(type.meta.declaration.symbolId);
				found.push(...this.ownMembers(type, reference));
			}
			if (found.length > 0) return { found: this.uniqueDeclarations(found), external };
			const next = level.types.map((type) => this.baseTypes(type));
			level = {
				types: next.flatMap((item) => item.types).filter((type) => !seen.has(type.meta.declaration.symbolId)),
				external: next.some((item) => item.external),
			};
		}
		return { found: [], external: external || level.external };
	}

	/** A type's own members of the reference's name and role, never its locals. */
	protected ownMembers(type: TypeAt, reference: Reference): Declaration[] {
		const found: Declaration[] = [];
		for (const part of this.typeParts(type))
			for (const meta of part.facts.byName.get(reference.name) ?? [])
				if (
					meta.declaration.containerId === part.meta.declaration.symbolId &&
					meta.declaration.visibility !== "local" &&
					this.roleMatches(reference.role, meta.declaration)
				)
					found.push(meta.declaration);
		return this.uniqueDeclarations(found);
	}

	/**
	 * The types a type inherits members from, bound: a class's base class, an interface's base
	 * interfaces; `external` when one lies outside the workspace.
	 */
	protected baseTypes(type: TypeAt): BaseTypes {
		const id = type.meta.declaration.symbolId;
		// A cycle through base lists, which C# refuses, reads as no bases where it closes.
		const resolving = this.store.memo(`resolving\0${id}`, () => ({ now: false }));
		if (resolving.now) return { types: [], external: false };
		const inherits = type.meta.declaration.kind === "interface" ? "interface" : "class";
		const bases = this.store.memo(`bases\0${id}`, () => {
			resolving.now = true;
			try {
				const ids: string[] = [];
				let external = false;
				// Any part of a partial type may name its base.
				for (const part of this.typeParts(type))
					for (const reference of part.facts.bases.get(part.meta.declaration.symbolId) ?? []) {
						const binding = this.bindingForReference(part.facts, reference);
						if (binding.status === "bound") {
							if (this.typeAt(binding.symbolId)?.meta.declaration.kind === inherits)
								ids.push(binding.symbolId);
						} else external ||= binding.status === "unbound" && binding.reason === "ExternalDependency";
					}
				return { ids, external };
			} finally {
				resolving.now = false;
			}
		});
		return { types: this.typesAt(bases.ids), external: bases.external };
	}

	protected roleMatches(role: Reference["role"], declaration: Declaration): boolean {
		// A local or parameter is called when it holds a delegate, and hides a method of its name.
		if (role === "call")
			return (
				declaration.kind === "method" ||
				(declaration.kind === "function" && declaration.languageKind !== "delegate") ||
				declaration.kind === "constructor" ||
				(declaration.kind === "variable" && declaration.visibility === "local")
			);
		if (role === "read" || role === "write") return isMember(declaration);
		if (role === "extends")
			return declaration.kind === "class" || declaration.kind === "interface" || declaration.kind === "struct";
		if (role === "implements") return declaration.kind === "interface";
		if (role === "typeUse" || role === "instantiate") return typeDeclaration(declaration);
		return false;
	}

	protected uniqueDeclarations(declarations: Declaration[]): Declaration[] {
		const unique = new Map<string, Declaration>();
		for (const declaration of declarations) unique.set(declaration.symbolId, declaration);
		return [...unique.values()];
	}
}
