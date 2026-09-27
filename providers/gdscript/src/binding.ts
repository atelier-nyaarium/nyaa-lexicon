import { existsSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	comparePositions,
	type Declaration,
	type ImportResolution,
	type Reference,
} from "@nyaa-lexicon/protocol";
import type { LoaderCall } from "./extractCore.js";
import { type GDScriptStore, scopeForModule } from "./module.js";
import { isLoaderCall } from "./path-syntax.js";
import { scanSource } from "./source-scan.js";
import { referenceTokens } from "./tokens.js";

//////// Types

type ReferenceRole = Reference["role"];
type Range = Declaration["range"];

export interface GDScriptLoaderBinding {
	localName: string;
	loader: "preload" | "load";
	specifier: string;
}

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

function sameFileKind(role: ReferenceRole, declaration: Declaration): boolean {
	if (declaration.visibility === "local") return false;
	if (role === "call") return declaration.kind === "method" || declaration.kind === "function";
	if (role === "write") return declaration.kind === "property";
	if (role === "extends") return declaration.kind === "class";
	if (role === "typeUse") return declaration.kind === "class" || declaration.kind === "enum";
	return true;
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
		if (
			reference.binding.status !== "unbound" ||
			reference.binding.reason === "NotIndexed" ||
			reference.binding.reason === "RuntimeConstructed"
		) {
			return reference.binding;
		}

		const candidates = this.candidates(module, reference);
		if (candidates.length === 0) {
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
			if (reference.binding.reason === "NotImplemented") {
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
		if (candidates.length > 1) return ambiguousBinding();
		return bound((candidates[0] as Declaration).symbolId);
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
		if (isLoaderCall(referenceTokens(scanSource(specifier)), 0)) {
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
			if (this.store.load(targetModule) !== undefined) return { status: "resolved", module: targetModule };
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

	private constLoaders(module: string): LoaderCall[] {
		const loaders = this.store.load(module, "full")?.loaders ?? [];
		return loaders.filter((call) => call.binding?.keyword === "const");
	}

	private candidates(module: string, reference: Reference): Declaration[] {
		const candidates = new Map<string, Declaration>();
		const add = (declaration: Declaration): void => {
			candidates.set(declaration.symbolId, declaration);
		};
		const sameFile = this.store.load(module, "full")?.declarations ?? [];
		const containerId = this.sameFileContainer(sameFile, reference);
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
			return [...candidates.values()];
		}

		if (projectClassName(reference.role) && !memberAccess) {
			for (const declaration of this.store.get(`scoped:${scope}\0${reference.name}`)) add(declaration);
		}

		if (reference.role === "read" && !memberAccess) {
			const targetModule = this.autoloadModule(scope, reference.name);
			const target = targetModule === undefined ? undefined : this.rootDeclaration(targetModule);
			if (target !== undefined) add(target);
		}

		for (const declaration of sameFile) {
			if (
				!memberAccess &&
				declaration.name === reference.name &&
				(reference.role === "extends"
					? this.lexicallyVisible(sameFile, reference, declaration)
					: declaration.containerId === containerId) &&
				sameFileKind(reference.role, declaration)
			)
				add(declaration);
		}

		return [...candidates.values()];
	}

	private lexicallyVisible(declarations: Declaration[], reference: Reference, candidate: Declaration): boolean {
		const visibleContainers = new Set<string>();
		let current = reference.fromId;
		while (current !== undefined) {
			visibleContainers.add(current);
			current = declarations.find((declaration) => declaration.symbolId === current)?.containerId;
		}
		const root = declarations.find((declaration) => declaration.containerId === undefined);
		return (
			candidate.containerId === undefined ||
			candidate.symbolId === root?.symbolId ||
			visibleContainers.has(candidate.containerId ?? "")
		);
	}

	private preloadType(module: string, name: string): Declaration | undefined {
		const call = this.constLoaders(module).find(
			(candidate) => candidate.loader === "preload" && candidate.binding?.name === name,
		);
		return call?.literal === undefined ? undefined : this.resolvePreloadType(module, call.literal.path);
	}

	private sameFileContainer(declarations: Declaration[], reference: Reference): string | undefined {
		const root = declarations.find(
			(declaration) => declaration.kind === "class" && declaration.containerId === undefined,
		);
		if (root === undefined || reference.fromId === root.symbolId) return root?.symbolId;
		const owner = declarations.find((declaration) => declaration.symbolId === reference.fromId);
		if (owner?.kind === "class") return owner.symbolId;
		return owner?.containerId ?? root.symbolId;
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
