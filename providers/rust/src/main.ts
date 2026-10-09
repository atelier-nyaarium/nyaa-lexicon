import {
	type ArrangeEditsRequest,
	type Binding,
	comparePositions,
	type Declaration,
	type Diagnostic,
	defined,
	type FileRole,
	handlersFor,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportResolution,
	type IndexDepth,
	type Landing,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
	notImplementedImportEdits,
	notImplementedMove,
	type OffsetRange,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	type Range,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import type { ImportBinding, ParsedFile, RawDeclaration, RawReference } from "./model.js";
import { parseRustFile } from "./parser.js";
import {
	discoverRustProject,
	EXCLUDED_DIRECTORIES,
	isModRs,
	moduleFileOf,
	pathSegments,
	type RustEntry,
	RustProjectResolver,
	type RustProjectState,
} from "./project.js";
import {
	containersAround,
	type Found,
	ITEM_SCOPES,
	importSite,
	type Lookup,
	type Place,
	placeOf,
	ScopeResolver,
	sameBlock,
	samePath,
	type Tiers,
	tighter,
	within,
} from "./scopes.js";

export const LANGUAGE = "rust";
export const EXTENSIONS = [".rs"] as const;
export const REFERENCE_ROLES = ["call", "read", "write", "import", "implements", "instantiate", "typeUse"] as const;

export const TIERS = {
	projectModel: true,
	declarations: true,
	references: true,
	imports: true,
	binding: true,
	types: true,
	literals: true,
	comments: true,
	docs: false,
	metrics: true,
	syntaxDiagnostics: true,
	fileRoles: true,
	exports: true,
} as const;

export const PROVIDER_ID = "rust-provider";

/** Path heads that name a module relative to the current one, never a crate. */
const PATH_KEYWORDS: ReadonlySet<string> = new Set(["crate", "self", "super", "Self"]);

/** Rust 2021 strict and reserved keywords. Builtins are the primitive types, never real keywords. */
export const WORDS = {
	keywords: [
		"Self",
		"abstract",
		"as",
		"async",
		"await",
		"become",
		"box",
		"break",
		"const",
		"continue",
		"crate",
		"do",
		"dyn",
		"else",
		"enum",
		"extern",
		"final",
		"fn",
		"for",
		"gen",
		"if",
		"impl",
		"in",
		"let",
		"loop",
		"macro",
		"match",
		"mod",
		"move",
		"mut",
		"override",
		"priv",
		"pub",
		"ref",
		"return",
		"self",
		"static",
		"struct",
		"super",
		"trait",
		"try",
		"type",
		"typeof",
		"union",
		"unsafe",
		"unsized",
		"use",
		"virtual",
		"where",
		"while",
		"yield",
	],
	builtins: [
		"String",
		"Vec",
		"bool",
		"char",
		"f32",
		"f64",
		"i128",
		"i16",
		"i32",
		"i64",
		"i8",
		"isize",
		"str",
		"u128",
		"u16",
		"u32",
		"u64",
		"u8",
		"usize",
	],
	literals: ["false", "true"],
};

function contains(range: Range, position: Range["start"]): boolean {
	// Inclusive at both ends.
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function unknown(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
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
	if (role === "typeUse" || role === "implements")
		return ["struct", "enum", "interface", "class"].includes(declaration.kind);
	if (role === "write") return declaration.kind !== "constant" || declaration.languageKind === "static";
	return true;
}

/** Roles a local's name can take. */
const VALUE_ROLES: ReadonlySet<Reference["role"]> = new Set(["read", "write", "call"]);

/** Targets whose `main` something runs. */
const EXECUTABLES: ReadonlySet<string> = new Set(["bin", "example", "build"]);

/** What a path segment another follows can name. */
const QUALIFIER_KINDS: ReadonlySet<string> = new Set(["module", "struct", "enum", "interface", "class"]);

/** `.name` reads a field and calls a method, a segment another follows names a module or type, and nothing else reaches a field. */
function kindAdmits(raw: RawReference, declaration: Declaration): boolean {
	if (raw.qualifier === true) return QUALIFIER_KINDS.has(declaration.kind);
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

function parseFailure(module: string, detail: string): ParsedFile {
	const diagnostic: Diagnostic = { severity: "error", message: detail, path: module };
	return {
		module,
		text: "",
		declarations: [],
		references: [],
		imports: [],
		scopeContributions: [],
		literals: [],
		comments: [],
		diagnostics: [diagnostic],
		rawDeclarations: [],
		byName: new Map(),
		byId: new Map(),
		locals: new Map(),
		impls: [],
		rawReferences: [],
		referenceAt: new Map(),
		importBindings: [],
		typeAnswers: new Map(),
	};
}

function rustFileRole(module: string, declarations: readonly Declaration[], project: RustProjectState): FileRole {
	const main = declarations.find(
		(declaration) =>
			declaration.name === "main" &&
			declaration.kind === "function" &&
			declaration.languageKind === "fn" &&
			declaration.containerId === undefined,
	);
	if (main === undefined) return { kind: "library" };
	if (EXECUTABLES.has(project.targets.get(module)?.kind ?? ""))
		return { kind: "entry", how: "main", symbolId: main.symbolId };
	return { kind: "unknown", reason: "NotImplemented" };
}

function readRustFile(module: string, text: string, depth: IndexDepth): ParsedFile {
	try {
		return parseRustFile(module, text, depth === "outline" ? "outline" : "full");
	} catch (error) {
		return parseFailure(module, error instanceof Error ? error.message : String(error));
	}
}

/**
 * A module's index rows: under each name its impls' targets are written with, so members bind wherever
 * an impl lives, and under each file its `mod` declarations load, so the module tree reads upward.
 */
function rustEntries(
	module: string,
	facts: ParsedFile,
	_held: unknown,
	project: RustProjectState,
): Iterable<readonly [string, RustEntry]> {
	const rows: Array<readonly [string, RustEntry]> = [];
	const names = new Set<string>();
	for (const impl of facts.impls) {
		// An impl over its own generic implements no named type.
		const generic = impl.memberPath === undefined || samePath(impl.memberPath, impl.descriptorPath);
		if (impl.targetName !== undefined && !generic) names.add(impl.targetName);
	}
	for (const name of names) rows.push([`impl:${name}`, { module }]);
	const modRs = isModRs(module, project);
	for (const raw of facts.rawDeclarations) {
		const inline = raw.descriptorPath.slice(0, -1);
		if (raw.fileModule === undefined || inline.some((descriptor) => descriptor.kind !== "namespace")) continue;
		const names = inline.map((descriptor) => descriptor.name);
		const file = moduleFileOf(module, modRs, names, raw.declaration.name, raw.fileModule.path, project.fileSet);
		if (file !== null) rows.push([`declares:${file}`, { module, declaration: raw.declaration.symbolId }]);
	}
	return rows;
}

export class RustProvider {
	readonly store = moduleStore<ParsedFile, RustProjectState, RustEntry>({ read: readRustFile, entries: rustEntries });
	private readonly resolver = new RustProjectResolver(this.store);
	private readonly scopes = new ScopeResolver(
		(module) => this.factsForModule(module),
		this.resolver,
		(typeName) => this.store.get(`impl:${typeName}`).map(({ module }) => module),
		(key, compute) => this.store.memo(key, compute),
	);

	initialize(_workspaceRoot: string) {
		return {
			providerId: PROVIDER_ID,
			language: LANGUAGE,
			extensions: [...EXTENSIONS],
			excludedDirectories: EXCLUDED_DIRECTORIES,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(
		workspaceRoot: string,
		_previous: RustProjectState | undefined,
		scope?: string[],
	): { model: ProjectModel; project: RustProjectState } {
		const discovered = discoverRustProject(workspaceRoot, this.store.policy, scope);
		return { model: discovered.model, project: discovered.state };
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		facts: ParsedFile,
	) {
		const outline = params.depth === "outline";
		const references = outline ? [] : this.wireReferences(facts);
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references,
			imports: facts.imports,
			...defined({ exports: facts.exports }),
			scopeContributions: facts.scopeContributions,
			literals: facts.literals,
			comments: facts.comments,
			...defined({ blankLines: facts.blankLines }),
			diagnostics: facts.diagnostics,
			role: rustFileRole(params.module, facts.declarations, this.store.project),
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	/**
	 * Where a specifier's names are looked up, from a module's top, through the module tree its crate's
	 * declarations build: what a glob opens, what holds a named leaf, or the crate a lone segment binds.
	 */
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const { absolute, segments, glob } = pathSegments(params.specifier);
		if (segments.length === 0)
			return { status: "unresolved", reason: "ParseError", detail: "the import path is empty" };
		const facts = this.factsForModule(params.fromModule);
		const missing: ImportResolution = {
			status: "unresolved",
			reason: "NotIndexed",
			detail: `nothing indexed matched ${params.specifier}`,
		};
		if (facts === null) return missing;
		const site = { containerId: undefined, offset: -1 };
		const name = segments.at(-1) as string;
		const whole = glob || segments.length === 1;
		const external = this.scopes.externalHead(facts, segments, site, absolute);
		if (external !== undefined) return { status: "external", packageName: external };
		const placed = this.scopes.place(facts, whole ? segments : segments.slice(0, -1), site, [], absolute);
		if (placed === undefined || placed === null) {
			// Through this file's own import of an outside crate, such as `extern crate` or the import itself.
			const head = segments[0] as string;
			const root: Place = { facts, path: [], kind: "module" };
			const crate = absolute || PATH_KEYWORDS.has(head) ? undefined : this.scopes.externalImport(root, head);
			return crate === undefined ? missing : { status: "external", packageName: crate };
		}
		if (
			!whole &&
			this.scopes.itemsIn(placed, name).length === 0 &&
			this.scopes.externalImport(placed, name) === undefined
		)
			return missing;
		const landing = this.landingAt(placed);
		return landing === undefined ? missing : { status: "resolved", landing };
	}

	/** A file module lands on its file; an inline module or a type on its own scope. */
	private landingAt(place: Place): Landing | undefined {
		const raw = place.raw;
		if (raw === undefined)
			return place.kind === "module" ? { kind: "module", module: place.facts.module } : undefined;
		if (raw.fileModule !== undefined) {
			const file = this.scopes.moduleFileName(place);
			return file === undefined ? undefined : { kind: "module", module: file };
		}
		const scopeId = raw.declaration.symbolId;
		return { kind: "symbolScope", providerId: PROVIDER_ID, scopeId, anchorSymbolId: scopeId };
	}

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

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) return this.typeOfSymbol(params.symbolId);
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknown("NotIndexed", "module is not indexed");
		const rawDeclaration = facts.rawDeclarations.find(
			(candidate) =>
				contains(candidate.declaration.selectionRange ?? candidate.declaration.range, params.range.start) ||
				contains(candidate.declaration.range, params.range.start),
		);
		if (rawDeclaration !== undefined) return this.typeAnswer(facts, rawDeclaration.declaration.symbolId);
		const rawReference = facts.rawReferences.find((candidate) =>
			contains(candidate.reference.range, params.range.start),
		);
		if (rawReference?.reference.binding.status === "bound")
			return this.typeOfSymbol(rawReference.reference.binding.symbolId);
		return unknown("NotImplemented", "no declared or literal type matches the requested range");
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "Rust rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("Rust move edits are not implemented");
	}

	importEdits(_params: ImportEditsRequest): ImportEditsResponse {
		return notImplementedImportEdits("Rust import planning is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("Rust arrange edits are not implemented");
	}

	private factsForModule(module: string): ParsedFile | null {
		return this.store.load(module) ?? null;
	}

	private wireReferences(facts: ParsedFile): Reference[] {
		return facts.rawReferences.map((raw) => ({ ...raw.reference, binding: this.bindingFor(facts, raw) }));
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

	private typeOfSymbol(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE)
			return unknown("ParseError", "the symbol id is not a Rust workspace id");
		const facts = this.factsForModule(parsed.module);
		if (facts === null) return unknown("NotIndexed", "the symbol id module is not indexed");
		return this.typeAnswer(facts, symbolId);
	}

	private typeAnswer(facts: ParsedFile, symbolId: string): TypeInfo {
		const answer = facts.typeAnswers.get(symbolId);
		if (answer === undefined)
			return unknown("NotImplemented", "no annotation or literal initializer establishes a type");
		if (answer.status === "unknown")
			return unknown(
				answer.reason ?? "NotImplemented",
				answer.detail ?? "type inference did not establish a type",
			);
		if (answer.status === "inferred")
			return {
				status: "inferred",
				display: answer.display ?? "unknown",
				basis: answer.basis ?? "literal initializer",
			};
		const display = answer.display ?? "unknown";
		const typeSymbol = answer.typeName === undefined ? undefined : this.resolveTypeSymbol(facts, answer.typeName);
		return {
			status: "known",
			display,
			...defined({ symbolId: typeSymbol }),
			provenance: "declared",
		};
	}

	private resolveTypeSymbol(facts: ParsedFile, name: string): string | undefined {
		if (
			[
				"bool",
				"char",
				"str",
				"u8",
				"u16",
				"u32",
				"u64",
				"u128",
				"usize",
				"i8",
				"i16",
				"i32",
				"i64",
				"i128",
				"isize",
				"f32",
				"f64",
				"Self",
				"self",
			].includes(name)
		)
			return undefined;
		const local = facts.rawDeclarations.find(
			(candidate) =>
				candidate.declaration.name === name &&
				["struct", "enum", "interface", "class"].includes(candidate.declaration.kind),
		);
		if (local !== undefined) return local.declaration.symbolId;
		const placed = this.scopes.place(facts, [name], { containerId: undefined, offset: -1 });
		return placed?.kind === "type" ? placed.raw?.declaration.symbolId : undefined;
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new RustProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new RustProvider()));
