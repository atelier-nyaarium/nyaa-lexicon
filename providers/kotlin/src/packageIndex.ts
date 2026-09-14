import type { Declaration, UnknownReason } from "@nyaa-lexicon/protocol";
import type { ImportInfo, KotlinFile, TypePath } from "./facts.js";

export interface IndexedDeclaration {
	declaration: Declaration;
	module: string;
}

/** What the index takes from a parse. */
export type ModuleHeaders = Pick<
	KotlinFile,
	"module" | "packageName" | "declarations" | "imports" | "supertypes" | "receiverTypes"
>;

/** What resolving a type written in a module needs from that module. */
interface ModuleEntry {
	packageKey: string;
	imports: ImportInfo[];
	declarations: Declaration[];
	supertypes: KotlinFile["supertypes"];
	receiverTypes: KotlinFile["receiverTypes"];
}

export type PathResolution =
	| { status: "found"; entries: IndexedDeclaration[] }
	| { status: "external" }
	| { status: "unresolved"; reason: UnknownReason; detail: string };

const CLASSIFIER_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum"]);

export function externalSpecifier(specifier: string): boolean {
	return ["kotlin", "kotlinx", "java"].some((root) => specifier === root || specifier.startsWith(`${root}.`));
}

export function cleanSpecifier(specifier: string): string {
	return specifier.endsWith(".*") ? specifier.slice(0, -2) : specifier;
}

export function isClassifier(declaration: Declaration): boolean {
	return CLASSIFIER_KINDS.has(declaration.kind);
}

function languageParts(declaration: Declaration): string[] {
	return declaration.languageKind?.split(" ") ?? [];
}

export function isObject(declaration: Declaration): boolean {
	const parts = languageParts(declaration);
	return parts.includes("object") || parts.includes("companionObject");
}

function isCompanion(declaration: Declaration): boolean {
	return languageParts(declaration).includes("companionObject");
}

/** Reachable through a receiver: not a constructor, type parameter or body local. */
function isMember(declaration: Declaration): boolean {
	return (
		declaration.kind !== "constructor" && declaration.kind !== "typeParameter" && declaration.visibility !== "local"
	);
}

/** Reachable without an instance. */
function isStatic(declaration: Declaration): boolean {
	return isClassifier(declaration) || declaration.languageKind === "enumEntry";
}

export type Accept = (declaration: Declaration) => boolean;

/** Where a use sits. */
export interface UseSite {
	module: string;
	/** Classes whose bodies hold the use. */
	lexical: readonly string[];
	/** Those, and what an anonymous object holding the use extends. */
	subclasses: readonly string[];
}

/** An import's use site. */
export function fileSite(module: string): UseSite {
	return { module, lexical: [], subclasses: [] };
}

/** Who may name declarations. */
type Access =
	| { mode: "public" }
	/** Private top-level: its file. */
	| { mode: "topLevel"; module: string }
	/** Private member: its class. */
	| { mode: "member"; classId: string }
	/** Companion-private: companion or class. */
	| { mode: "companion"; companionId: string; classId: string }
	/** Owners or their subclasses. */
	| { mode: "protected"; owners: readonly string[] };

/**
 * Every workspace declaration by package and name, by container, and each module's headers. The only
 * admitter of a candidate: every lookup takes the use site and answers only what it may name.
 */
export class PackageIndex {
	private readonly topLevel = new Map<string, Map<string, IndexedDeclaration[]>>();
	private readonly children = new Map<string, IndexedDeclaration[]>();
	private readonly modules = new Map<string, ModuleEntry>();
	private readonly modulesByPackage = new Map<string, Set<string>>();
	/** Package prefix to how many packages extend it. */
	private readonly prefixes = new Map<string, number>();
	private readonly byId = new Map<string, IndexedDeclaration>();
	private readonly supertypeCache = new Map<string, string[]>();

	add(facts: ModuleHeaders): void {
		this.remove(facts.module);
		const packageKey = facts.packageName ?? "";
		const declarations = facts.declarations.filter((declaration) => declaration.kind !== "package");
		this.modules.set(facts.module, {
			packageKey,
			imports: facts.imports,
			declarations,
			supertypes: facts.supertypes,
			receiverTypes: facts.receiverTypes,
		});
		const modules = this.modulesByPackage.get(packageKey);
		if (modules === undefined) {
			this.modulesByPackage.set(packageKey, new Set([facts.module]));
			this.countPrefixes(packageKey, 1);
		} else modules.add(facts.module);
		for (const declaration of declarations) {
			const entry = { declaration, module: facts.module };
			this.byId.set(declaration.symbolId, entry);
			if (declaration.containerId === undefined) {
				let names = this.topLevel.get(packageKey);
				if (names === undefined) {
					names = new Map();
					this.topLevel.set(packageKey, names);
				}
				const list = names.get(declaration.name);
				if (list === undefined) names.set(declaration.name, [entry]);
				else list.push(entry);
			} else {
				const list = this.children.get(declaration.containerId);
				if (list === undefined) this.children.set(declaration.containerId, [entry]);
				else list.push(entry);
			}
		}
		this.supertypeCache.clear();
	}

	/** One pass per list the module touched. */
	remove(module: string): void {
		const held = this.modules.get(module);
		if (held === undefined) return;
		this.modules.delete(module);
		this.supertypeCache.clear();
		const names = this.topLevel.get(held.packageKey);
		const touchedNames = new Set<string>();
		const touchedContainers = new Set<string>();
		for (const declaration of held.declarations) {
			if (this.byId.get(declaration.symbolId)?.module === module) this.byId.delete(declaration.symbolId);
			if (declaration.containerId === undefined) touchedNames.add(declaration.name);
			else touchedContainers.add(declaration.containerId);
		}
		const other = (entry: IndexedDeclaration): boolean => entry.module !== module;
		for (const name of touchedNames) {
			const kept = names?.get(name)?.filter(other) ?? [];
			if (kept.length > 0) names?.set(name, kept);
			else names?.delete(name);
		}
		for (const container of touchedContainers) {
			const kept = this.children.get(container)?.filter(other) ?? [];
			if (kept.length > 0) this.children.set(container, kept);
			else this.children.delete(container);
		}
		if (names?.size === 0) this.topLevel.delete(held.packageKey);
		const modules = this.modulesByPackage.get(held.packageKey);
		modules?.delete(module);
		if (modules?.size === 0) {
			this.modulesByPackage.delete(held.packageKey);
			this.countPrefixes(held.packageKey, -1);
		}
	}

	private countPrefixes(packageKey: string, delta: number): void {
		if (packageKey === "") return;
		const segments = packageKey.split(".");
		for (let length = 1; length <= segments.length; length++) {
			const prefix = segments.slice(0, length).join(".");
			const count = (this.prefixes.get(prefix) ?? 0) + delta;
			if (count > 0) this.prefixes.set(prefix, count);
			else this.prefixes.delete(prefix);
		}
	}

	holds(module: string): boolean {
		return this.modules.has(module);
	}

	headersOf(module: string): ModuleHeaders | undefined {
		const entry = this.modules.get(module);
		if (entry === undefined) return undefined;
		return {
			module,
			...(entry.packageKey === "" ? {} : { packageName: entry.packageKey }),
			declarations: entry.declarations,
			imports: entry.imports,
			supertypes: entry.supertypes,
			receiverTypes: entry.receiverTypes,
		};
	}

	heldModules(): string[] {
		return [...this.modules.keys()];
	}

	hasPackage(packageKey: string): boolean {
		return this.modulesByPackage.has(packageKey);
	}

	/** A package, or the start of one. */
	isPackagePrefix(path: string): boolean {
		return this.prefixes.has(path);
	}

	declaration(symbolId: string): IndexedDeclaration | undefined {
		return this.byId.get(symbolId);
	}

	modulesIn(packageKey: string): string[] {
		return [...(this.modulesByPackage.get(packageKey) ?? [])];
	}

	topLevelNamed(site: UseSite, packageKey: string, name: string): IndexedDeclaration[] {
		return this.admitted(site, this.declaredTopLevel(packageKey, name));
	}

	private declaredTopLevel(packageKey: string, name: string): IndexedDeclaration[] {
		return this.topLevel.get(packageKey)?.get(name) ?? [];
	}

	/** A header's site: enclosing containers. */
	declarationSite(module: string, containerId: string | undefined): UseSite {
		const enclosing: string[] = [];
		for (
			let current = containerId;
			current !== undefined;
			current = this.byId.get(current)?.declaration.containerId
		)
			enclosing.push(current);
		return { module, lexical: enclosing, subclasses: enclosing };
	}

	private admitted(site: UseSite, entries: IndexedDeclaration[]): IndexedDeclaration[] {
		return entries.filter((entry) => this.admits(site, entry));
	}

	private admits(site: UseSite, entry: IndexedDeclaration): boolean {
		const access = this.accessOf(entry);
		switch (access.mode) {
			case "public":
				return true;
			case "topLevel":
				return site.module === access.module;
			case "member":
				return site.lexical.includes(access.classId);
			case "companion":
				return site.lexical.includes(access.companionId) || site.lexical.includes(access.classId);
			case "protected":
				return site.subclasses.some((id) => access.owners.some((owner) => this.inherits(id, owner)));
		}
	}

	private accessOf(entry: IndexedDeclaration): Access {
		const { declaration } = entry;
		const containerId = declaration.containerId;
		if (containerId === undefined)
			return declaration.exported === false ? { mode: "topLevel", module: entry.module } : { mode: "public" };
		if (declaration.visibility !== "private" && declaration.visibility !== "protected") return { mode: "public" };
		const container = this.byId.get(containerId)?.declaration;
		const classId = container !== undefined && isCompanion(container) ? container.containerId : undefined;
		if (declaration.visibility === "protected")
			return { mode: "protected", owners: classId === undefined ? [containerId] : [containerId, classId] };
		return classId === undefined
			? { mode: "member", classId: containerId }
			: { mode: "companion", companionId: containerId, classId };
	}

	packageOf(module: string): string | undefined {
		return this.modules.get(module)?.packageKey;
	}

	receiverTypeOf(symbolId: string): TypePath | undefined {
		const entry = this.byId.get(symbolId);
		return entry === undefined ? undefined : this.modules.get(entry.module)?.receiverTypes.get(symbolId);
	}

	/** A dotted path: the longest package prefix, then containers by name, each step admitted. */
	resolvePath(site: UseSite, specifier: string): PathResolution {
		const segments = specifier.split(".").filter((segment) => segment !== "");
		let packageMatched = false;
		for (let length = segments.length - 1; length > 0; length--) {
			const packageKey = segments.slice(0, length).join(".");
			if (!this.hasPackage(packageKey)) continue;
			packageMatched = true;
			const [first, ...rest] = segments.slice(length);
			let entries = this.topLevelNamed(site, packageKey, first as string);
			for (const name of rest)
				entries = entries.flatMap((entry) => this.staticMembers(site, entry.declaration, name));
			if (entries.length > 0) return { status: "found", entries };
		}
		if (packageMatched)
			return {
				status: "unresolved",
				reason: "NotIndexed",
				detail: `the imported name ${specifier} is not indexed`,
			};
		if (externalSpecifier(specifier)) return { status: "external" };
		return {
			status: "unresolved",
			reason: "NotIndexed",
			detail: `no workspace file declares an imported package for ${specifier}`,
		};
	}

	/**
	 * What `import specifier.*` in a module provides for a name; undefined when the index holds no such
	 * package or type. Admitted where the import is written, never at a use.
	 */
	starredNamed(module: string, specifier: string, name: string): IndexedDeclaration[] | undefined {
		const site = fileSite(module);
		if (this.hasPackage(specifier)) return this.topLevelNamed(site, specifier, name);
		const containers = this.resolvePath(site, specifier);
		if (containers.status !== "found") return undefined;
		return containers.entries.flatMap((entry) => this.staticMembers(site, entry.declaration, name));
	}

	/** `Type.member`: nested classifiers and enum entries, an object's members, then companion members. */
	staticMembers(site: UseSite, container: Declaration, name: string): IndexedDeclaration[] {
		const children = this.children.get(container.symbolId) ?? [];
		const object = isObject(container);
		const direct = this.admitted(
			site,
			children.filter(
				(entry) =>
					entry.declaration.name === name &&
					isMember(entry.declaration) &&
					(object || isStatic(entry.declaration)),
			),
		);
		if (direct.length > 0) return direct;
		return this.admitted(
			site,
			this.companionMembers(container.symbolId, name, () => true),
		);
	}

	private companionMembers(containerId: string, name: string, accept: Accept): IndexedDeclaration[] {
		return (this.children.get(containerId) ?? [])
			.filter((entry) => isCompanion(entry.declaration))
			.flatMap((companion) => this.named(companion.declaration.symbolId, name, accept));
	}

	private named(containerId: string, name: string, accept: Accept): IndexedDeclaration[] {
		return (this.children.get(containerId) ?? []).filter(
			(entry) => entry.declaration.name === name && isMember(entry.declaration) && accept(entry.declaration),
		);
	}

	/** Whether a class is the other or extends it. */
	private inherits(classId: string, ancestorId: string): boolean {
		const seen = new Set<string>();
		const pending = [classId];
		while (pending.length > 0) {
			const id = pending.pop() as string;
			if (id === ancestorId) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			pending.push(...this.supertypeIds(id));
		}
		return false;
	}

	/**
	 * What an implicit or explicit receiver of a class offers a use for a name: its own members, its
	 * companion's, then each supertype depth pooled, each only where the use may see it.
	 */
	receiverMembers(
		site: UseSite,
		classId: string,
		name: string,
		accept: Accept,
		options: { staticOnly?: boolean; supertypesOnly?: boolean } = {},
	): IndexedDeclaration[] {
		const own = this.byId.get(classId);
		if (own === undefined) return [];
		const staticOnly = options.staticOnly === true && !isObject(own.declaration);
		const admit: Accept = staticOnly ? (declaration) => isStatic(declaration) && accept(declaration) : accept;
		const reachable = (entries: IndexedDeclaration[]): IndexedDeclaration[] => this.admitted(site, entries);
		if (options.supertypesOnly !== true) {
			const direct = reachable(this.named(classId, name, admit));
			if (direct.length > 0) return direct;
			const companion = reachable(this.companionMembers(classId, name, accept));
			if (companion.length > 0) return companion;
		}
		const seen = new Set([classId]);
		let level = this.supertypeIds(classId).filter((id) => !seen.has(id));
		while (level.length > 0) {
			const found: IndexedDeclaration[] = [];
			for (const id of level) {
				seen.add(id);
				found.push(
					...reachable(this.named(id, name, admit)),
					...reachable(this.companionMembers(id, name, admit)),
				);
			}
			if (found.length > 0) return found;
			level = [...new Set(level.flatMap((id) => this.supertypeIds(id)))].filter((id) => !seen.has(id));
		}
		return [];
	}

	/** Every name the class answers to as a receiver type: its own and its supertypes'. */
	typeNames(classId: string, into: Set<string>): void {
		const seen = new Set<string>();
		const pending = [classId];
		while (pending.length > 0) {
			const id = pending.pop() as string;
			if (seen.has(id)) continue;
			seen.add(id);
			const entry = this.byId.get(id);
			if (entry === undefined) continue;
			into.add(entry.declaration.name);
			for (const path of this.modules.get(entry.module)?.supertypes.get(id) ?? [])
				into.add(path.at(-1) as string);
			pending.push(...this.supertypeIds(id));
		}
	}

	/** Supertypes the index can resolve, written in the class's own module. */
	supertypeIds(classId: string): string[] {
		const cached = this.supertypeCache.get(classId);
		if (cached !== undefined) return cached;
		this.supertypeCache.set(classId, []);
		const entry = this.byId.get(classId);
		const paths = entry === undefined ? [] : (this.modules.get(entry.module)?.supertypes.get(classId) ?? []);
		const ids: string[] = [];
		if (entry !== undefined)
			for (const path of paths) {
				const { module, declaration } = entry;
				const site = this.declarationSite(module, declaration.containerId);
				const resolved = this.resolveType(site, declaration.containerId, path);
				if (resolved !== undefined && resolved.declaration.symbolId !== classId)
					ids.push(resolved.declaration.symbolId);
			}
		this.supertypeCache.set(classId, ids);
		return ids;
	}

	/** A type written at a site: enclosing containers, imports, package, stars, then a package path. */
	resolveType(site: UseSite, containerId: string | undefined, path: TypePath): IndexedDeclaration | undefined {
		const context = this.modules.get(site.module);
		const [first, ...rest] = path;
		if (context === undefined || first === undefined) return undefined;
		const classifiers = (entries: IndexedDeclaration[]): IndexedDeclaration[] =>
			entries.filter((entry) => isClassifier(entry.declaration));
		let found: IndexedDeclaration[] = [];
		for (let current = containerId; current !== undefined && found.length === 0; ) {
			const named = (this.children.get(current) ?? []).filter((entry) => entry.declaration.name === first);
			found = classifiers(this.admitted(site, named));
			current = this.byId.get(current)?.declaration.containerId;
		}
		if (found.length === 0)
			for (const item of context.imports)
				if (!item.star && item.localName === first) {
					const resolution = this.resolvePath(fileSite(site.module), cleanSpecifier(item.specifier));
					if (resolution.status === "found") found.push(...classifiers(resolution.entries));
				}
		if (found.length === 0) found = classifiers(this.topLevelNamed(site, context.packageKey, first));
		if (found.length === 0)
			for (const item of context.imports)
				if (item.star)
					found.push(
						...classifiers(this.starredNamed(site.module, cleanSpecifier(item.specifier), first) ?? []),
					);
		let segments = rest;
		if (found.length === 0)
			for (let length = path.length - 1; length > 0 && found.length === 0; length--) {
				const packageKey = path.slice(0, length).join(".");
				if (!this.hasPackage(packageKey)) continue;
				found = classifiers(this.topLevelNamed(site, packageKey, path[length] as string));
				segments = path.slice(length + 1);
			}
		for (const name of segments)
			found = found.flatMap((entry) => classifiers(this.staticMembers(site, entry.declaration, name)));
		return found.length === 1 ? found[0] : undefined;
	}
}
