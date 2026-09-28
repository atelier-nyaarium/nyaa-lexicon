// Which module or type a written path names, from where it is written.

import type { OffsetRange } from "@nyaa-lexicon/protocol";
import type { ImportBinding, ParsedFile, RawDeclaration, RustDescriptor } from "./model.js";
import { moduleFileOf, type RustProjectResolver } from "./project.js";

////////////////////////////////
//  Interfaces & Types

/** A module or type: a file's root, a declaration, or an impl's target no file here declares. */
export interface Place {
	facts: ParsedFile;
	path: readonly RustDescriptor[];
	kind: "module" | "type";
	raw?: RawDeclaration;
}

/** A declaration and the file that holds it. */
export interface Found {
	facts: ParsedFile;
	raw: RawDeclaration;
}

/** Where a path is written. */
export interface Site {
	containerId: string | undefined;
	offset: number;
}

/** `null` stops the search: the name is ambiguous, generic or outside the workspace. */
export type Lookup = Place | null | undefined;

/** The types a value may have, nearest first: a later tier answers only what no earlier one does. */
export type Tiers = readonly (readonly Place[])[];

/** An impl and the type its target resolves to. */
interface ResolvedImpl {
	facts: ParsedFile;
	impl: RawDeclaration;
	target: Place;
}

////////////////////////////////
//  Constants

const TYPE_KINDS: ReadonlySet<string> = new Set(["struct", "enum", "interface", "class"]);

/** Containers whose items and imports a name inside them sees. */
export const ITEM_SCOPES: ReadonlySet<string> = new Set(["module", "function", "method"]);

/** Imports followed in one resolution, at most. */
const IMPORT_HOPS = 8;

/** Aliases followed to a type, at most. */
const ALIAS_HOPS = 8;

/** Path heads that name a module relative to the current one, never a crate. */
const PATH_KEYWORDS: ReadonlySet<string> = new Set(["crate", "self", "super", "Self"]);

////////////////////////////////
//  Functions & Helpers

export function within(range: OffsetRange, offset: number): boolean {
	return range.start <= offset && offset <= range.end;
}

/** Smaller, or as large and declared later, which is shadowing. */
export function narrower(scope: OffsetRange, than: OffsetRange): boolean {
	const size = scope.end - scope.start;
	const other = than.end - than.start;
	return size < other || (size === other && scope.start > than.start);
}

export function samePath(left: readonly RustDescriptor[], right: readonly RustDescriptor[]): boolean {
	return (
		left.length === right.length &&
		left.every((descriptor, index) => {
			const other = right[index] as RustDescriptor;
			return (
				descriptor.kind === other.kind &&
				descriptor.name === other.name &&
				descriptor.disambiguator === other.disambiguator &&
				descriptor.occurrence === other.occurrence
			);
		})
	);
}

/** The declarations around a use, nearest first. */
export function containersAround(facts: ParsedFile, fromId: string | undefined): RawDeclaration[] {
	const chain: RawDeclaration[] = [];
	const seen = new Set<string>();
	for (let current = fromId; current !== undefined && !seen.has(current); ) {
		seen.add(current);
		const holder = facts.byId.get(current);
		if (holder === undefined) break;
		chain.push(holder);
		current = holder.declaration.containerId;
	}
	return chain;
}

export function placeOf(facts: ParsedFile, raw: RawDeclaration): Place {
	return { facts, path: raw.descriptorPath, kind: raw.declaration.kind === "module" ? "module" : "type", raw };
}

function rootPlace(facts: ParsedFile): Place {
	return { facts, path: [], kind: "module" };
}

function samePlace(left: Place, right: Place): boolean {
	return left.facts.module === right.facts.module && samePath(left.path, right.path);
}

function declaredAt(facts: ParsedFile, path: readonly RustDescriptor[]): RawDeclaration | undefined {
	const last = path.at(-1);
	return last === undefined
		? undefined
		: facts.byName.get(last.name)?.find((candidate) => samePath(candidate.descriptorPath, path));
}

/** The one place `found` agree on; `null` when they disagree. */
function onePlace(found: readonly Place[]): Lookup {
	const first = found[0];
	if (first === undefined) return undefined;
	return found.every((place) => samePlace(place, first)) ? first : null;
}

export function distinct(found: readonly Found[]): Found[] {
	const seen = new Set<string>();
	return found.filter(({ raw }) => {
		if (seen.has(raw.declaration.symbolId)) return false;
		seen.add(raw.declaration.symbolId);
		return true;
	});
}

/** A block-confined name stays in its block; `undefined` is the whole scope. */
export function sameBlock(left: OffsetRange | undefined, right: OffsetRange | undefined): boolean {
	return left?.start === right?.start && left?.end === right?.end;
}

export function tighter(block: OffsetRange | undefined, than: OffsetRange | undefined): boolean {
	return block !== undefined && (than === undefined || narrower(block, than));
}

export function importSite(binding: ImportBinding): Site {
	return { containerId: binding.containerId, offset: binding.block?.start ?? -1 };
}

////////////////////////////////
//  Class

/** Paths resolved the way Rust scopes them: blocks, then the enclosing module, its imports and globs. */
export class ScopeResolver {
	constructor(
		private readonly load: (module: string) => ParsedFile | null,
		private readonly resolver: RustProjectResolver,
		/** The modules holding an impl whose target is written with this name. */
		private readonly implModules: (typeName: string) => readonly string[],
		/** Kept while the facts it reads stay the same. */
		private readonly memo: <R>(key: string, compute: () => R) => R,
	) {}

	/** The module or type a written path names from `site`; after a leading `::`, from the crates. */
	place(
		facts: ParsedFile,
		names: readonly string[],
		site: Site,
		trail: readonly ImportBinding[] = [],
		absolute = false,
	): Lookup {
		const first = names[0];
		if (first === undefined) return undefined;
		let rest = names.slice(1);
		if (absolute) return this.walk(this.externPlace(facts, first), rest, trail);
		if (first === "crate") return this.walk(this.crateRoot(facts), rest, trail);
		if (first === "Self") return this.walk(this.selfType(facts, site), rest, trail);
		if (first !== "self" && first !== "super")
			return this.walk(this.lexical(facts, first, site, trail), rest, trail);
		let module: Place | undefined = this.enclosingModule(facts, site);
		if (first === "super") rest = [...names];
		while (rest[0] === "super" && module !== undefined) {
			module = this.parentModule(module);
			rest = rest.slice(1);
		}
		return this.walk(module, rest, trail);
	}

	/** Declarations of `name` in a module, through its imports and globs, or a type's members. */
	itemsIn(place: Place, name: string, trail: readonly ImportBinding[] = []): Found[] {
		if (place.kind === "type") return this.membersNamed(place.facts, place.path, name);
		const scopeId = place.raw?.declaration.symbolId;
		const found: Found[] = [];
		for (const raw of place.facts.byName.get(name) ?? []) {
			if (raw.declaration.containerId !== scopeId || raw.scope !== undefined || raw.block !== undefined) continue;
			if (raw.declaration.languageKind !== "impl") found.push({ facts: place.facts, raw });
		}
		for (const binding of place.facts.importBindings) {
			if (binding.glob || binding.localName !== name || binding.containerId !== scopeId) continue;
			if (binding.block === undefined) found.push(...(this.importItems(place.facts, binding, trail) ?? []));
		}
		if (found.length > 0) return distinct(found);
		for (const binding of place.facts.importBindings) {
			if (!binding.glob || binding.containerId !== scopeId || binding.block !== undefined) continue;
			const from = this.globPlace(place.facts, binding, trail);
			if (from !== undefined && from !== null) found.push(...this.globItems(from, name, [...trail, binding]));
		}
		if (found.length > 0) return distinct(found);
		const file = this.moduleFile(place);
		return file === undefined ? [] : this.itemsIn(file, name, trail);
	}

	/** A type's members named `name`, through its aliases, from impls anywhere in the workspace. */
	membersOf(place: Place, name: string, from: ParsedFile): Found[] {
		return distinct(this.aliasChain(place).flatMap((type) => this.ownMembers(type, name, from)));
	}

	/**
	 * The types a value written as `names` may have: the one the path names, a generic parameter's
	 * bounding traits, or for `Self` in an impl over a generic, that impl, then those traits.
	 */
	typesOf(facts: ParsedFile, names: readonly string[], site: Site, absolute = false): Tiers {
		const first = names[0];
		if (names.length === 1 && first !== undefined && !absolute) {
			const generic = first === "Self" ? this.genericSelf(facts, site) : this.genericBounds(facts, first, site);
			if (generic !== undefined) return generic.filter((tier) => tier.length > 0);
		}
		const placed = this.place(facts, names, site, [], absolute);
		return placed === undefined || placed === null || placed.kind !== "type" ? [] : [[placed]];
	}

	/** The members named `name` that `admit` takes, of the nearest tier that has any. */
	membersIn(tiers: Tiers, name: string, from: ParsedFile, admit: (raw: RawDeclaration) => boolean): Found[] {
		for (const tier of tiers) {
			const found = distinct(tier.flatMap((type) => this.membersOf(type, name, from))).filter(({ raw }) =>
				admit(raw),
			);
			if (found.length > 0) return found;
		}
		return [];
	}

	/** What a non-glob import names; `null` when its path cannot be followed. */
	importItems(facts: ParsedFile, binding: ImportBinding, trail: readonly ImportBinding[] = []): Found[] | null {
		const leaf = this.importLeaf(facts, binding, trail);
		return leaf === null ? null : this.itemsIn(leaf.parent, leaf.name, leaf.trail);
	}

	/** The module or enum a glob import opens. */
	globPlace(facts: ParsedFile, binding: ImportBinding, trail: readonly ImportBinding[] = []): Lookup {
		if (!this.followable(binding, trail)) return null;
		return this.importPath(facts, binding, binding.path, [...trail, binding]);
	}

	/** The outside crate a module's own import of `name` comes from, when one does. */
	externalImport(place: Place, name: string): string | undefined {
		if (place.kind !== "module") return undefined;
		const scopeId = place.raw?.declaration.symbolId;
		for (const binding of place.facts.importBindings) {
			if (binding.localName !== name || binding.containerId !== scopeId || binding.block !== undefined) continue;
			const crate = this.externalHead(place.facts, binding.path, importSite(binding), binding.absolute === true, [
				binding,
			]);
			if (crate !== undefined) return crate;
		}
		return undefined;
	}

	/**
	 * The outside crate a path's first segment names from `site`, when nothing in scope names it first;
	 * an import asking of its own path passes itself as `trail`.
	 */
	externalHead(
		facts: ParsedFile,
		names: readonly string[],
		site: Site,
		absolute = false,
		trail: readonly ImportBinding[] = [],
	): string | undefined {
		const first = names[0];
		if (first === undefined || (!absolute && PATH_KEYWORDS.has(first))) return undefined;
		if (!absolute && this.scoped(facts, first, site, trail) !== undefined) return undefined;
		return this.resolver.externCrate(facts.module, first)?.kind === "external" ? first : undefined;
	}

	/** What a glob supplies: a module's items or an enum's variants. */
	globItems(from: Place, name: string, trail: readonly ImportBinding[] = []): Found[] {
		return this.itemsIn(from, name, trail).filter(
			({ raw }) => from.kind === "module" || raw.declaration.languageKind === "variant",
		);
	}

	/** The type a value of `place` has: a variant's enum, else the type itself. */
	valueOf(place: Place): Place | undefined {
		if (place.raw?.declaration.languageKind !== "variant") return place;
		const owner = place.facts.byId.get(place.raw.declaration.containerId ?? "");
		return owner === undefined ? undefined : placeOf(place.facts, owner);
	}

	/** An impl's target type, resolved from where the impl sits when this file does not declare it. */
	implTarget(facts: ParsedFile, impl: RawDeclaration): Place {
		const path = impl.memberPath ?? impl.descriptorPath;
		const declared = declaredAt(facts, path);
		if (declared !== undefined) return placeOf(facts, declared);
		const written = impl.valueType;
		const resolved =
			written === undefined || samePath(path, impl.descriptorPath)
				? undefined
				: this.place(facts, written, { containerId: impl.declaration.containerId, offset: impl.startOffset });
		return resolved?.kind === "type" ? resolved : { facts, path, kind: "type" };
	}

	/** A type's members named `name`, and those of each impl, in any file, whose target resolves to it. */
	private ownMembers(place: Place, name: string, from: ParsedFile): Found[] {
		const found = this.membersNamed(place.facts, place.path, name);
		const typeName = place.path.at(-1)?.name;
		if (typeName === undefined) return found;
		const indexed = this.implsNamed(typeName);
		// The file being read may not be indexed yet.
		const own = indexed.some(({ facts }) => facts.module === from.module) ? [] : this.resolvedImpls(from, typeName);
		for (const { facts, impl, target } of [...indexed, ...own])
			if (samePlace(target, place)) found.push(...this.membersNamed(facts, impl.memberPath ?? [], name));
		return found;
	}

	/** Every indexed impl whose target is written with `typeName`, with the type it resolves to. */
	private implsNamed(typeName: string): readonly ResolvedImpl[] {
		return this.memo(`rust-impls:${typeName}`, () =>
			this.implModules(typeName).flatMap((module) => {
				const facts = this.load(module);
				return facts === null ? [] : this.resolvedImpls(facts, typeName);
			}),
		);
	}

	/** A file's impls whose target is written with `typeName`, over a named type rather than a generic. */
	private resolvedImpls(facts: ParsedFile, typeName: string): ResolvedImpl[] {
		return facts.impls
			.filter(
				(impl) =>
					impl.targetName === typeName &&
					impl.memberPath !== undefined &&
					!samePath(impl.memberPath, impl.descriptorPath),
			)
			.map((impl) => ({ facts, impl, target: this.implTarget(facts, impl) }));
	}

	/** A type and the types its aliases name in turn. */
	private aliasChain(place: Place): Place[] {
		const chain = [place];
		for (let current = place; chain.length <= ALIAS_HOPS; ) {
			const alias = current.raw;
			if (alias?.declaration.languageKind !== "typeAlias" || alias.valueType === undefined) break;
			// An alias's own generics are in scope for what it names.
			const own = { containerId: alias.declaration.symbolId, offset: alias.startOffset };
			const next = this.place(current.facts, alias.valueType, own);
			if (next === undefined || next === null || next.kind !== "type") break;
			if (chain.some((seen) => samePlace(seen, next))) break;
			chain.push(next);
			current = next;
		}
		return chain;
	}

	/** The traits bounding a generic parameter `name` names at `site`; undefined when it names none. */
	private genericBounds(facts: ParsedFile, name: string, site: Site): Tiers | undefined {
		const scopes = this.scopesAround(facts, site);
		if (!scopes.some((holder) => holder?.generics?.has(name) === true)) return undefined;
		for (const holder of scopes) {
			const holds = holder === undefined || ITEM_SCOPES.has(holder.declaration.kind);
			const scopeId = holder?.declaration.symbolId;
			if (holds && this.namedIn(facts, name, scopeId, site.offset, []) !== undefined) return undefined;
			if (holder?.generics?.has(name) === true) return [this.boundTraits(facts, holder, name)];
			if (holds && this.globbedIn(facts, name, scopeId, site.offset, []) !== undefined) return undefined;
		}
		return undefined;
	}

	/** `Self` in an impl whose target is its own generic: the impl's items, else that generic's traits. */
	private genericSelf(facts: ParsedFile, site: Site): Tiers | undefined {
		const holder = containersAround(facts, site.containerId).find(
			(candidate) => candidate.memberPath !== undefined || TYPE_KINDS.has(candidate.declaration.kind),
		);
		const target = holder?.valueType?.[0];
		if (holder?.memberPath === undefined || target === undefined) return undefined;
		if (!samePath(holder.memberPath, holder.descriptorPath)) return undefined;
		return [[{ facts, path: holder.memberPath, kind: "type" }], this.boundTraits(facts, holder, target)];
	}

	/** The traits bounding the generic `name` an item declares, each resolved from the item. */
	private boundTraits(facts: ParsedFile, holder: RawDeclaration, name: string): Place[] {
		const own = { containerId: holder.declaration.symbolId, offset: holder.startOffset };
		return (holder.generics?.get(name) ?? []).flatMap((bound) => {
			const trait = this.place(facts, bound, own);
			return trait === undefined || trait === null || trait.kind !== "type" ? [] : [trait];
		});
	}

	/** An import this resolution has not yet followed. */
	private followable(binding: ImportBinding, trail: readonly ImportBinding[]): boolean {
		return !trail.includes(binding) && trail.length < IMPORT_HOPS;
	}

	/** An import path from the import's scope, only through the module tree `mod` declarations build. */
	private importPath(
		facts: ParsedFile,
		binding: ImportBinding,
		names: readonly string[],
		trail: readonly ImportBinding[],
	): Lookup {
		return this.place(facts, names, importSite(binding), trail, binding.absolute === true);
	}

	private walk(place: Lookup, names: readonly string[], trail: readonly ImportBinding[]): Lookup {
		let current = place;
		for (const name of names) {
			if (current === undefined || current === null) return current;
			current = this.child(current, name, trail);
		}
		return current;
	}

	/** A module's child module or type, or an enum's variant. */
	private child(place: Place, name: string, trail: readonly ImportBinding[]): Lookup {
		const found = this.itemsIn(place, name, trail).filter(({ raw }) =>
			place.kind === "module"
				? TYPE_KINDS.has(raw.declaration.kind) || raw.declaration.kind === "module"
				: raw.declaration.languageKind === "variant",
		);
		const places = found.map(({ facts, raw }) => placeOf(facts, raw));
		let outside = false;
		if (place.kind === "module") {
			const scopeId = place.raw?.declaration.symbolId;
			for (const binding of place.facts.importBindings) {
				if (binding.localName !== name || binding.containerId !== scopeId || binding.block !== undefined)
					continue;
				const crate = this.importedCrate(place.facts, binding);
				if (crate === null) outside = true;
				else if (crate !== undefined) places.push(crate);
			}
		}
		return places.length === 0 && outside ? null : onePlace(places);
	}

	/** The crate root a one-segment `use` or `extern crate` names; `null` outside the workspace. */
	private importedCrate(facts: ParsedFile, binding: ImportBinding): Lookup {
		const name = binding.path[0];
		if (binding.glob || binding.path.length !== 1 || name === undefined) return undefined;
		return this.externPlace(facts, name);
	}

	/** A crate in the extern prelude of `facts`'s crate: a workspace library's root, or `null` outside it. */
	private externPlace(facts: ParsedFile, name: string): Lookup {
		const crate = this.resolver.externCrate(facts.module, name);
		if (crate === undefined) return undefined;
		return crate.kind === "external" ? null : this.rootOf(crate.root);
	}

	/** A name's first segment: what the scopes around name it, else a crate the extern prelude does. */
	private lexical(facts: ParsedFile, name: string, site: Site, trail: readonly ImportBinding[]): Lookup {
		const scoped = this.scoped(facts, name, site, trail);
		return scoped === undefined ? this.externPlace(facts, name) : scoped;
	}

	/** Scope by scope outward to the enclosing module: declarations and imports, generics, then globs. */
	private scoped(facts: ParsedFile, name: string, site: Site, trail: readonly ImportBinding[]): Lookup {
		for (const holder of this.scopesAround(facts, site)) {
			const holds = holder === undefined || ITEM_SCOPES.has(holder.declaration.kind);
			const scopeId = holder?.declaration.symbolId;
			const named = holds ? this.namedIn(facts, name, scopeId, site.offset, trail) : undefined;
			if (named !== undefined) return named;
			if (holder?.generics?.has(name) === true) return null;
			const globbed = holds ? this.globbedIn(facts, name, scopeId, site.offset, trail) : undefined;
			if (globbed !== undefined) return globbed;
		}
		return undefined;
	}

	/** The containers a site sees items through, out to its module; the file's root when none is one. */
	private scopesAround(facts: ParsedFile, site: Site): Array<RawDeclaration | undefined> {
		const scopes: Array<RawDeclaration | undefined> = [];
		for (const holder of containersAround(facts, site.containerId)) {
			scopes.push(holder);
			if (holder.declaration.kind === "module") return scopes;
		}
		scopes.push(undefined);
		return scopes;
	}

	/** A scope's own modules, types and imports of `name`; the narrowest block wins. */
	private namedIn(
		facts: ParsedFile,
		name: string,
		scopeId: string | undefined,
		offset: number,
		trail: readonly ImportBinding[],
	): Lookup {
		const candidates: Array<{ block: OffsetRange | undefined; lookup: () => Lookup }> = [];
		for (const raw of facts.byName.get(name) ?? []) {
			if (raw.declaration.containerId !== scopeId || raw.scope !== undefined) continue;
			if (!TYPE_KINDS.has(raw.declaration.kind) && raw.declaration.kind !== "module") continue;
			if (raw.block !== undefined && !within(raw.block, offset)) continue;
			candidates.push({ block: raw.block, lookup: () => placeOf(facts, raw) });
		}
		for (const binding of facts.importBindings) {
			if (binding.glob || binding.localName !== name || binding.containerId !== scopeId) continue;
			if (trail.includes(binding) || (binding.block !== undefined && !within(binding.block, offset))) continue;
			candidates.push({ block: binding.block, lookup: () => this.importPlace(facts, binding, trail) });
		}
		let best: { block: OffsetRange | undefined; found: Lookup[] } | undefined;
		for (const candidate of candidates) {
			const lookup = candidate.lookup();
			if (lookup === undefined) continue;
			if (best === undefined || tighter(candidate.block, best.block))
				best = { block: candidate.block, found: [lookup] };
			else if (sameBlock(candidate.block, best.block)) best.found.push(lookup);
		}
		if (best === undefined) return undefined;
		const placed = best.found.filter((lookup): lookup is Place => lookup !== null);
		return placed.length < best.found.length ? null : onePlace(placed);
	}

	/** What a scope's globs supply of `name`. */
	private globbedIn(
		facts: ParsedFile,
		name: string,
		scopeId: string | undefined,
		offset: number,
		trail: readonly ImportBinding[],
	): Lookup {
		const found: Place[] = [];
		for (const binding of facts.importBindings) {
			if (!binding.glob || binding.containerId !== scopeId) continue;
			if (binding.block !== undefined && !within(binding.block, offset)) continue;
			const from = this.globPlace(facts, binding, trail);
			if (from === undefined || from === null) continue;
			const child = this.child(from, name, [...trail, binding]);
			if (child === null) return null;
			if (child !== undefined) found.push(child);
		}
		return onePlace(found);
	}

	/** The module or type an import names; `null` when its path cannot be followed. */
	private importPlace(facts: ParsedFile, binding: ImportBinding, trail: readonly ImportBinding[]): Lookup {
		const crate = this.importedCrate(facts, binding);
		if (crate !== undefined) return crate;
		const leaf = this.importLeaf(facts, binding, trail);
		return leaf === null ? null : this.child(leaf.parent, leaf.name, leaf.trail);
	}

	/** Where a non-glob import's last segment is looked up; `null` when its path cannot be followed. */
	private importLeaf(
		facts: ParsedFile,
		binding: ImportBinding,
		trail: readonly ImportBinding[],
	): { parent: Place; name: string; trail: readonly ImportBinding[] } | null {
		if (!this.followable(binding, trail)) return null;
		const segments = binding.path.slice(0, -1);
		const name = binding.sourceName ?? binding.path.at(-1);
		if (segments.length === 0 || name === undefined) return null;
		const next = [...trail, binding];
		const parent = this.importPath(facts, binding, segments, next);
		return parent === undefined || parent === null ? null : { parent, name, trail: next };
	}

	private membersNamed(facts: ParsedFile, path: readonly RustDescriptor[], name: string): Found[] {
		return (facts.byName.get(name) ?? [])
			.filter((raw) => raw.declaration.languageKind !== "impl" && samePath(raw.containerPath, path))
			.map((raw) => ({ facts, raw }));
	}

	/** The type `Self` names: the nearest impl's target, or the trait or type around the site. */
	private selfType(facts: ParsedFile, site: Site): Lookup {
		const holder = containersAround(facts, site.containerId).find(
			(candidate) => candidate.memberPath !== undefined || TYPE_KINDS.has(candidate.declaration.kind),
		);
		if (holder === undefined) return undefined;
		return holder.memberPath === undefined ? placeOf(facts, holder) : this.implTarget(facts, holder);
	}

	private enclosingModule(facts: ParsedFile, site: Site): Place {
		const module = containersAround(facts, site.containerId).find((holder) => holder.declaration.kind === "module");
		return module === undefined ? rootPlace(facts) : placeOf(facts, module);
	}

	/** An inline module's container module, or the module that declares a file's `mod`. */
	private parentModule(place: Place): Place | undefined {
		const raw = place.raw;
		if (raw !== undefined)
			return this.enclosingModule(place.facts, {
				containerId: raw.declaration.containerId,
				offset: raw.startOffset,
			});
		const declarers = this.resolver.declarers(place.facts.module);
		const only = declarers.length === 1 ? declarers[0] : undefined;
		const facts = only === undefined ? null : this.load(only.module);
		const declaration = facts?.byId.get(only?.declaration ?? "");
		if (facts === null || facts === undefined || declaration === undefined) return undefined;
		return this.enclosingModule(facts, {
			containerId: declaration.declaration.containerId,
			offset: declaration.startOffset,
		});
	}

	private crateRoot(facts: ParsedFile): Place | undefined {
		const root = this.resolver.crateRootOf(facts.module);
		return root === null ? undefined : this.rootOf(root);
	}

	/** The file a `mod name;` declaration loads. */
	private moduleFile(place: Place): Place | undefined {
		const file = this.loadedFile(place);
		return file === undefined ? undefined : this.rootOf(file);
	}

	/** The module file a place stands for: a file's root, or the file a `mod name;` loads. */
	moduleFileName(place: Place): string | undefined {
		return place.raw === undefined ? place.facts.module : this.loadedFile(place);
	}

	private loadedFile(place: Place): string | undefined {
		const raw = place.raw;
		if (raw?.fileModule === undefined) return undefined;
		const inline: string[] = [];
		for (const descriptor of place.path.slice(0, -1)) {
			if (descriptor.kind !== "namespace") return undefined;
			inline.push(descriptor.name);
		}
		const module = place.facts.module;
		const modRs = this.resolver.isModRs(module);
		const name = raw.declaration.name;
		return moduleFileOf(module, modRs, inline, name, raw.fileModule.path, this.resolver.files) ?? undefined;
	}

	private rootOf(module: string): Place | undefined {
		const facts = this.load(module);
		return facts === null ? undefined : rootPlace(facts);
	}
}
