import { existsSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	comparePositions,
	type Declaration,
	defined,
	type ImportResolution,
	type Reference,
	type ReferenceOrigin,
	sameRange,
} from "@nyaa-lexicon/protocol";
import type { LoaderCall } from "./extractCore.js";
import { lexGdscript } from "./lexer.js";
import { type GDScriptStore, scopeForModule } from "./module.js";
import { isLoaderCall } from "./path-syntax.js";
import { sameFileCandidates } from "./same-file.js";

//////// Types

type ReferenceRole = Reference["role"];
type Range = Declaration["range"];

export interface GDScriptLoaderBinding {
	localName: string;
	loader: "preload" | "load";
	specifier: string;
}

/** A binding, and the route it was proved through. */
export interface Resolved {
	binding: Binding;
	origin?: ReferenceOrigin;
}

/** Declarations a name matches. */
interface Candidates {
	found: Declaration[];
	/** Found by lexical scope, or as the one class_name nothing else spells. */
	direct: boolean;
}

//////// Constants

const DECLARATION: ReferenceOrigin = { kind: "declaration" };

//////// Helpers

function positionInRange(range: Range, position: Range["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function absoluteModule(workspaceRoot: string, module: string): string | null {
	const absolute = path.resolve(workspaceRoot, ...module.split("/"));
	const relative = path.relative(workspaceRoot, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return absolute;
}

function moduleForResource(
	workspaceRoot: string,
	projectRoot: string,
	resource: string,
	currentModule?: string,
): string | null {
	let absolute: string;
	if (resource.startsWith("res://")) {
		absolute = path.resolve(projectRoot, ...resource.slice("res://".length).split("/"));
	} else {
		if (currentModule === undefined) return null;
		const currentAbsolute = absoluteModule(workspaceRoot, currentModule);
		if (currentAbsolute === null) return null;
		absolute = path.resolve(path.dirname(currentAbsolute), ...resource.split("/"));
	}
	const relative = path.relative(workspaceRoot, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return relative.split(path.sep).join("/");
}

function projectClassName(role: ReferenceRole): boolean {
	return role === "read" || role === "extends" || role === "typeUse";
}

function isPathReference(reference: Reference): boolean {
	return (
		reference.role === "import" ||
		(reference.role === "extends" &&
			(reference.name.startsWith("res://") || reference.name.includes("/") || reference.name.endsWith(".gd")))
	);
}

/** A member the script class itself holds, in a role its kind allows. */
function classMemberFor(role: ReferenceRole, declaration: Declaration): boolean {
	const onClass = declaration.languageKind === "static";
	const type = declaration.kind === "enum" || declaration.languageKind === "innerClass";
	if (role === "call") return declaration.kind === "method" && onClass;
	if (role === "write") return declaration.kind === "property" && onClass;
	if (role === "typeUse") return type;
	if (role === "read") return onClass || type || declaration.kind === "constant";
	return false;
}

function bound(symbolId: string): Binding {
	return { status: "bound", symbolId, provenance: "bound" };
}

function ambiguousBinding(): Binding {
	return {
		status: "unbound",
		reason: "Ambiguous",
		detail: "multiple indexed GDScript declarations match this name",
	};
}

//////// Index

/** Binding uses held entries. */
export class GDScriptBindingIndex {
	constructor(private readonly store: GDScriptStore) {}

	bindReference(module: string, reference: Reference): Binding {
		return this.resolveReference(module, reference).binding;
	}

	resolveReference(module: string, reference: Reference): Resolved {
		if (
			reference.binding.status !== "unbound" ||
			reference.binding.reason === "NotIndexed" ||
			reference.binding.reason === "RuntimeConstructed"
		) {
			return { binding: reference.binding };
		}

		const member = this.preloadMember(module, reference);
		if (member !== undefined) return { binding: bound(member.symbolId), ...defined({ origin: reference.origin }) };

		const { found, direct } = this.candidates(module, reference);
		if (found.length === 0) return { binding: this.unmatched(module, reference) };
		if (found.length > 1) return { binding: ambiguousBinding() };
		const binding = bound((found[0] as Declaration).symbolId);
		return direct ? { binding, origin: DECLARATION } : { binding };
	}

	bind(module: string, name: string, range: Range): Binding {
		const facts = this.store.load(module, "full");
		if (facts === undefined) return { status: "unbound", reason: "NotIndexed", detail: "module is not indexed" };

		const reference = facts.references.find(
			(candidate) => candidate.name === name && positionInRange(candidate.range, range.start),
		);
		if (reference !== undefined) return this.bindReference(module, reference);

		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === name &&
				candidate.selectionRange !== undefined &&
				positionInRange(candidate.selectionRange, range.start),
		);
		if (declaration !== undefined) return bound(declaration.symbolId);

		return {
			status: "unbound",
			reason: "NotIndexed",
			detail: "no indexed reference or declaration matched the requested range",
		};
	}

	resolveType(module: string, name: string): Declaration | undefined {
		const candidates = new Map<string, Declaration>();
		const add = (declaration: Declaration | undefined): void => {
			if (declaration !== undefined) candidates.set(declaration.symbolId, declaration);
		};
		add(this.preloadType(module, name));
		const scope = scopeForModule(module, this.store.project);
		for (const declaration of this.store.get(`scoped:${scope}\0${name}`)) add(declaration);
		for (const declaration of this.store.load(module, "full")?.declarations ?? []) {
			if (declaration.name === name && (declaration.kind === "class" || declaration.kind === "enum"))
				add(declaration);
		}
		return candidates.size === 1 ? [...candidates.values()][0] : undefined;
	}

	/** The script a literal `preload` path names. */
	resolvePreloadType(module: string, resource: string): Declaration | undefined {
		const scope = scopeForModule(module, this.store.project);
		const targetModule = moduleForResource(this.store.root, this.projectDirectory(scope), resource, module);
		return targetModule === null ? undefined : this.rootDeclaration(targetModule);
	}

	resolveImport(fromModule: string, specifier: string): ImportResolution {
		// Computed loaders keep call source.
		if (isLoaderCall(lexGdscript(specifier).tokens, 0)) {
			return {
				status: "unresolved",
				reason: "RuntimeConstructed",
				detail: "the loader path is computed at runtime",
			};
		}
		const scope = scopeForModule(fromModule, this.store.project);
		const targetModule = moduleForResource(this.store.root, this.projectDirectory(scope), specifier, fromModule);
		if (targetModule === null) {
			return {
				status: "unresolved",
				reason: "ExternalDependency",
				detail: "the resource path is outside the indexed workspace",
			};
		}
		if (targetModule.endsWith(".gd")) {
			if (this.store.load(targetModule) !== undefined)
				return { status: "resolved", landing: { kind: "module", module: targetModule } };
		} else {
			const target = absoluteModule(this.store.root, targetModule);
			if (target !== null && existsSync(target)) return { status: "external", packageName: specifier };
		}
		return {
			status: "unresolved",
			reason: "NotIndexed",
			detail: "no indexed GDScript module matched the literal path",
		};
	}

	hasRegisteredClassName(name: string): boolean {
		return this.store.get(`name:${name}`).length > 0;
	}

	isRegisteredClassNameSymbol(symbolId: string): boolean {
		return this.store.get(`id:${symbolId}`).length > 0;
	}

	loaderBinding(module: string, localName: string, targetModule: string): GDScriptLoaderBinding | undefined {
		const scope = scopeForModule(module, this.store.project);
		const matches: GDScriptLoaderBinding[] = [];
		for (const call of this.constLoaders(module)) {
			if (call.binding?.name !== localName || call.literal === undefined) continue;
			const resolved = moduleForResource(
				this.store.root,
				this.projectDirectory(scope),
				call.literal.path,
				module,
			);
			if (resolved === targetModule)
				matches.push({ localName, loader: call.loader, specifier: call.literal.path });
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	/** Why a name with no candidate stays unbound. */
	private unmatched(module: string, reference: Reference): Binding {
		if (isPathReference(reference)) {
			return {
				status: "unbound",
				reason: "NotIndexed",
				detail: "the literal resource path has no indexed GDScript declaration",
			};
		}
		const scope = scopeForModule(module, this.store.project);
		if (reference.role === "read" && this.autoloadModule(scope, reference.name) !== undefined) {
			return {
				status: "unbound",
				reason: "NotIndexed",
				detail: "the autoload target has no indexed GDScript declaration",
			};
		}
		if (reference.binding.status === "unbound" && reference.binding.reason === "NotImplemented") {
			if (reference.qualified === true) {
				return {
					status: "unbound",
					reason: "DynamicallyTyped",
					detail: "the receiver's type decides this member, and it is not known",
				};
			}
			return {
				status: "unbound",
				reason: "NotIndexed",
				detail: "no indexed GDScript declaration matches this name",
			};
		}
		return reference.binding;
	}

	private constLoaders(module: string): LoaderCall[] {
		const loaders = this.store.load(module, "full")?.loaders ?? [];
		return loaders.filter((call) => call.binding?.keyword === "const");
	}

	private candidates(module: string, reference: Reference): Candidates {
		const candidates = new Map<string, Declaration>();
		const add = (declaration: Declaration): void => {
			candidates.set(declaration.symbolId, declaration);
		};
		const sameFile = this.store.load(module, "full")?.declarations ?? [];
		const memberAccess = reference.qualified === true;
		const scope = scopeForModule(module, this.store.project);

		if (isPathReference(reference)) {
			const targetModule = moduleForResource(
				this.store.root,
				this.projectDirectory(scope),
				reference.name,
				module,
			);
			const target = targetModule === null ? undefined : this.rootDeclaration(targetModule);
			if (target !== undefined) add(target);
			return { found: [...candidates.values()], direct: false };
		}

		for (const declaration of sameFileCandidates(sameFile, reference)) add(declaration);
		// A class's own member shadows a global class or singleton.
		if (candidates.size > 0) return { found: [...candidates.values()], direct: true };

		if (projectClassName(reference.role) && !memberAccess) {
			for (const declaration of this.store.get(`scoped:${scope}\0${reference.name}`)) add(declaration);
		}

		const autoload =
			reference.role === "read" && !memberAccess ? this.autoloadModule(scope, reference.name) : undefined;
		if (autoload !== undefined) {
			const target = this.rootDeclaration(autoload);
			if (target !== undefined) add(target);
		}

		// A same-file declaration of another kind may shadow the global.
		const shadowed = sameFile.some(
			(declaration) => declaration.name === reference.name && !candidates.has(declaration.symbolId),
		);
		return { found: [...candidates.values()], direct: autoload === undefined && !shadowed };
	}

	/** The class member a const preload's import origin names in the loaded script, through its types. */
	private preloadMember(module: string, reference: Reference): Declaration | undefined {
		const { origin } = reference;
		if (reference.qualified !== true || origin?.kind !== "import" || origin.path === undefined) return undefined;
		const call = this.constLoaders(module).find(
			(candidate) =>
				candidate.loader === "preload" &&
				candidate.binding?.whole === true &&
				sameRange(candidate.span, origin.span),
		);
		if (call?.literal === undefined) return undefined;
		const scope = scopeForModule(module, this.store.project);
		const target = moduleForResource(this.store.root, this.projectDirectory(scope), call.literal.path, module);
		const declarations = target === null ? [] : (this.store.load(target, "full")?.declarations ?? []);
		let holder = declarations.find(
			(declaration) => declaration.kind === "class" && declaration.containerId === undefined,
		);
		for (const [at, name] of origin.path.entries()) {
			const [member, ...others] = declarations.filter(
				(declaration) =>
					holder !== undefined && declaration.containerId === holder.symbolId && declaration.name === name,
			);
			if (member === undefined || others.length > 0) return undefined;
			if (at === origin.path.length - 1) return classMemberFor(reference.role, member) ? member : undefined;
			// Only an enum or inner class holds members a path reaches without an instance.
			if (member.kind !== "enum" && member.languageKind !== "innerClass") return undefined;
			holder = member;
		}
		return undefined;
	}

	private preloadType(module: string, name: string): Declaration | undefined {
		const call = this.constLoaders(module).find(
			(candidate) => candidate.loader === "preload" && candidate.binding?.name === name,
		);
		return call?.literal === undefined ? undefined : this.resolvePreloadType(module, call.literal.path);
	}

	private rootDeclaration(module: string): Declaration | undefined {
		return this.store
			.load(module, "full")
			?.declarations.find((declaration) => declaration.kind === "class" && declaration.containerId === undefined);
	}

	private autoloadModule(scope: string, name: string): string | undefined {
		return this.store.project.scopes.find((candidate) => candidate.directory === scope)?.autoloads[name];
	}

	private projectDirectory(scope: string): string {
		return path.resolve(this.store.root, ...scope.split("/").filter(Boolean));
	}
}
