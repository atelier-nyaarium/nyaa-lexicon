import {
	type Binding,
	type Declaration,
	type OffsetRange,
	parseSymbolId,
	positionInRange,
	type Range,
	type Reference,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { ImportBinding, ParsedFile, RawDeclaration, RawReference } from "../model.js";
import {
	containersAround,
	type Found,
	ITEM_SCOPES,
	importSite,
	type Lookup,
	type Place,
	placeOf,
	sameBlock,
	type Tiers,
	tighter,
	within,
} from "../scopes.js";
import { isRustTypeKind } from "../vocabulary.js";
import { RustQueryService } from "./context.js";

function contains(range: Range, position: Range["start"]): boolean {
	// Inclusive at both ends.
	return positionInRange(range, position);
}

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function bound(symbolId: string): Binding {
	return { status: "bound", symbolId, provenance: "bound" };
}

function ambiguity(candidates: string[], detail: string): Binding {
	const unique = [...new Set(candidates)];
	if (unique.length >= 2) return { status: "ambiguous", candidates: unique, provenance: "nameMatched" };
	return unbound("Ambiguous", detail);
}

function declarationKindMatches(role: Reference["role"], declaration: Declaration): boolean {
	// A tuple variant constructs like a function.
	const variant = declaration.languageKind === "variant";
	if (role === "call") return declaration.kind === "function" || declaration.kind === "method" || variant;
	if (role === "instantiate") return declaration.kind === "struct" || declaration.kind === "enum" || variant;
	if (role === "typeUse" || role === "implements") return isRustTypeKind(declaration.kind);
	if (role === "write") return declaration.kind !== "constant" || declaration.languageKind === "static";
	return true;
}

/** Roles a local's name can take. */
const VALUE_ROLES: ReadonlySet<Reference["role"]> = new Set(["read", "write", "call"]);

/** `.name` reads a field and calls a method, a segment another follows names a module or type, and nothing else reaches a field. */
function kindAdmits(raw: RawReference, declaration: Declaration): boolean {
	if (raw.qualifier === true) return declaration.kind === "module" || isRustTypeKind(declaration.kind);
	if (!declarationKindMatches(raw.reference.role, declaration)) return false;
	if (raw.member === true && raw.reference.role !== "call") return declaration.kind === "field";
	return declaration.kind !== "field";
}

/** A scope's own declarations and imports of a name. */
interface NamingScope {
	/** How far out: the index of its container around the use. */
	rank: number;
	block: OffsetRange | undefined;
	items: RawDeclaration[];
	imports: ImportBinding[];
}

/** Several imports' answers as one: two of one declaration supply one name. */
function combined(results: readonly Binding[]): Binding {
	const ambiguous = results.find((result) => result.status === "ambiguous");
	if (ambiguous !== undefined) return ambiguous;
	const targets = [...new Set(results.flatMap((result) => (result.status === "bound" ? [result.symbolId] : [])))];
	if (targets.length > 1) return ambiguity(targets, "multiple imports supply this name");
	if (targets.length === 1) return bound(targets[0] as string);
	return results[0] ?? unbound("NotIndexed", "the import target is not indexed");
}

/** Bound to the one declaration found, else ambiguous or unbound. */
function oneOf(found: readonly Found[], none: string, many: string): Binding {
	const first = found[0];
	if (first === undefined) return unbound("NotIndexed", none);
	if (found.length === 1) return bound(first.raw.declaration.symbolId);
	return ambiguity(
		found.map(({ raw }) => raw.declaration.symbolId),
		many,
	);
}

function typePlace(lookup: Lookup): Place | undefined {
	return lookup?.kind === "type" ? lookup : undefined;
}

/** A generic parameter of an item around the use. */
function genericNamed(facts: ParsedFile, raw: RawReference): boolean {
	return containersAround(facts, raw.containerId).some((holder) => holder.generics?.has(raw.reference.name) === true);
}

/**
 * The local a name at `offset` refers to: the narrowest in scope of the nearest function, and with
 * `parameters`, that function's parameter of the name when no local shadows it.
 */
function localNamed(
	facts: ParsedFile,
	name: string,
	offset: number,
	chain: readonly RawDeclaration[],
	parameters: boolean,
): RawDeclaration | undefined {
	const owner = chain.find((holder) => holder.declaration.kind === "function" || holder.declaration.kind === "method")
		?.declaration.symbolId;
	// Scopes nest or part, so of those holding the offset the latest to start is the narrowest.
	const scoped = facts.locals.get(name) ?? [];
	let low = 0;
	let high = scoped.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (((scoped[middle] as RawDeclaration).scope?.start ?? 0) <= offset) low = middle + 1;
		else high = middle;
	}
	for (let at = low - 1; at >= 0; at--) {
		const candidate = scoped[at] as RawDeclaration;
		if (candidate.scope === undefined || !within(candidate.scope, offset)) continue;
		const holder = facts.byId.get(candidate.declaration.containerId ?? "")?.declaration;
		const running = holder?.kind === "function" || holder?.kind === "method";
		if (!running || owner === holder?.symbolId) return candidate;
	}
	if (!parameters) return undefined;
	return facts.byName
		.get(name)
		?.find(
			(candidate) => candidate.declaration.visibility === "local" && candidate.declaration.containerId === owner,
		);
}

/** How far out a use reaches a container; -1 when it cannot. */
function reach(chain: readonly RawDeclaration[], containerId: string | undefined): number {
	if (containerId === undefined) return chain.length;
	return chain.findIndex((holder) => holder.declaration.symbolId === containerId);
}

export class RustBindingQueryService extends RustQueryService {
	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unbound("NotIndexed", "module is not indexed");
		const raw = facts.rawReferences.find(
			(candidate) =>
				candidate.reference.name === params.name && contains(candidate.reference.range, params.range.start),
		);
		if (raw !== undefined) return this.bindingFor(facts, raw);
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.rawDeclarations.find(
			(candidate) =>
				candidate.declaration.name === params.name &&
				contains(candidate.declaration.selectionRange ?? candidate.declaration.range, params.range.start),
		);
		return declaration === undefined
			? unbound("NotIndexed", "no indexed symbol matched the requested range")
			: bound(declaration.declaration.symbolId);
	}

	referenceBinding(facts: ParsedFile, raw: RawReference): Binding {
		return this.bindingFor(facts, raw);
	}

	private bindingFor(facts: ParsedFile, raw: RawReference): Binding {
		if (
			raw.reference.binding.status === "bound" ||
			(raw.reference.binding.status === "unbound" &&
				["RuntimeConstructed", "ExternalDependency"].includes(raw.reference.binding.reason))
		)
			return raw.reference.binding;
		if (raw.importBinding !== undefined) return this.importedBinding(facts, raw, raw.importBinding);
		if (raw.member === true && raw.path.length === 0) return this.receivedBinding(facts, raw);
		if (raw.path.length > 0) return this.qualifiedBinding(facts, raw);
		// A crate's name after a leading `::`, or a name after a qualifier no path spells.
		if (raw.reference.qualified === true) return this.crateBinding(facts, raw);
		if (genericNamed(facts, raw)) return unbound("NotIndexed", "a generic parameter names no indexed declaration");
		return this.scopedBinding(facts, raw);
	}

	/**
	 * A bare name, scope by scope outward: a local, then each scope's items, its imports, and the globs
	 * that supply it.
	 */
	private scopedBinding(facts: ParsedFile, raw: RawReference): Binding {
		const chain = containersAround(facts, raw.containerId);
		if (VALUE_ROLES.has(raw.reference.role) && raw.qualifier !== true) {
			const local = localNamed(facts, raw.reference.name, raw.token.startOffset, chain, false);
			if (local !== undefined) return bound(local.declaration.symbolId);
		}
		let unsupplied: Binding | undefined;
		for (const scope of this.scopesNaming(facts, raw, chain, raw.reference.name)) {
			const first = scope.items[0];
			if (first !== undefined)
				return scope.items.length === 1
					? bound(first.declaration.symbolId)
					: ambiguity(
							scope.items.map((candidate) => candidate.declaration.symbolId),
							"multiple declarations match this name in scope",
						);
			const direct = scope.imports.filter((binding) => !binding.glob);
			if (direct.length > 0)
				return combined(direct.map((imported) => this.importedBinding(facts, raw, imported)));
			const globbed = scope.imports.map((imported) => this.importedBinding(facts, raw, imported));
			const supplied = globbed.filter((result) => result.status !== "unbound");
			if (supplied.length > 0) return combined(supplied);
			unsupplied ??= globbed[0];
		}
		if (unsupplied !== undefined) return unsupplied;
		return raw.qualifier === true
			? this.crateBinding(facts, raw)
			: unbound("NotIndexed", "no indexed declaration matches this name");
	}

	/** A name a crate's extern prelude may hold: its root declares nothing, or it is outside the workspace. */
	private crateBinding(facts: ParsedFile, raw: RawReference): Binding {
		const crate =
			raw.absolute === true || raw.qualifier === true
				? this.resolver.externCrate(facts.module, raw.reference.name)
				: undefined;
		if (crate?.kind === "external")
			return unbound("ExternalDependency", `crate ${raw.reference.name} is outside the workspace`);
		if (crate?.kind === "workspace") return unbound("NotIndexed", "a workspace crate's root declares no symbol");
		return unbound("NotIndexed", "the path's qualifier names no indexed module or type");
	}

	/** `path::name` binds only through what its path names. */
	private qualifiedBinding(facts: ParsedFile, raw: RawReference): Binding {
		const site = { containerId: raw.containerId, offset: raw.token.startOffset };
		const name = raw.reference.name;
		const admit = (candidate: RawDeclaration) =>
			candidate.declaration.symbolId !== raw.reference.fromId && kindAdmits(raw, candidate.declaration);
		const absolute = raw.absolute === true;
		const tiers = this.scopes.typesOf(facts, raw.path, site, absolute);
		let found: Found[];
		if (tiers.length > 0) found = this.scopes.membersIn(tiers, name, facts, admit);
		else {
			const place = this.scopes.place(facts, raw.path, site, [], absolute);
			if (place === undefined || place === null || place.kind !== "module") return this.unplaced(facts, raw);
			found = this.scopes.itemsIn(place, name).filter(({ raw: candidate }) => admit(candidate));
			const external = found.length === 0 ? this.scopes.externalImport(place, name) : undefined;
			if (external !== undefined)
				return unbound("ExternalDependency", `crate ${external} is outside the workspace`);
		}
		return oneOf(
			found,
			"the path's module or type has no declaration of this name",
			"multiple qualified declarations match this name",
		);
	}

	/** Why a path names nothing indexed: an outside crate, written or imported, or not. */
	private unplaced(facts: ParsedFile, raw: RawReference): Binding {
		const site = { containerId: raw.containerId, offset: raw.token.startOffset };
		let external = this.scopes.externalHead(facts, raw.path, site, raw.absolute === true);
		const chain = containersAround(facts, raw.containerId);
		for (const scope of raw.absolute === true ? [] : this.scopesNaming(facts, raw, chain, raw.path[0] ?? ""))
			for (const imported of scope.imports)
				if (!imported.glob)
					external ??= this.scopes.externalHead(
						facts,
						imported.path,
						importSite(imported),
						imported.absolute === true,
						[imported],
					);
		return external === undefined
			? unbound("NotIndexed", "the path names no indexed module or type")
			: unbound("ExternalDependency", `crate ${external} is outside the workspace`);
	}

	/** `.name` binds only through its receiver's types; members several of them declare are ambiguous. */
	private receivedBinding(facts: ParsedFile, raw: RawReference): Binding {
		const tiers = this.receiverTypes(facts, raw);
		if (tiers.length === 0) return this.untyped(facts, raw);
		return oneOf(
			this.scopes.membersIn(tiers, raw.reference.name, facts, (candidate) =>
				kindAdmits(raw, candidate.declaration),
			),
			"the receiver's type has no member of this name",
			"the receiver's type has more than one member of this name",
		);
	}

	/** The types of `self`, or of a parameter or local whose annotation or constructor names one. */
	private receiverTypes(facts: ParsedFile, raw: RawReference): Tiers {
		const receiver = raw.receiver;
		if (receiver === undefined) return [];
		if (receiver.raw === "self")
			return this.scopes.typesOf(facts, ["Self"], {
				containerId: raw.containerId,
				offset: raw.token.startOffset,
			});
		const local = this.receiverLocal(facts, raw);
		if (local === undefined) return [];
		const site = { containerId: local.declaration.containerId, offset: local.startOffset };
		if (local.valueType !== undefined)
			return this.scopes
				.typesOf(facts, local.valueType, site)
				.map((tier) => tier.flatMap((type) => this.scopes.valueOf(type) ?? []));
		const returned = local.initializer === undefined ? undefined : this.returnedType(facts, local.initializer);
		return returned === undefined ? [] : [[returned]];
	}

	private receiverLocal(facts: ParsedFile, raw: RawReference): RawDeclaration | undefined {
		const receiver = raw.receiver;
		if (receiver === undefined) return undefined;
		const chain = containersAround(facts, raw.containerId);
		return localNamed(facts, receiver.value, receiver.startOffset, chain, true);
	}

	/** Why a receiver's type is not established: an annotation naming an outside crate's type, or none. */
	private untyped(facts: ParsedFile, raw: RawReference): Binding {
		const written = this.receiverLocal(facts, raw)?.valueType;
		if (written !== undefined && written.length > 0) {
			const reason = this.unplaced(facts, { ...raw, path: [...written] });
			if (reason.status === "unbound" && reason.reason === "ExternalDependency") return reason;
		}
		return unbound("NotIndexed", "the receiver's type is not established");
	}

	/**
	 * The type a call at `offset` builds, through what its callee binds to: a function's declared
	 * return, a tuple struct, or a variant's enum.
	 */
	private returnedType(facts: ParsedFile, offset: number): Place | undefined {
		const callee = facts.referenceAt.get(offset);
		const binding = callee === undefined ? undefined : this.bindingFor(facts, callee);
		if (binding?.status !== "bound") return undefined;
		const module = parseSymbolId(binding.symbolId)?.module;
		const holder = module === undefined ? null : this.factsForModule(module);
		const target = holder?.byId.get(binding.symbolId);
		if (holder === null || holder === undefined || target === undefined) return undefined;
		const kind = target.declaration.kind;
		if (target.declaration.languageKind === "variant" || kind === "struct")
			return this.scopes.valueOf(placeOf(holder, target));
		if ((kind !== "function" && kind !== "method") || target.valueType === undefined) return undefined;
		// The function's own generics are in scope for its return type.
		const own = { containerId: target.declaration.symbolId, offset: target.startOffset };
		return typePlace(this.scopes.place(holder, target.valueType, own));
	}

	/**
	 * The scopes around a use that declare or import `name`, nearest first: by container, then by
	 * narrowest block. An item never sees an outer function's locals.
	 */
	private scopesNaming(
		facts: ParsedFile,
		raw: RawReference,
		chain: readonly RawDeclaration[],
		name: string,
	): NamingScope[] {
		const scopes: NamingScope[] = [];
		const scopeAt = (rank: number, block: OffsetRange | undefined) => {
			let scope = scopes.find((candidate) => candidate.rank === rank && sameBlock(candidate.block, block));
			if (scope === undefined) {
				scope = { rank, block, items: [], imports: [] };
				scopes.push(scope);
			}
			return scope;
		};
		const owner = chain.findIndex(
			(holder) => holder.declaration.kind === "function" || holder.declaration.kind === "method",
		);
		const offset = raw.token.startOffset;
		for (const candidate of facts.byName.get(name) ?? []) {
			const declaration = candidate.declaration;
			if (declaration.symbolId === raw.reference.fromId || candidate.scope !== undefined) continue;
			if (!kindAdmits(raw, declaration)) continue;
			if (candidate.block !== undefined && !within(candidate.block, offset)) continue;
			// An associated item, field or variant takes a path or a receiver.
			const holder = facts.byId.get(declaration.containerId ?? "")?.declaration.kind;
			if (holder !== undefined && !ITEM_SCOPES.has(holder)) continue;
			const rank =
				declaration.visibility === "local"
					? owner >= 0 && chain[owner]?.declaration.symbolId === declaration.containerId
						? owner
						: -1
					: reach(chain, declaration.containerId);
			if (rank >= 0) scopeAt(rank, candidate.block).items.push(candidate);
		}
		for (const binding of facts.importBindings) {
			if (!binding.glob && binding.localName !== name) continue;
			if (binding.block !== undefined && !within(binding.block, offset)) continue;
			const rank = reach(chain, binding.containerId);
			if (rank >= 0) scopeAt(rank, binding.block).imports.push(binding);
		}
		return scopes.sort(
			(left, right) =>
				left.rank - right.rank ||
				(tighter(left.block, right.block) ? -1 : tighter(right.block, left.block) ? 1 : 0),
		);
	}

	/** A name through one import: what its path names, or what its glob supplies. */
	private importedBinding(facts: ParsedFile, raw: RawReference, imported: ImportBinding): Binding {
		const admitted = (found: Found[]) =>
			raw.qualifier === true
				? found.filter(({ raw: candidate }) => kindAdmits(raw, candidate.declaration))
				: found;
		if (!imported.glob) {
			const found = this.scopes.importItems(facts, imported);
			return found === null
				? this.unfollowed(facts, imported)
				: oneOf(
						admitted(found),
						"the imported declaration is not indexed",
						"multiple imported declarations match this name",
					);
		}
		const from = this.scopes.globPlace(facts, imported);
		if (from === undefined) return unbound("NotIndexed", "the glob import names nothing indexed");
		if (from === null) return this.unfollowed(facts, imported);
		return oneOf(
			admitted(this.scopes.globItems(from, raw.reference.name)),
			"no indexed declaration of this name comes through the glob import",
			"a glob import supplies more than one declaration of this name",
		);
	}

	/** Why an import's path leads nowhere indexed. */
	private unfollowed(facts: ParsedFile, imported: ImportBinding): Binding {
		const crate = this.scopes.externalHead(facts, imported.path, importSite(imported), imported.absolute === true, [
			imported,
		]);
		return crate === undefined
			? unbound("NotIndexed", "the imported module is not indexed")
			: unbound("ExternalDependency", `crate ${crate} is outside the workspace`);
	}
}

export { contains };
