import type { Binding, Declaration, Reference, UnknownReason } from "@nyaa-lexicon/protocol";
import type { Frame, FrameReceiver, ImportInfo, KotlinFile, ReferenceInfo, TypePath } from "./facts.js";
import {
	type Accept,
	cleanSpecifier,
	externalSpecifier,
	type IndexedDeclaration,
	isClassifier,
	type PackageIndex,
	type UseSite,
	visibleFrom,
} from "./packageIndex.js";

/** A binding, and the package a still-unbound qualifier chain spells. */
export interface Resolved {
	binding: Binding;
	packagePath?: string;
}

const VALUE_KINDS: ReadonlySet<string> = new Set(["property", "variable", "constant"]);

export function matchesRole(declaration: Declaration, role: Reference["role"]): boolean {
	if (role === "call")
		return (
			declaration.kind === "function" ||
			declaration.kind === "method" ||
			declaration.kind === "constructor" ||
			declaration.kind === "class" ||
			declaration.kind === "interface" ||
			declaration.kind === "enum"
		);
	if (role === "instantiate")
		return declaration.kind === "class" || declaration.kind === "interface" || declaration.kind === "enum";
	if (role === "typeUse")
		return ["class", "interface", "enum", "type", "package", "typeParameter"].includes(declaration.kind);
	if (role === "extends") return ["class", "interface", "enum", "type", "package"].includes(declaration.kind);
	if (role === "write") return declaration.kind === "property" || declaration.kind === "variable";
	if (role === "import") return declaration.containerId === undefined && declaration.kind !== "package";
	return declaration.kind !== "package";
}

const CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method", "constructor"]);

/** A read names a function only by `::`, so a value beside it wins. */
function narrowed(role: Reference["role"], candidates: Declaration[]): Declaration[] {
	if (role !== "read") return candidates;
	const values = candidates.filter((candidate) => !CALLABLE_KINDS.has(candidate.kind));
	return values.length > 0 ? values : candidates;
}

function unbound(reason: UnknownReason, detail: string): Resolved {
	return { binding: { status: "unbound", reason, detail } };
}

function decided(found: Declaration[], role: Reference["role"]): Resolved {
	const candidates = narrowed(role, found);
	const ids = [...new Set(candidates.map((candidate) => candidate.symbolId))].sort();
	return {
		binding:
			ids.length === 1
				? { status: "bound", symbolId: ids[0] as string, provenance: "bound" }
				: { status: "ambiguous", candidates: ids, provenance: "bound" },
	};
}

function declarations(entries: IndexedDeclaration[]): Declaration[] {
	return entries.map((entry) => entry.declaration);
}

/** Binds one file's references against the package index, Kotlin's lookup order. */
export class ReferenceBinder {
	private readonly memo = new Map<number, Resolved>();
	private readonly receiverNames = new WeakMap<Frame, Set<string>>();
	private readonly sites = new WeakMap<Frame, UseSite>();

	constructor(
		private readonly index: PackageIndex,
		private readonly facts: KotlinFile,
	) {}

	/** Qualifiers first, iteratively, so a long chain cannot overflow. */
	resolve(info: ReferenceInfo): Resolved {
		const chain: ReferenceInfo[] = [];
		const seen = new Set<number>();
		for (let current: ReferenceInfo | undefined = info; current !== undefined; ) {
			if (this.memo.has(current.index) || seen.has(current.index)) break;
			chain.push(current);
			seen.add(current.index);
			const receiver: ReferenceInfo["receiver"] = current.receiver;
			current = receiver?.kind === "name" ? this.facts.references[receiver.index] : undefined;
		}
		for (let position = chain.length - 1; position >= 0; position--) {
			const link = chain[position] as ReferenceInfo;
			this.memo.set(link.index, this.resolveOne(link));
		}
		return this.memo.get(info.index) as Resolved;
	}

	private resolveOne(info: ReferenceInfo): Resolved {
		if (info.importInfo !== undefined) return this.importDirective(info.importInfo);
		const receiver = info.receiver;
		if (receiver === undefined) return this.bare(info);
		const { name, role } = info.reference;
		const accept: Accept = (declaration) => matchesRole(declaration, role);
		switch (receiver.kind) {
			case "expression":
				return unbound("NotIndexed", `the type left of ${name} is not known`);
			case "this": {
				const target = this.receivers(info.frame).find(
					({ receiver: candidate }) =>
						receiver.label === undefined || ("label" in candidate && candidate.label === receiver.label),
				);
				const members =
					target === undefined
						? undefined
						: this.receiverMembers(target.receiver, name, accept, false, info.frame);
				if (members === undefined) return unbound("NotIndexed", `this receiver's type is not indexed`);
				return members.length > 0 ? decided(members, role) : unbound("NotIndexed", `no member ${name} on this`);
			}
			case "super": {
				const target = this.receivers(info.frame).find(
					({ receiver: candidate }) => candidate.kind !== "extension",
				);
				if (target === undefined) return unbound("NotIndexed", "super has no enclosing class");
				const members =
					target.receiver.kind === "class"
						? declarations(
								this.index.receiverMembers(target.receiver.classId, name, accept, {
									site: this.siteOf(info.frame),
									supertypesOnly: true,
								}),
							)
						: this.receiverMembers(target.receiver, name, accept, false, info.frame);
				return members !== undefined && members.length > 0
					? decided(members, role)
					: unbound("NotIndexed", `no supertype member ${name}`);
			}
			case "name":
				return this.qualified(info, receiver.index, receiver.callable === true, accept);
		}
	}

	private qualified(info: ReferenceInfo, qualifierIndex: number, callable: boolean, accept: Accept): Resolved {
		const { name } = info.reference;
		const qualifier = this.memo.get(qualifierIndex);
		if (qualifier?.packagePath !== undefined) {
			const packageKey = qualifier.packagePath;
			const entries = this.index
				.topLevelNamed(packageKey, name)
				.filter((entry) => visibleFrom(this.facts.module, entry) && accept(entry.declaration));
			if (entries.length > 0) return decided(declarations(entries), info.reference.role);
			const path = `${packageKey}.${name}`;
			if (this.index.isPackagePrefix(path))
				return { ...unbound("NotIndexed", `${path} is a package`), packagePath: path };
			return unbound("NotIndexed", `package ${packageKey} declares no ${name}`);
		}
		const binding = qualifier?.binding;
		if (binding?.status !== "bound") return unbound("NotIndexed", `the qualifier of ${name} is not bound`);
		const container = this.index.declaration(binding.symbolId)?.declaration;
		const qualifierRole = this.facts.references[qualifierIndex]?.reference.role;
		if (container === undefined || !isClassifier(container) || qualifierRole === "call")
			return unbound("NotIndexed", `the type left of ${name} is not known`);
		const site = this.siteOf(info.frame);
		const members = (
			callable
				? this.index.receiverMembers(container.symbolId, name, accept, { site })
				: this.index.staticMembers(container, name)
		).filter((entry) => this.index.reachableFrom(site, entry) && accept(entry.declaration));
		return members.length > 0
			? decided(declarations(members), info.reference.role)
			: unbound("NotIndexed", `${container.name} declares no reachable ${name}`);
	}

	/** Locals, implicit receivers, explicit imports, the package, star imports: the first tier holding candidates decides. */
	private bare(info: ReferenceInfo): Resolved {
		const { name, role } = info.reference;
		const accept: Accept = (declaration) =>
			(matchesRole(declaration, role) || (role === "call" && VALUE_KINDS.has(declaration.kind))) &&
			this.extensionInScope(declaration, info.frame);
		const tier = (candidates: Declaration[]): Resolved | undefined => {
			const admitted = candidates.filter(accept);
			if (admitted.length === 0) return undefined;
			const matched = admitted.filter((declaration) => matchesRole(declaration, role));
			return matched.length > 0 ? decided(matched, role) : unbound("NotIndexed", `${name} invokes a value`);
		};

		let crossed = false;
		for (let frame = info.frame; frame !== undefined; frame = frame.parent) {
			const local = frame.names
				?.get(name)
				?.filter((entry) => entry.from <= info.offset && !(crossed && entry.initializerOnly === true));
			const answer = local === undefined ? undefined : tier(local.map((entry) => entry.declaration));
			if (answer !== undefined) return answer;
			if (name === "it" && frame.implicitIt === true)
				return unbound("NotIndexed", "an arrowless lambda binds it implicitly");
			if (name === "field" && frame.field === true)
				return unbound("NotIndexed", "field is an accessor's backing field");
			if (frame.member === true) crossed = true;
		}

		for (const { receiver, staticOnly } of this.receivers(info.frame)) {
			const members = this.receiverMembers(receiver, name, accept, staticOnly, info.frame);
			const answer = members === undefined ? undefined : tier(members);
			if (answer !== undefined) return answer;
		}

		const imports = this.facts.imports.filter((item) => !item.star && item.localName === name);
		if (imports.length > 0) return this.throughImports(imports, name, tier);

		const packaged = this.index
			.topLevelNamed(this.facts.packageName ?? "", name)
			.filter((entry) => visibleFrom(this.facts.module, entry));
		const packageAnswer = tier(declarations(packaged));
		if (packageAnswer !== undefined) return packageAnswer;

		return this.throughStars(name, tier);
	}

	/** Enclosing receivers, innermost first; past a nested class only static members remain. */
	private receivers(frame: Frame | undefined): Array<{ receiver: FrameReceiver; staticOnly: boolean }> {
		const found: Array<{ receiver: FrameReceiver; staticOnly: boolean }> = [];
		let staticOnly = false;
		for (let current = frame; current !== undefined; current = current.parent) {
			const receiver = current.receiver;
			if (receiver === undefined) continue;
			found.push({ receiver, staticOnly: staticOnly && receiver.kind === "class" });
			if (receiver.kind === "class" && receiver.nested) staticOnly = true;
		}
		return found;
	}

	/** Undefined when the index cannot resolve the receiver, which is skipped rather than a stop. */
	private receiverMembers(
		receiver: FrameReceiver,
		name: string,
		accept: Accept,
		staticOnly: boolean,
		frame: Frame | undefined,
	): Declaration[] | undefined {
		const site = this.siteOf(frame);
		if (receiver.kind === "class")
			return declarations(this.index.receiverMembers(receiver.classId, name, accept, { site, staticOnly }));
		if (receiver.kind === "extension") {
			const type = this.extensionReceiver(receiver.declarationId);
			return type === undefined
				? undefined
				: declarations(this.index.receiverMembers(type, name, accept, { site }));
		}
		const types = this.anonymousSupertypes(receiver.supertypes);
		if (types.length === 0) return undefined;
		return types.flatMap((type) => declarations(this.index.receiverMembers(type, name, accept, { site })));
	}

	private anonymousSupertypes(paths: TypePath[]): string[] {
		return paths.flatMap(
			(path) => this.index.resolveType(this.facts.module, undefined, path)?.declaration.symbolId ?? [],
		);
	}

	/** The classes holding a use, which decide the private and protected members it sees. */
	private siteOf(frame: Frame | undefined): UseSite {
		const cached = frame === undefined ? undefined : this.sites.get(frame);
		if (cached !== undefined) return cached;
		const lexical: string[] = [];
		const subclasses: string[] = [];
		for (const { receiver } of this.receivers(frame)) {
			if (receiver.kind === "class") {
				lexical.push(receiver.classId);
				subclasses.push(receiver.classId);
			} else if (receiver.kind === "anonymous") subclasses.push(...this.anonymousSupertypes(receiver.supertypes));
		}
		const site = { module: this.facts.module, lexical, subclasses };
		if (frame !== undefined) this.sites.set(frame, site);
		return site;
	}

	private extensionReceiver(declarationId: string): string | undefined {
		const path = this.index.receiverTypeOf(declarationId);
		const entry = this.index.declaration(declarationId);
		if (path === undefined || entry === undefined) return undefined;
		return this.index.resolveType(entry.module, entry.declaration.containerId, path)?.declaration.symbolId;
	}

	/** An extension answers a bare name only under a receiver its type names. */
	private extensionInScope(declaration: Declaration, frame: Frame | undefined): boolean {
		const path = this.index.receiverTypeOf(declaration.symbolId);
		if (path === undefined) return true;
		return frame !== undefined && this.namesInScope(frame).has(path.at(-1) as string);
	}

	private namesInScope(frame: Frame): Set<string> {
		const cached = this.receiverNames.get(frame);
		if (cached !== undefined) return cached;
		const names = new Set<string>();
		for (const { receiver } of this.receivers(frame)) {
			if (receiver.kind === "class") this.index.typeNames(receiver.classId, names);
			else if (receiver.kind === "extension") {
				const written = this.index.receiverTypeOf(receiver.declarationId);
				if (written !== undefined) names.add(written.at(-1) as string);
				const type = this.extensionReceiver(receiver.declarationId);
				if (type !== undefined) this.index.typeNames(type, names);
			} else
				for (const path of receiver.supertypes) {
					names.add(path.at(-1) as string);
					const type = this.index.resolveType(this.facts.module, undefined, path);
					if (type !== undefined) this.index.typeNames(type.declaration.symbolId, names);
				}
		}
		this.receiverNames.set(frame, names);
		return names;
	}

	/** The import directive's own name. */
	private importDirective(importInfo: ImportInfo): Resolved {
		const resolution = this.index.resolvePath(this.facts.module, cleanSpecifier(importInfo.specifier));
		if (resolution.status === "external")
			return unbound("ExternalDependency", `import ${importInfo.specifier} is outside the workspace`);
		if (resolution.status === "unresolved") return unbound(resolution.reason, resolution.detail);
		return decided(declarations(resolution.entries), "import");
	}

	private throughImports(
		imports: ImportInfo[],
		name: string,
		tier: (candidates: Declaration[]) => Resolved | undefined,
	): Resolved {
		const pooled: Declaration[] = [];
		let refusal: Resolved | undefined;
		for (const importInfo of imports) {
			const resolution = this.index.resolvePath(this.facts.module, cleanSpecifier(importInfo.specifier));
			if (resolution.status === "found") pooled.push(...declarations(resolution.entries));
			else if (resolution.status === "external")
				refusal ??= unbound("ExternalDependency", `import ${importInfo.specifier} is outside the workspace`);
			else refusal ??= unbound(resolution.reason, resolution.detail);
		}
		return tier(pooled) ?? refusal ?? unbound("NotIndexed", `the imported name ${name} is not indexed`);
	}

	private throughStars(name: string, tier: (candidates: Declaration[]) => Resolved | undefined): Resolved {
		const pooled: Declaration[] = [];
		let external = false;
		for (const star of this.facts.imports.filter((item) => item.star)) {
			const specifier = cleanSpecifier(star.specifier);
			const entries = this.index.starredNamed(this.facts.module, specifier, name);
			if (entries === undefined) {
				external ||= externalSpecifier(specifier);
				continue;
			}
			pooled.push(...declarations(entries.filter((entry) => visibleFrom(this.facts.module, entry))));
		}
		const answer = tier(pooled);
		if (answer !== undefined) return answer;
		const missing = external
			? unbound("ExternalDependency", `a star import may provide ${name} from an external package`)
			: unbound("NotIndexed", `no Kotlin declaration matches ${name}`);
		return this.index.isPackagePrefix(name) ? { ...missing, packagePath: name } : missing;
	}
}
