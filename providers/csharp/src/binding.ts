// C# binding: each reference to its declaration, through the locals, members, receivers and using
// directives around it.

import { type Binding, comparePositions, type Declaration, type Reference } from "@nyaa-lexicon/protocol";
import { candidatesBinding, isExternalSpecifier, type Using, unbound } from "./imports.js";
import { type BaseTypes, CsharpTypeLookup } from "./lookup.js";
import { type DeclarationMeta, positionKey, type Segment } from "./model.js";
import { type IndexedFacts, within } from "./workspace.js";

////////////////////////////////
//  Constants

/** Roles that name a type. */
const TYPE_ROLES: ReadonlySet<Reference["role"]> = new Set(["typeUse", "extends", "implements", "instantiate"]);
/** Roles a member access binds through its receiver. */
const MEMBER_ROLES: ReadonlySet<Reference["role"]> = new Set(["call", "read", "write"]);

////////////////////////////////
//  Classes

export abstract class CsharpBinder extends CsharpTypeLookup {
	/** `[Marker]` names `MarkerAttribute` too. */
	protected bindingForReference(facts: IndexedFacts, reference: Reference): Binding {
		const written = this.bindingOf(facts, reference);
		if (written.status !== "unbound" || !facts.attributeNames.has(positionKey(reference.range.start)))
			return written;
		const suffixed = this.bindingOf(facts, { ...reference, name: `${reference.name}Attribute` });
		return suffixed.status === "unbound" ? written : suffixed;
	}

	private bindingOf(facts: IndexedFacts, reference: Reference): Binding {
		const from = reference.fromId === undefined ? undefined : facts.metadata.get(reference.fromId);
		if (reference.role === "import") return this.importBinding(facts, reference, from);
		if (TYPE_ROLES.has(reference.role)) return this.typeBinding(facts, reference, from);
		if (reference.qualified === true && MEMBER_ROLES.has(reference.role))
			return this.memberBinding(facts, reference, from);
		const candidates = this.sameFileCandidates(facts, reference, from);
		if (candidates.length > 0) return candidatesBinding(candidates);
		// The enclosing type's parts in other files, then what it inherits, then `using static`.
		const owner = this.typeAt(this.enclosingType(facts, from)?.declaration.symbolId);
		const own = owner === undefined ? [] : this.ownMembers(owner, reference);
		if (own.length > 0) return candidatesBinding(own);
		const inherited = owner === undefined ? undefined : this.inheritedBinding(this.baseTypes(owner), reference);
		if (inherited !== undefined && inherited.status !== "unbound") return inherited;
		const imported = this.staticMembers(facts, reference, from);
		if (imported.length > 0) return candidatesBinding(imported);
		// A receiver's name that no value takes is a type's.
		const arity =
			reference.role === "read" ? facts.receiverNames.get(positionKey(reference.range.start)) : undefined;
		const types = arity === undefined ? [] : this.lookupType(facts, from, [{ name: reference.name, arity }]);
		if (types.length > 0) return candidatesBinding(types);
		if (inherited?.status === "unbound" && inherited.reason === "ExternalDependency") return inherited;
		return this.unresolved(facts, reference.name);
	}

	/** A type name, looked up as C# does; a dotted one through its qualifier. */
	private typeBinding(facts: IndexedFacts, reference: Reference, from: DeclarationMeta | undefined): Binding {
		const own = { name: reference.name, arity: facts.typeArities.get(positionKey(reference.range.start)) ?? 0 };
		let segments: Segment[] = [own];
		let qualifier: string | undefined;
		if (reference.qualified === true) {
			const receiver = facts.receivers.get(positionKey(reference.range.start));
			if (receiver?.kind === "name") segments = [{ name: receiver.name, arity: receiver.arity }, own];
			else if (receiver?.kind === "path") {
				segments = [...receiver.path, own];
				qualifier = receiver.qualifier;
			} else return unbound("NotImplemented", "the qualifier is not a name");
		}
		const found = this.lookupType(facts, from, segments, {
			qualifier,
			role: reference.role,
			baseList: facts.baseListNames.has(positionKey(reference.range.start)),
		});
		return found.length > 0 ? candidatesBinding(found) : this.unresolved(facts, segments[0]?.name ?? "");
	}

	/** This file's using directives, and its project's `global using`. */
	private usings(facts: IndexedFacts): Using[] {
		return [...facts.imports, ...this.globalUsings(facts.module)];
	}

	/** Nothing indexed matches: outside the workspace when the name's head or a using directive says so. */
	private unresolved(facts: IndexedFacts, head: string): Binding {
		if (isExternalSpecifier(head)) return unbound("ExternalDependency", "the name is in an external namespace");
		const external = this.store.memo(`external\0${facts.module}`, () =>
			this.usings(facts).some((using) => isExternalSpecifier(using.specifier)),
		);
		if (external) return unbound("ExternalDependency", "the reference comes from an external namespace");
		return unbound("NotIndexed", "no declaration matches this C# reference");
	}

	/** A name right of a member operator, through what its receiver's type is: `this`, `base` or a type's name. */
	private memberBinding(facts: IndexedFacts, reference: Reference, from: DeclarationMeta | undefined): Binding {
		const receiver = facts.receivers.get(positionKey(reference.range.start)) ?? { kind: "other" };
		if (receiver.kind === "other") return unbound("NotImplemented", "the receiver's type is not inferred");
		if (receiver.kind === "this" || receiver.kind === "base") {
			const owner = this.typeAt(this.enclosingType(facts, from)?.declaration.symbolId);
			if (owner === undefined) return unbound("NotIndexed", `\`${receiver.kind}\` stands in no indexed type`);
			const own = receiver.kind === "this" ? this.ownMembers(owner, reference) : [];
			return own.length > 0 ? candidatesBinding(own) : this.inheritedBinding(this.baseTypes(owner), reference);
		}
		const segments = receiver.kind === "name" ? [{ name: receiver.name, arity: receiver.arity }] : receiver.path;
		const qualifier = receiver.kind === "path" ? receiver.qualifier : undefined;
		// A name that is itself a receiver may be a type the dotted name reaches.
		const arity =
			reference.role === "read" ? facts.receiverNames.get(positionKey(reference.range.start)) : undefined;
		const asType = () =>
			arity === undefined
				? []
				: this.lookupType(facts, from, [...segments, { name: reference.name, arity }], { qualifier });
		const [first] = segments;
		// Right of `::` stands a namespace or type name.
		if (first === undefined) {
			const types = asType();
			return types.length > 0 ? candidatesBinding(types) : this.unresolved(facts, reference.name);
		}
		const head: Reference = { ...reference, name: first.name, range: receiver.range, qualified: false };
		const values = qualifier === undefined ? this.valuesInScope(facts, head, from) : [];
		const types = this.lookupType(facts, from, segments, { qualifier });
		// A value of the name hides a type of it, unless it is of that type; a value's type is not inferred.
		if (values.length > 0 && !(segments.length === 1 && this.ofType(values, types)))
			return unbound("NotImplemented", "the receiver is a value whose type is not inferred");
		if (types.length === 0) {
			const nested = asType();
			return nested.length > 0 ? candidatesBinding(nested) : this.unresolved(facts, first.name);
		}
		if (types.length > 1) return unbound("Ambiguous", "the receiver names more than one type");
		const target = this.typeAt(types[0]?.symbolId);
		if (target === undefined) return unbound("NotIndexed", "the receiver's type is not indexed");
		const own = this.ownMembers(target, reference);
		if (own.length > 0) return candidatesBinding(own);
		const nested = asType();
		return nested.length > 0 ? candidatesBinding(nested) : this.inheritedBinding(this.baseTypes(target), reference);
	}

	/** Values of the name in scope: around the use, in the enclosing type's other parts, or inherited. */
	private valuesInScope(facts: IndexedFacts, reference: Reference, from: DeclarationMeta | undefined): Declaration[] {
		const read: Reference = { ...reference, role: "read" };
		const around = this.sameFileCandidates(facts, read, from);
		if (around.length > 0) return around;
		const owner = this.typeAt(this.enclosingType(facts, from)?.declaration.symbolId);
		if (owner === undefined) return [];
		const own = this.ownMembers(owner, read);
		return own.length > 0 ? own : this.inherited(this.baseTypes(owner), read).found;
	}

	/** `Color Color`: every value is declared of the one type the name means, so the name means both. */
	private ofType(values: readonly Declaration[], types: readonly { symbolId: string }[]): boolean {
		if (types.length !== 1) return false;
		return values.every((value) => {
			const at = this.typeAt(value.symbolId);
			const meta = at?.meta;
			// `T?`, `T[]` and `T<A>` are other types.
			if (at === undefined || meta?.typeSegments === undefined || meta.typeComposed === true) return false;
			const declared = this.lookupType(at.facts, meta, meta.typeSegments, { qualifier: meta.typeQualifier });
			return declared.length === 1 && declared[0]?.symbolId === types[0]?.symbolId;
		});
	}

	private inheritedBinding(bases: BaseTypes, reference: Reference): Binding {
		const { found, external } = this.inherited(bases, reference);
		if (found.length > 0) return candidatesBinding(found);
		return external
			? unbound("ExternalDependency", "the member is inherited from outside the workspace")
			: unbound("NotIndexed", "no declaration in the type or its bases matches this member");
	}

	/** Members `using static` brings: each named type's own, and what it inherits. */
	private staticMembers(facts: IndexedFacts, reference: Reference, from: DeclarationMeta | undefined): Declaration[] {
		// The nearest level whose directives bring any.
		for (const level of this.levels(facts, this.enclosingNamespace(facts, from))) {
			const found: Declaration[] = [];
			for (const types of level.staticTypes)
				for (const symbolId of types) {
					const at = this.typeAt(symbolId);
					if (at === undefined) continue;
					const own = this.ownMembers(at, reference);
					found.push(...(own.length > 0 ? own : this.inherited(this.baseTypes(at), reference).found));
				}
			if (found.length > 0) return this.uniqueDeclarations(found);
		}
		return [];
	}

	/** Locals, parameters and members declared around a use in this file; a nearer local hides the rest. */
	private sameFileCandidates(
		facts: IndexedFacts,
		reference: Reference,
		from: DeclarationMeta | undefined,
	): Declaration[] {
		const candidates: DeclarationMeta[] = [];
		const chain = this.containerChain(facts, from);
		for (const meta of facts.byName.get(reference.name) ?? []) {
			const declaration = meta.declaration;
			if (!this.roleMatches(reference.role, declaration)) continue;
			// A name right of a member operator is never a local's.
			if (reference.qualified === true && declaration.visibility === "local") continue;
			const enclosed = declaration.containerId !== undefined && chain.has(declaration.containerId);
			const inScope = meta.scope === undefined || within(meta.scope, reference.range.start);
			if (enclosed && inScope) candidates.push(meta);
		}
		return this.uniqueDeclarations(this.nearest(candidates, chain).map((meta) => meta.declaration));
	}

	/** A local or parameter hides a member; the one declared nearest the use hides the rest. */
	private nearest(candidates: DeclarationMeta[], chain: ReadonlyMap<string, number>): DeclarationMeta[] {
		const locals = candidates.filter((meta) => meta.declaration.visibility === "local");
		if (locals.length === 0) return candidates;
		const depth = (meta: DeclarationMeta) =>
			chain.get(meta.declaration.containerId ?? "") ?? Number.MAX_SAFE_INTEGER;
		const closest = Math.min(...locals.map(depth));
		const owned = locals.filter((meta) => depth(meta) === closest);
		// Scopes nest, so the innermost starts last; a parameter's spans its whole declaration.
		const starts = (meta: DeclarationMeta) => meta.scope?.start ?? { line: -1, character: -1 };
		const innermost = owned.reduce((best, meta) =>
			comparePositions(starts(meta), starts(best)) > 0 ? meta : best,
		);
		return owned.filter((meta) => comparePositions(starts(meta), starts(innermost)) === 0);
	}

	/** Each container above a use, by how far out it is. */
	private containerChain(facts: IndexedFacts, from: DeclarationMeta | undefined): Map<string, number> {
		const chain = new Map<string, number>();
		let current = from;
		let depth = 0;
		while (current !== undefined && !chain.has(current.declaration.symbolId)) {
			for (const part of this.partsOf(facts, current)) if (!chain.has(part)) chain.set(part, depth);
			depth++;
			current = current.parentId === undefined ? undefined : facts.metadata.get(current.parentId);
		}
		return chain;
	}
}
