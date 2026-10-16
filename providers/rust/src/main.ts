import { SECRET_READERS } from "@nyaa-lexicon/formats/secret";
import {
	type ArrangeEditsRequest,
	type Binding,
	type Declaration,
	type Diagnostic,
	defined,
	type FileRole,
	handlersFor,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
	notImplementedImportEdits,
	notImplementedMove,
	notImplementedRenameEdits,
	PROTOCOL_VERSION,
	type ProjectModel,
	type Range,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import type { ParsedFile, RawReference } from "./model.js";
import { parseRustFile } from "./parser.js";
import {
	discoverRustProject,
	EXCLUDED_DIRECTORIES,
	isModRs,
	moduleFileOf,
	type RustEntry,
	RustProjectResolver,
	type RustProjectState,
} from "./project.js";
import { RustBindingQueryService } from "./queries/bindings.js";
import { LANGUAGE, PROVIDER_ID, type RustQueryContext } from "./queries/context.js";
import { RustImportQueryService } from "./queries/imports.js";
import { RustTypeQueryService } from "./queries/types.js";
import { ScopeResolver, samePath } from "./scopes.js";
import { WORDS } from "./vocabulary.js";

export { LANGUAGE, PROVIDER_ID } from "./queries/context.js";
export { WORDS } from "./vocabulary.js";

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

/** Targets whose `main` something runs. */
const EXECUTABLES: ReadonlySet<string> = new Set(["bin", "example", "build"]);

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
	private readonly importQueries = new RustImportQueryService(this.queryContext());
	private readonly bindingQueries = new RustBindingQueryService(this.queryContext());
	private readonly typeQueries = new RustTypeQueryService(this.queryContext());

	private queryContext(): RustQueryContext {
		return {
			factsForModule: (module) => this.factsForModule(module),
			resolver: this.resolver,
			scopes: this.scopes,
		};
	}

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

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		return this.importQueries.resolveImport(params);
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		return this.bindingQueries.bind(params);
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		return this.typeQueries.typeOf(params);
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return notImplementedRenameEdits("Rust rename edits are not implemented");
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
		return this.bindingQueries.referenceBinding(facts, raw);
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new RustProvider()): void {
	serveProvider(connection, handlersFor(provider, SECRET_READERS));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new RustProvider(), SECRET_READERS));
