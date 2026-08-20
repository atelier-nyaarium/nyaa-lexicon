import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	comparePositions,
	coordinatesOf,
	type Declaration,
	type ImportResolution,
	type Reference,
} from "@nyaa-lexicon/protocol";
import { extractDeclarations, extractFile } from "./extract.js";
import { discoverProject } from "./project.js";

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

export class GDScriptBindingIndex {
	private readonly declarationsByModule = new Map<string, Declaration[]>();
	private readonly referencesByModule = new Map<string, Reference[]>();
	private readonly sourceByModule = new Map<string, string>();
	private readonly moduleScopes = new Map<string, string>();
	private readonly classNamesByScope = new Map<string, Map<string, Declaration[]>>();
	private readonly autoloadModulesByScope = new Map<string, Map<string, string>>();
	private workspaceIndexed = false;

	constructor(private readonly workspaceRoot: string) {}

	registerFile(module: string, declarations: Declaration[], references: Reference[], text: string): void {
		this.ensureWorkspaceIndex();
		this.replaceDeclarations(module, declarations);
		this.referencesByModule.set(module, references);
		this.sourceByModule.set(module, text);
	}

	bindReference(module: string, reference: Reference): Binding {
		this.ensureWorkspaceIndex();
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
			const scope = this.moduleScopes.get(module) ?? this.scopeForModule(module);
			if (reference.role === "read" && this.autoloadModulesByScope.get(scope)?.has(reference.name)) {
				return {
					status: "unbound",
					reason: "NotIndexed",
					detail: "the autoload target has no indexed GDScript declaration",
				};
			}
			// The parse-time placeholder says binding is not implemented, but this IS the binding
			// pass and it searched the workspace. After a completed search the honest answer depends
			// on WHY nothing matched: a member access hangs off a receiver whose type is unknown,
			// while a bare name (builtin, engine class or typo) is simply not in the index.
			if (reference.binding.reason === "NotImplemented") {
				if (this.memberAccess(module, reference)) {
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
		const facts = this.factsForModule(module);
		if (facts === null) return { status: "unbound", reason: "NotIndexed", detail: "module is not indexed" };

		const reference = facts.references.find(
			(candidate) => candidate.name === name && positionInRange(candidate.range, range.start),
		);
		if (reference !== undefined) return this.bindReference(module, reference);

		const declaration = facts.declarations.find(
			(candidate) => candidate.name === name && positionInRange(candidate.selectionRange, range.start),
		);
		if (declaration !== undefined) return bound(declaration.symbolId);

		return {
			status: "unbound",
			reason: "NotIndexed",
			detail: "no indexed reference or declaration matched the requested range",
		};
	}

	resolveType(module: string, name: string): Declaration | undefined {
		this.ensureWorkspaceIndex();
		const candidates = new Map<string, Declaration>();
		const add = (declaration: Declaration | undefined): void => {
			if (declaration !== undefined) candidates.set(declaration.symbolId, declaration);
		};
		add(this.preloadType(module, name));
		const scope = this.moduleScopes.get(module) ?? this.scopeForModule(module);
		for (const declaration of this.classNamesByScope.get(scope)?.get(name) ?? []) add(declaration);
		for (const declaration of this.declarationsByModule.get(module) ?? []) {
			if (declaration.name === name && (declaration.kind === "class" || declaration.kind === "enum"))
				add(declaration);
		}
		return candidates.size === 1 ? [...candidates.values()][0] : undefined;
	}

	resolvePreloadType(module: string, expression: string): Declaration | undefined {
		this.ensureWorkspaceIndex();
		const match = /^preload\s*\(\s*&?\s*(["'])([^"']+)\1\s*\)$/u.exec(expression.trim());
		if (match === null) return undefined;
		const scope = this.moduleScopes.get(module) ?? this.scopeForModule(module);
		const targetModule = moduleForResource(this.workspaceRoot, scope, match[2] as string, module);
		return targetModule === null ? undefined : this.rootDeclaration(targetModule);
	}

	resolveImport(fromModule: string, specifier: string): ImportResolution {
		this.ensureWorkspaceIndex();
		if (/(?:^|\.)\s*(?:preload|load)\s*\(/.test(specifier)) {
			return {
				status: "unresolved",
				reason: "RuntimeConstructed",
				detail: "the loader path is computed at runtime",
			};
		}
		const scope = this.moduleScopes.get(fromModule) ?? this.scopeForModule(fromModule);
		const targetModule = moduleForResource(this.workspaceRoot, scope, specifier, fromModule);
		if (targetModule === null) {
			return {
				status: "unresolved",
				reason: "ExternalDependency",
				detail: "the resource path is outside the indexed workspace",
			};
		}
		if (targetModule.endsWith(".gd") && this.declarationsByModule.has(targetModule)) {
			return { status: "resolved", module: targetModule };
		}
		const target = absoluteModule(this.workspaceRoot, targetModule);
		if (target !== null && existsSync(target)) return { status: "external", packageName: specifier };
		return {
			status: "unresolved",
			reason: "NotIndexed",
			detail: "no indexed GDScript module matched the literal path",
		};
	}

	hasRegisteredClassName(name: string): boolean {
		this.ensureWorkspaceIndex();
		for (const classNames of this.classNamesByScope.values()) {
			if (classNames.has(name)) return true;
		}
		return false;
	}

	isRegisteredClassNameSymbol(symbolId: string): boolean {
		this.ensureWorkspaceIndex();
		for (const declarations of this.declarationsByModule.values()) {
			if (
				declarations.some(
					(declaration) => declaration.symbolId === symbolId && declaration.languageKind === "class_name",
				)
			) {
				return true;
			}
		}
		return false;
	}

	loaderBinding(module: string, localName: string, targetModule: string): GDScriptLoaderBinding | undefined {
		this.ensureWorkspaceIndex();
		const source = this.sourceByModule.get(module);
		if (source === undefined) return undefined;
		const scope = this.moduleScopes.get(module) ?? this.scopeForModule(module);
		const matches: GDScriptLoaderBinding[] = [];
		const pattern =
			/^\s*const\s+([\p{L}_][\p{L}\p{M}\p{N}_]*)\s*=\s*(preload|load)\s*\(\s*&?\s*(["'])([^"']+)\3\s*\)/gmu;
		for (const match of source.matchAll(pattern)) {
			const name = match[1] as string;
			const loader = match[2] as "preload" | "load";
			const specifier = match[4] as string;
			if (name !== localName) continue;
			const resolved = moduleForResource(this.workspaceRoot, scope, specifier, module);
			if (resolved === targetModule) matches.push({ localName: name, loader, specifier });
		}
		return matches.length === 1 ? (matches[0] as GDScriptLoaderBinding) : undefined;
	}

	private candidates(module: string, reference: Reference): Declaration[] {
		const candidates = new Map<string, Declaration>();
		const add = (declaration: Declaration): void => {
			candidates.set(declaration.symbolId, declaration);
		};
		const sameFile = this.declarationsByModule.get(module) ?? [];
		const containerId = this.sameFileContainer(sameFile, reference);
		const memberAccess = this.memberAccess(module, reference);
		const scope = this.moduleScopes.get(module) ?? this.scopeForModule(module);

		if (isPathReference(reference)) {
			const targetModule = moduleForResource(this.workspaceRoot, scope, reference.name, module);
			const target = targetModule === null ? undefined : this.rootDeclaration(targetModule);
			if (target !== undefined) add(target);
			return [...candidates.values()];
		}

		if (projectClassName(reference.role) && !memberAccess) {
			for (const declaration of this.classNamesByScope.get(scope)?.get(reference.name) ?? []) add(declaration);
		}

		if (reference.role === "read" && !memberAccess) {
			const targetModule = this.autoloadModulesByScope.get(scope)?.get(reference.name);
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

	private memberAccess(module: string, reference: Reference): boolean {
		const source = this.sourceByModule.get(module);
		if (source === undefined) return false;
		const prefix = coordinatesOf(source).sliceRange({
			start: { line: reference.range.start.line, character: 0 },
			end: reference.range.start,
		});
		return prefix !== undefined && /\.\s*$/.test(prefix);
	}

	private preloadType(module: string, name: string): Declaration | undefined {
		const source = this.sourceByModule.get(module);
		if (source === undefined) return undefined;
		const scope = this.moduleScopes.get(module) ?? this.scopeForModule(module);
		for (const line of source.split(/\r?\n/)) {
			const match =
				/^\s*const\s+([\p{L}_][\p{L}\p{M}\p{N}_]*)\s*=\s*preload\s*\(\s*&?\s*(["'])([^"']+)\2\s*\)/u.exec(line);
			if (match === null || match[1] !== name) continue;
			const targetModule = moduleForResource(this.workspaceRoot, scope, match[3] as string, module);
			return targetModule === null ? undefined : this.rootDeclaration(targetModule);
		}
		return undefined;
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

	private factsForModule(module: string): { declarations: Declaration[]; references: Reference[] } | null {
		this.ensureWorkspaceIndex();
		const references = this.referencesByModule.get(module);
		const declarations = this.declarationsByModule.get(module);
		if (references !== undefined && declarations !== undefined) return { declarations, references };

		const absolute = absoluteModule(this.workspaceRoot, module);
		if (absolute === null || !existsSync(absolute)) return null;
		try {
			const text = readFileSync(absolute, "utf8");
			const extracted = extractFile(module, text);
			this.registerFile(module, extracted.declarations, extracted.references, text);
			return extracted;
		} catch {
			return null;
		}
	}

	private ensureWorkspaceIndex(): void {
		if (this.workspaceIndexed) return;
		this.workspaceIndexed = true;
		if (!existsSync(this.workspaceRoot)) return;
		try {
			for (const module of discoverProject(this.workspaceRoot).files) {
				const absolute = absoluteModule(this.workspaceRoot, module);
				if (absolute === null || !existsSync(absolute)) continue;
				try {
					const text = readFileSync(absolute, "utf8");
					this.sourceByModule.set(module, text);
					this.replaceDeclarations(module, extractDeclarations(module, text));
				} catch {}
			}
			this.indexAutoloads();
		} catch {
			return;
		}
	}

	private indexAutoloads(): void {
		const scopes = new Set(this.moduleScopes.values());
		if (existsSync(path.join(this.workspaceRoot, "project.godot"))) scopes.add(this.workspaceRoot);
		for (const scope of scopes) {
			const projectFile = path.join(scope, "project.godot");
			if (!existsSync(projectFile)) continue;
			try {
				const entries = new Map<string, string>();
				let inAutoloads = false;
				for (const line of readFileSync(projectFile, "utf8").split(/\r?\n/)) {
					const section = /^\[([^\]]+)\]$/.exec(line.trim());
					if (section !== null) {
						inAutoloads = section[1] === "autoload";
						continue;
					}
					if (!inAutoloads) continue;
					const entry = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"\*?(res:\/\/[^"\\]+)"/.exec(line.trim());
					if (entry === null) continue;
					const module = moduleForResource(this.workspaceRoot, scope, entry[2] as string);
					if (module !== null) entries.set(entry[1] as string, module);
				}
				if (entries.size > 0) this.autoloadModulesByScope.set(scope, entries);
			} catch {}
		}
	}

	private rootDeclaration(module: string): Declaration | undefined {
		return this.declarationsByModule
			.get(module)
			?.find((declaration) => declaration.kind === "class" && declaration.containerId === undefined);
	}

	private replaceDeclarations(module: string, declarations: Declaration[]): void {
		this.removeDeclarations(module);
		const scope = this.scopeForModule(module);
		this.declarationsByModule.set(module, declarations);
		this.moduleScopes.set(module, scope);
		const classNames = this.classNamesByScope.get(scope) ?? new Map<string, Declaration[]>();
		for (const declaration of declarations) {
			if (declaration.languageKind !== "class_name") continue;
			const registrations = classNames.get(declaration.name) ?? [];
			registrations.push(declaration);
			classNames.set(declaration.name, registrations);
		}
		this.classNamesByScope.set(scope, classNames);
	}

	private removeDeclarations(module: string): void {
		const previous = this.declarationsByModule.get(module);
		const scope = this.moduleScopes.get(module);
		if (previous !== undefined && scope !== undefined) {
			const classNames = this.classNamesByScope.get(scope);
			if (classNames !== undefined) {
				for (const declaration of previous) {
					if (declaration.languageKind !== "class_name") continue;
					const registrations = classNames
						.get(declaration.name)
						?.filter((candidate) => candidate.symbolId !== declaration.symbolId);
					if (registrations === undefined || registrations.length === 0) classNames.delete(declaration.name);
					else classNames.set(declaration.name, registrations);
				}
				if (classNames.size === 0) this.classNamesByScope.delete(scope);
			}
		}
		this.declarationsByModule.delete(module);
		this.moduleScopes.delete(module);
	}

	private scopeForModule(module: string): string {
		const absolute = absoluteModule(this.workspaceRoot, module);
		if (absolute === null) return this.workspaceRoot;
		let directory = path.dirname(absolute);
		while (true) {
			if (existsSync(path.join(directory, "project.godot"))) return directory;
			if (directory === this.workspaceRoot) return this.workspaceRoot;
			const parent = path.dirname(directory);
			if (parent === directory || !path.relative(this.workspaceRoot, parent).startsWith("..")) {
				directory = parent;
				continue;
			}
			return this.workspaceRoot;
		}
	}
}
