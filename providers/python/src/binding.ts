// Where a name used in one module binds when it crosses an import: through each module's
// module-level bindings, re-exports and star imports, and only as far as each step is proved.

import {
	type Binding,
	type Declaration,
	type ImportResolution,
	type Reference,
	type ReferenceOrigin,
	sameRange,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { Range, RawDescriptor, RawImportBinding } from "./facts/types";
import { idFor, type MappedFacts, type Receiver, starSelects } from "./mapped";

////////////////////////////////
//  Interfaces & Types

export interface Resolution {
	binding: Binding;
	origin?: ReferenceOrigin;
}

/** What a module binds a name to at module level, once it has run. */
type Exposure =
	| { kind: "declaration"; declaration: Declaration }
	| { kind: "module" }
	| { kind: "absent" }
	| { kind: "unknown"; reason: UnknownReason; detail: string };

interface Indexed {
	byId: Map<string, Declaration>;
	imported: Map<string, Set<string>>;
}

export interface BinderReads {
	/** Null when the provider holds nothing for the module. */
	load(module: string): Promise<MappedFacts | null>;
	resolve(fromModule: string, specifier: string): Promise<ImportResolution>;
}

////////////////////////////////
//  Constants

/** Kinds a typeUse reference may bind to. */
const TYPE_USE_KINDS = new Set<Declaration["kind"]>(["class", "variable", "function", "interface", "typeParameter"]);

const ABSENT: Exposure = { kind: "absent" };

////////////////////////////////
//  Functions & Helpers

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function unknown(reason: UnknownReason, detail: string): Exposure {
	return { kind: "unknown", reason, detail };
}

function samePath(left: RawDescriptor[], right: RawDescriptor[]): boolean {
	return (
		left.length === right.length &&
		left.every((descriptor, index) => {
			const other = right[index];
			return other?.kind === descriptor.kind && other.name === descriptor.name;
		})
	);
}

function isPathPrefix(prefix: RawDescriptor[], pathValue: RawDescriptor[]): boolean {
	return prefix.length <= pathValue.length && samePath(prefix, pathValue.slice(0, prefix.length));
}

function fits(role: Reference["role"], declaration: Declaration): boolean {
	return role !== "typeUse" || TYPE_USE_KINDS.has(declaration.kind);
}

/** `pkg.mod` for `pkg`, `.mod` for `.`. */
export function submoduleSpecifier(specifier: string, name: string): string {
	return specifier.endsWith(".") ? `${specifier}${name}` : `${specifier}.${name}`;
}

function isPackage(module: string): boolean {
	const file = module.split("/").at(-1);
	return file === "__init__.py" || file === "__init__.pyi";
}

/** Whether a module writes `name` globally: at module level, or through `global`. */
function writes(facts: MappedFacts, name: string): boolean {
	return facts.scopeInfos.some((info) =>
		info.scopePath.length === 0 ? info.locals.includes(name) : info.globals.includes(name),
	);
}

/** Whether a module writes `name` globally other than through its module-level import at `span`. */
function writesBesides(facts: MappedFacts, name: string, span: Range): boolean {
	return (
		facts.scopeInfos.some((info) => info.dynamic || info.globals.includes(name)) ||
		facts.declarations.some((declaration) => declaration.name === name && declaration.containerId === undefined) ||
		facts.importBindings.some(
			(binding) =>
				binding.scopePath.length === 0 &&
				!binding.star &&
				binding.localName === name &&
				!sameRange(binding.span, span),
		) ||
		facts.references.some(
			(reference) =>
				reference.name === name &&
				reference.role === "write" &&
				(facts.referenceScopes.get(reference) ?? []).length === 0,
		)
	);
}

function moduleStars(facts: MappedFacts): RawImportBinding[] {
	return facts.importBindings.filter((binding) => binding.scopePath.length === 0 && binding.star);
}

////////////////////////////////
//  Classes

/** One parse's cross-module answers, memoized for its lifetime. */
export class Binder {
	private readonly exposures = new Map<string, Promise<Exposure>>();
	private readonly landings = new Map<string, Promise<ImportResolution>>();
	private readonly indexes = new WeakMap<MappedFacts, Indexed>();

	constructor(private readonly reads: BinderReads) {}

	private landing(module: string, specifier: string): Promise<ImportResolution> {
		const key = JSON.stringify([module, specifier]);
		const held = this.landings.get(key);
		if (held !== undefined) return held;
		const found = this.reads.resolve(module, specifier);
		this.landings.set(key, found);
		return found;
	}

	/** The reference's binding, and the binding it resolves through when that is proved. */
	async resolve(module: string, facts: MappedFacts, reference: Reference): Promise<Resolution> {
		const binding = reference.binding;
		if (binding.status === "bound") {
			const origin = this.declarationOrigin(module, facts, reference, binding.symbolId);
			return origin === undefined ? { binding } : { binding, origin };
		}
		const receiver = facts.receivers.get(reference);
		if (reference.qualified === true) {
			if (receiver === undefined) return { binding };
			return (await this.member(module, facts, reference, receiver)) ?? { binding };
		}
		if (
			facts.nestedLocals.has(reference) ||
			binding.status !== "unbound" ||
			binding.reason === "Ambiguous" ||
			binding.reason === "RuntimeConstructed"
		) {
			return { binding };
		}
		return (await this.imported(module, facts, reference)) ?? { binding };
	}

	/** A same-file binding is proved only when no import of the name competes in its scope. */
	private declarationOrigin(
		module: string,
		facts: MappedFacts,
		reference: Reference,
		symbolId: string,
	): ReferenceOrigin | undefined {
		const { byId, imported } = this.indexed(module, facts);
		const declaration = byId.get(symbolId);
		if (declaration === undefined) return undefined;
		const scope = imported.get(declaration.containerId ?? "");
		return scope?.has(reference.name) === true || scope?.has("*") === true ? undefined : { kind: "declaration" };
	}

	/** Declarations by id, and the names each scope imports, keyed by the scope's id. */
	private indexed(module: string, facts: MappedFacts): Indexed {
		const held = this.indexes.get(facts);
		if (held !== undefined) return held;
		const imported = new Map<string, Set<string>>();
		for (const binding of facts.importBindings) {
			const scope = binding.scopePath.length === 0 ? "" : idFor(module, binding.scopePath);
			imported.set(scope, (imported.get(scope) ?? new Set()).add(binding.star ? "*" : binding.localName));
		}
		const index = {
			byId: new Map(facts.declarations.map((declaration) => [declaration.symbolId, declaration])),
			imported,
		};
		this.indexes.set(facts, index);
		return index;
	}

	/** Imports of `name` visible where the reference is written, and the stars that could supply it. */
	private visibleImports(
		facts: MappedFacts,
		reference: Reference,
		name: string,
	): { direct: RawImportBinding[]; stars: RawImportBinding[] } {
		const referencePath = facts.referenceScopes.get(reference) ?? [];
		const visible = facts.importBindings.filter((binding) => this.visible(facts, binding, name, referencePath));
		return {
			direct: visible.filter((binding) => !binding.star && binding.localName === name),
			stars: visible.filter((binding) => binding.star),
		};
	}

	/** An unqualified use through exactly one import, or through the one star that brings it. */
	private async imported(module: string, facts: MappedFacts, reference: Reference): Promise<Resolution | null> {
		const { direct, stars } = this.visibleImports(facts, reference, reference.name);
		if (direct.some((binding) => binding.conditional)) {
			return { binding: unbound("Ambiguous", "a conditional import can supply this name") };
		}
		if (direct.length > 1) return { binding: unbound("Ambiguous", "multiple imports can supply this name") };
		const supplied: Array<{ star: RawImportBinding; exposure: Exposure }> = [];
		for (const star of stars) {
			const exposure = await this.starBrings(module, star, reference.name, new Set());
			if (exposure.kind === "absent") continue;
			if (exposure.kind === "unknown" || star.conditional) {
				return { binding: unbound("Ambiguous", "a star import can supply this name") };
			}
			supplied.push({ star, exposure });
		}
		const imported = direct[0];
		if (imported === undefined) {
			const only = supplied.length === 1 ? supplied[0] : undefined;
			if (only === undefined) {
				return supplied.length === 0
					? null
					: { binding: unbound("Ambiguous", "multiple imports can supply this name") };
			}
			return this.bound(only.exposure, reference, { kind: "import", span: only.star.span });
		}
		if (supplied.length > 0) return { binding: unbound("Ambiguous", "a star import can supply this name") };
		if (imported.importedName === null) {
			return { binding: unbound("Ambiguous", "module imports require receiver lookup") };
		}
		const resolution = await this.landing(module, imported.lands);
		if (resolution.status === "external") {
			return { binding: unbound("ExternalDependency", "the imported declaration is outside the workspace") };
		}
		if (resolution.status === "unresolved") {
			return { binding: unbound(resolution.reason, resolution.detail ?? "the import target is unresolved") };
		}
		if (resolution.landing.kind !== "module") {
			return { binding: unbound("NotImplemented", "the import lands outside one module") };
		}
		const exposure = await this.exposure(resolution.landing.module, imported.importedName, new Set());
		return this.bound(exposure, reference, { kind: "import", span: imported.span });
	}

	/**
	 * A member of a chain rooted at an import's binding: its origin names the edge loading the deepest
	 * module the chain proves, and the members after it. It binds only where that module declares it.
	 */
	private async member(
		module: string,
		facts: MappedFacts,
		reference: Reference,
		receiver: Receiver,
	): Promise<Resolution | null> {
		const imported = await this.receiverImport(module, facts, reference, receiver);
		if (imported === null) return null;
		const { path } = receiver;
		let depth = path.length;
		let target = await this.receiverModule(module, imported, path);
		while (target === null && depth > 0) {
			depth--;
			target = await this.receiverModule(module, imported, path.slice(0, depth));
		}
		const origin: ReferenceOrigin = {
			kind: "import",
			span: target?.span ?? imported.span,
			path: [...path.slice(depth), reference.name],
		};
		if (target === null || depth < path.length) return { binding: reference.binding, origin };
		const exposure = await this.exposure(target.module, reference.name, new Set());
		return exposure.kind === "declaration" && fits(reference.role, exposure.declaration)
			? this.bound(exposure, reference, origin)
			: { binding: reference.binding, origin };
	}

	/** The one import binding a receiver's root reads, while nothing else may bind it there. */
	private async receiverImport(
		module: string,
		facts: MappedFacts,
		reference: Reference,
		receiver: Receiver,
	): Promise<RawImportBinding | null> {
		const held = receiver.binding;
		if (
			receiver.nestedLocal ||
			held.status !== "unbound" ||
			held.reason === "Ambiguous" ||
			held.reason === "RuntimeConstructed"
		)
			return null;
		const { direct, stars } = this.visibleImports(facts, reference, receiver.name);
		const imported = direct.length === 1 ? direct[0] : undefined;
		if (imported === undefined || imported.conditional) return null;
		for (const star of stars) {
			if ((await this.starBrings(module, star, receiver.name, new Set())).kind !== "absent") return null;
		}
		return imported;
	}

	/** The module a receiver reads, and the edge that loads it: its import's own, else that submodule's. */
	private async receiverModule(
		module: string,
		imported: RawImportBinding,
		path: string[],
	): Promise<{ module: string; span: Range } | null> {
		const importedName = imported.importedName;
		if (importedName !== null) {
			if (path.length > 0) return null;
			const own = imported.scopePath.length === 0 ? imported.span : undefined;
			const found = await this.fromSubmodule(module, imported.lands, importedName, own);
			return found === null ? null : { module: found, span: imported.span };
		}
		const landed = await this.moduleAt(module, imported.lands);
		if (landed === null) return null;
		// `import a.b.c` loads only `a.b` and `a.b.c`.
		const loads = imported.specifier.split(".").slice(imported.lands.split(".").length);
		if (path.length > loads.length || path.some((name, index) => loads[index] !== name)) return null;
		let current: string | null = landed;
		let specifier = imported.lands;
		for (const name of path) {
			specifier = submoduleSpecifier(specifier, name);
			current = await this.submodule(module, current, specifier, name);
			if (current === null) return null;
		}
		const span = path.length === 0 ? imported.span : imported.loads[path.length - 1];
		return span === undefined ? null : { module: current, span };
	}

	/**
	 * The submodule `from <lands> import <name>` binds, while the package binds nothing else under `name`.
	 * `own`: the asking module-level import, no rival to itself.
	 */
	async fromSubmodule(module: string, lands: string, name: string, own?: Range): Promise<string | null> {
		const landed = await this.moduleAt(module, lands);
		if (landed === null) return null;
		const specifier = submoduleSpecifier(lands, name);
		return this.submodule(module, landed, specifier, name, landed === module ? own : undefined);
	}

	/** A package's attribute `name` is its submodule only while the package binds nothing else under it. */
	private async submodule(
		module: string,
		pkg: string,
		specifier: string,
		name: string,
		own?: Range,
	): Promise<string | null> {
		if (!isPackage(pkg) || (await this.mayBind(pkg, name, own))) return null;
		return this.moduleAt(module, specifier);
	}

	private async moduleAt(module: string, specifier: string): Promise<string | null> {
		const resolution = await this.landing(module, specifier);
		return resolution.status === "resolved" && resolution.landing.kind === "module"
			? resolution.landing.module
			: null;
	}

	/** Whether a module may bind `name` globally, at module level, through `global` or by a star; `own` aside. */
	private async mayBind(module: string, name: string, own?: Range): Promise<boolean> {
		const facts = await this.reads.load(module);
		if (facts === null) return true;
		if (own === undefined) {
			return writes(facts, name) || (await this.exposure(module, name, new Set())).kind !== "absent";
		}
		if (writesBesides(facts, name, own)) return true;
		for (const star of moduleStars(facts)) {
			if ((await this.starBrings(module, star, name, new Set())).kind !== "absent") return true;
		}
		return false;
	}

	/** Whether a module-level `from m import *` brings `name`: proved to, proved not to, or unknown. */
	async starOffers(module: string, star: RawImportBinding, name: string): Promise<"brings" | "absent" | "unknown"> {
		const brought = await this.starBrings(module, star, name, new Set());
		if (brought.kind === "unknown") return "unknown";
		if (brought.kind !== "absent") return "brings";
		const target = await this.moduleAt(module, star.lands);
		const facts = target === null ? null : await this.reads.load(target);
		if (facts === null) return "unknown";
		// Selected, but bound only where an exposure cannot see, such as through `global`.
		return starSelects(facts.allList, name) === true && writes(facts, name) ? "unknown" : "absent";
	}

	private bound(exposure: Exposure, reference: Reference, origin: ReferenceOrigin): Resolution {
		switch (exposure.kind) {
			case "declaration":
				return fits(reference.role, exposure.declaration)
					? {
							binding: { status: "bound", symbolId: exposure.declaration.symbolId, provenance: "bound" },
							origin,
						}
					: { binding: unbound("NotIndexed", "the imported declaration is not indexed") };
			case "module":
				return { binding: unbound("NotIndexed", "the imported name binds a module") };
			case "absent":
				return { binding: unbound("NotIndexed", "the imported declaration is not indexed") };
			case "unknown":
				return { binding: unbound(exposure.reason, exposure.detail) };
		}
	}

	/** What `module` binds `name` to at module level, through its own imports and stars. */
	private exposure(module: string, name: string, visiting: ReadonlySet<string>): Promise<Exposure> {
		const key = JSON.stringify([module, name]);
		if (visiting.has(key)) return Promise.resolve(unknown("RecursionLimit", "the imports form a cycle"));
		const held = this.exposures.get(key);
		if (held !== undefined) return held;
		const found = this.computeExposure(module, name, new Set(visiting).add(key));
		// A cycle seen from inside it is not an answer for the module itself.
		void found.then((exposure) => {
			if (exposure.kind === "unknown" && exposure.reason === "RecursionLimit") this.exposures.delete(key);
		});
		this.exposures.set(key, found);
		return found;
	}

	private async computeExposure(module: string, name: string, visiting: ReadonlySet<string>): Promise<Exposure> {
		const facts = await this.reads.load(module);
		if (facts === null) return unknown("NotIndexed", "the imported module is not indexed");
		const scope = facts.scopeInfos.find((info) => info.scopePath.length === 0);
		if (scope?.dynamic === true) return unknown("RuntimeConstructed", "exec or eval can change this module");
		if (scope?.conditional.includes(name) === true) {
			return unknown("Ambiguous", "a conditional binding can supply this name");
		}
		const declarations = facts.declarations.filter(
			(declaration) => declaration.name === name && declaration.containerId === undefined,
		);
		const imports = facts.importBindings.filter(
			(binding) => binding.scopePath.length === 0 && !binding.star && binding.localName === name,
		);
		if (declarations.length + imports.length > 1) {
			return unknown("Ambiguous", "multiple module-level bindings supply this name");
		}
		let found = ABSENT;
		const declaration = declarations[0];
		const imported = imports[0];
		if (declaration !== undefined) found = { kind: "declaration", declaration };
		else if (imported !== undefined) {
			found = await this.throughImport(module, imported, visiting);
			if (found.kind === "absent") return unknown("BrokenImport", `the import of ${name} finds nothing`);
		}
		for (const star of facts.importBindings.filter((binding) => binding.scopePath.length === 0 && binding.star)) {
			const brought = await this.starBrings(module, star, name, visiting);
			if (brought.kind === "absent") continue;
			if (brought.kind === "unknown") return brought;
			// A star that brings the name competes with every other binding of it.
			if (found.kind !== "absent" || star.conditional) {
				return unknown("Ambiguous", "a star import can supply this name");
			}
			found = brought;
		}
		return found;
	}

	private async throughImport(
		module: string,
		binding: RawImportBinding,
		visiting: ReadonlySet<string>,
	): Promise<Exposure> {
		if (binding.importedName === null) return { kind: "module" };
		const resolution = await this.landing(module, binding.lands);
		if (resolution.status === "external") {
			return unknown("ExternalDependency", "the imported declaration is outside the workspace");
		}
		if (resolution.status === "unresolved") {
			return unknown(resolution.reason, resolution.detail ?? "the import target is unresolved");
		}
		if (resolution.landing.kind !== "module")
			return unknown("NotImplemented", "the import lands outside one module");
		const target = resolution.landing.module;
		// A package's own `from . import name` binds its submodule; the caller weighs any star.
		if (target === module && isPackage(module)) {
			const facts = await this.reads.load(module);
			const specifier = submoduleSpecifier(binding.lands, binding.importedName);
			if (
				facts !== null &&
				!writesBesides(facts, binding.importedName, binding.span) &&
				(await this.moduleAt(module, specifier)) !== null
			)
				return { kind: "module" };
		}
		return this.exposure(target, binding.importedName, visiting);
	}

	/** What `from m import *` brings under `name`, past `m`'s `__all__`. */
	private async starBrings(
		module: string,
		star: RawImportBinding,
		name: string,
		visiting: ReadonlySet<string>,
	): Promise<Exposure> {
		const resolution = await this.landing(module, star.lands);
		if (resolution.status !== "resolved") {
			return unknown(
				resolution.status === "external" ? "ExternalDependency" : resolution.reason,
				"the star import's target is outside the index",
			);
		}
		if (resolution.landing.kind !== "module")
			return unknown("NotImplemented", "the import lands outside one module");
		const target = resolution.landing.module;
		const facts = await this.reads.load(target);
		if (facts === null) return unknown("NotIndexed", "the imported module is not indexed");
		const selected = starSelects(facts.allList, name);
		if (selected === undefined) return unknown("RuntimeConstructed", "the star import's `__all__` is dynamic");
		if (!selected) return ABSENT;
		const exposure = await this.exposure(target, name, visiting);
		// A listed name the module never binds fails the star import itself.
		if (exposure.kind === "absent" && facts.allList?.state === "static") {
			return unknown("BrokenImport", `__all__ lists ${name}, which the module never binds`);
		}
		return exposure;
	}

	/** An import binding reaches a use in `referencePath` unless a scope between them rebinds the name. */
	private visible(
		facts: MappedFacts,
		binding: RawImportBinding,
		name: string,
		referencePath: RawDescriptor[],
	): boolean {
		const importPath = binding.scopePath;
		if (!isPathPrefix(importPath, referencePath)) return false;
		const afterImport = referencePath.slice(importPath.length);
		if (
			importPath.some((descriptor) => descriptor.kind === "type") ||
			(importPath.length > 0 && afterImport.some((descriptor) => descriptor.kind === "type"))
		) {
			return afterImport.length === 0 && samePath(importPath, referencePath);
		}
		for (const info of facts.scopeInfos) {
			if (!isPathPrefix(importPath, info.scopePath) || !isPathPrefix(info.scopePath, referencePath)) continue;
			if (info.globals.includes(name)) continue;
			if (info.nonlocals.includes(name)) return false;
			if (samePath(info.scopePath, importPath)) {
				if (info.parameters.includes(name) || this.writesIn(facts, name, info.scopePath)) return false;
				continue;
			}
			if (info.locals.includes(name) || info.parameters.includes(name)) return false;
		}
		return true;
	}

	private writesIn(facts: MappedFacts, name: string, scopePath: RawDescriptor[]): boolean {
		return facts.references.some(
			(reference) =>
				reference.name === name &&
				reference.role === "write" &&
				samePath(facts.referenceScopes.get(reference) ?? [], scopePath),
		);
	}
}
