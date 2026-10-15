import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { IncludeSearch } from "@nyaa-lexicon/formats/compile-commands";
import {
	type ArrangeEditsRequest,
	type Binding,
	DEFAULT_EXCLUDED_DIRECTORIES,
	type Declaration,
	defined,
	discoverByWalk,
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
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Range,
	type ReadPolicy,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
	type WorkMeter,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { type BindingSources, CBinding, containsStart } from "./binding.js";
import type { CDeclaration, ParsedCFile } from "./model.js";
import { parseC, typeInfoFor } from "./parser.js";
import {
	bareProject,
	type CProject,
	type CUnit,
	contextOf,
	discoverCProject,
	findInclude,
	forcedDirectories,
	type IncludeKind,
	type SearchContext,
	searchDirectories,
} from "./project.js";
import { agreed, createReach, headerName, includeImport, type ReachSources, resolutionOf } from "./reach.js";

////////////////////////////////
//  Constants

const LANGUAGE = "c";
const EXTENSIONS = [".c", ".h"];

const EXCLUDED_DIRECTORIES = {
	anywhere: [...DEFAULT_EXCLUDED_DIRECTORIES.anywhere, ".clangd", "CMakeFiles"],
	beside: DEFAULT_EXCLUDED_DIRECTORIES.beside.map((group) => ({ ...group, markers: ["CMakeLists.txt"] })),
};

const PROJECT_CONFIGS = ["CMakeLists.txt", "Makefile", "compile_commands.json", ".clang-format", ".clangd"];

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
} as const;

/** C11 keywords. Builtins are the standard fixed-width and size typedefs, never real keywords. */
export const WORDS = {
	keywords: [
		"_Alignas",
		"_Alignof",
		"_Atomic",
		"_BitInt",
		"_Bool",
		"_Complex",
		"_Decimal128",
		"_Decimal32",
		"_Decimal64",
		"_Generic",
		"_Imaginary",
		"_Noreturn",
		"_Static_assert",
		"_Thread_local",
		"auto",
		"break",
		"case",
		"char",
		"const",
		"continue",
		"default",
		"do",
		"double",
		"else",
		"enum",
		"extern",
		"float",
		"for",
		"goto",
		"if",
		"inline",
		"int",
		"long",
		"nullptr",
		"register",
		"restrict",
		"return",
		"short",
		"signed",
		"sizeof",
		"static",
		"struct",
		"switch",
		"typedef",
		"typeof",
		"typeof_unqual",
		"union",
		"unsigned",
		"void",
		"volatile",
		"while",
	],
	builtins: [
		"FILE",
		"bool",
		"int16_t",
		"int32_t",
		"int64_t",
		"int8_t",
		"intptr_t",
		"ptrdiff_t",
		"size_t",
		"ssize_t",
		"uint16_t",
		"uint32_t",
		"uint64_t",
		"uint8_t",
		"uintptr_t",
		"wchar_t",
	],
	literals: ["NULL", "false", "true"],
};

export const REFERENCE_ROLES = ["call", "read", "write", "import", "typeUse"] as const;

////////////////////////////////
//  Functions & Helpers

function fileRole(parsed: ParsedCFile): FileRole {
	const main = parsed.declarations.find(
		(declaration) => declaration.name === "main" && declaration.kind === "function" && declaration.isDefinition,
	);
	return main === undefined ? { kind: "library" } : { kind: "entry", how: "main", symbolId: main.symbolId };
}

function declarationWire(declaration: CDeclaration): Declaration {
	return {
		symbolId: declaration.symbolId,
		kind: declaration.kind,
		...defined({ languageKind: declaration.languageKind }),
		name: declaration.name,
		range: declaration.range,
		selectionRange: declaration.selectionRange,
		visibility: declaration.visibility,
		...defined({ exported: declaration.exported }),
		...defined({
			signature: declaration.signature,
			containerId: declaration.containerId,
			memberInsertLine: declaration.memberInsertLine,
			metrics: declaration.metrics,
		}),
	};
}

function discover(root: string, policy: ReadPolicy, scope?: string[]): { model: ProjectModel; project: CProject } {
	const failed = (message: string) => ({ model: projectDiagnostic(root, message), project: bareProject(root) });
	if (!existsSync(root)) return failed(`workspace root does not exist: ${root}`);
	try {
		if (!statSync(root).isDirectory()) return failed(`workspace root is not a directory: ${root}`);
		const model = discoverByWalk(root, {
			extensions: EXTENSIONS,
			excludedDirectories: EXCLUDED_DIRECTORIES,
			scope,
		});
		if (model.diagnostics.length > 0) return { model, project: bareProject(root) };
		const project = discoverCProject(root, EXCLUDED_DIRECTORIES, policy);
		const configs = PROJECT_CONFIGS.filter((name) => existsSync(path.join(root, name)));
		const scoped = scope === undefined ? undefined : new Set(scope);
		return {
			model: {
				...model,
				// A forced header in an excluded directory is reached by no include, so core learns it here.
				files: [...new Set([...model.files, ...project.forcedHeaders])].filter(
					(module) => scoped === undefined || scoped.has(module),
				),
				configFiles: [...new Set([...configs, ...project.databases])],
				diagnostics: [...project.diagnostics],
				fingerprint: project.fingerprint,
			},
			project,
		};
	} catch (error) {
		return failed(`unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`);
	}
}

////////////////////////////////
//  Classes

export class CProvider {
	/** Include lookup uses held facts. */
	readonly store = moduleStore<ParsedCFile, CProject>({ read: (module, text) => parseC(module, text) });

	/** `meter` counts header lookup work, so a test asserts its growth without a clock. */
	constructor(private readonly meter?: WorkMeter) {}

	initialize(_workspaceRoot: string) {
		return {
			providerId: "c-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			excludedDirectories: EXCLUDED_DIRECTORIES,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(
		workspaceRoot: string,
		_previous?: CProject,
		scope?: string[],
	): { model: ProjectModel; project: CProject } {
		return discover(path.resolve(workspaceRoot), this.store.policy, scope);
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		parsed: ParsedCFile,
	) {
		const bindingCache = new Map<string, Binding>();
		const binder = this.binding();
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: parsed.declarations.map(declarationWire),
			references: binder.references(params, parsed, bindingCache).references,
			imports: parsed.imports.map(includeImport),
			literals: parsed.literals,
			comments: parsed.comments,
			blankLines: parsed.blankLines,
			diagnostics: parsed.diagnostics,
			role: fileRole(parsed),
		};
	}

	private factsForModule(module: string): ParsedCFile | null {
		return this.store.load(module) ?? null;
	}

	private binding(): CBinding {
		const reached = createReach(this.reachSources());
		const sources: BindingSources = {
			factsForModule: (module) => this.factsForModule(module),
			resolveImport: (params) => this.resolveImport(params),
			reached,
		};
		return new CBinding(sources, this.meter);
	}

	private reachSources(): ReachSources {
		const store = this.store;
		return {
			store: {
				get project() {
					return store.project;
				},
				memo: (key, build) => store.memo(key, build),
			},
			...(this.meter === undefined ? {} : { meter: this.meter }),
			factsForModule: (module) => this.factsForModule(module),
			forcedIncludes: (module) => this.forcedIncludes(module),
			resolveInclude: (context, fromModule, name, kind) => this.resolveInclude(context, fromModule, name, kind),
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const clean = headerName(params.specifier);
		const delimited = params.specifier.startsWith("<")
			? "angle"
			: params.specifier.startsWith('"')
				? "quoted"
				: undefined;
		const context = contextOf(this.store.project, params.fromModule);
		if (delimited !== undefined) return this.resolveInclude(context, params.fromModule, clean, delimited);
		// A bare path takes the kind its held include was written with; written both ways, both must agree.
		const kinds = new Set(
			(this.store.peek(params.fromModule)?.imports ?? [])
				.filter((imported) => imported.specifier === clean)
				.map((imported) => imported.kind),
		);
		const answers = (kinds.size === 0 ? [undefined] : [...kinds]).map((kind) =>
			this.resolveInclude(context, params.fromModule, clean, kind),
		);
		return agreed(answers, `the include of ${clean} is written both ways and each finds a different header`);
	}

	/**
	 * `name` included from `fromModule`, searched with each of `context`'s lists: those of the units whose
	 * reach it is part of. An answer stands only where every list agrees. Searched on disk, so held for
	 * the store generation.
	 */
	private resolveInclude(
		context: SearchContext,
		fromModule: string,
		name: string,
		kind: IncludeKind | undefined,
	): ImportResolution {
		return this.store.memo(
			`\u0000include\u0000${context}\u0000${fromModule}\u0000${kind ?? ""}\u0000${name}`,
			() => {
				const project = this.store.project;
				const written = name.replace(/\\/gu, "/");
				const searched = (search: IncludeSearch | undefined) =>
					resolutionOf(
						findInclude(
							project.root,
							this.store.policy,
							searchDirectories(project, search, fromModule, kind ?? "quoted"),
							written,
						),
						name,
						kind,
					);
				if (context === "fallback") return searched(undefined);
				const answers = context.map((search) => searched(project.searches[search]));
				return agreed(answers, `the units find different headers for ${name}`);
			},
		);
	}

	/** The forced includes every database entry for `module` names and finds alike, in the first entry's order. */
	private forcedIncludes(module: string): Array<{ written: string; resolution: ImportResolution }> {
		const entries = (this.store.project.units.get(module) ?? []).map((unit) =>
			unit.forced.map((written) => ({ written, resolution: this.forcedInclude(unit, written) })),
		);
		return (entries[0] ?? []).filter((forced) =>
			entries.every((entry) => entry.some((other) => isDeepStrictEqual(other, forced))),
		);
	}

	/** A unit's forced include, looked for in its working directory, then along its quoted search. */
	private forcedInclude(unit: CUnit, name: string): ImportResolution {
		const project = this.store.project;
		const found = findInclude(project.root, this.store.policy, forcedDirectories(project, unit), name);
		return resolutionOf(found, name, "quoted");
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		return this.binding().bind(params);
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) {
			const parsed = parseSymbolId(params.symbolId);
			if (parsed === null || parsed.language !== LANGUAGE)
				return { status: "unknown", reason: "ParseError", detail: "the symbol id is not a C workspace id" };
			const facts = this.factsForModule(parsed.module);
			if (facts === null) return { status: "unknown", reason: "NotIndexed", detail: "module is not indexed" };
			if (!facts.declarations.some((declaration) => declaration.symbolId === params.symbolId))
				return { status: "unknown", reason: "NotIndexed", detail: "the symbol id has no indexed declaration" };
			return typeInfoFor(facts, params.symbolId);
		}
		const facts = this.factsForModule(params.module);
		if (facts === null) return { status: "unknown", reason: "NotIndexed", detail: "module is not indexed" };
		const declaration =
			facts.declarations.find(
				(candidate) =>
					candidate.typeRange !== undefined && containsStart(candidate.typeRange, params.range.start),
			) ??
			facts.declarations.find((candidate) =>
				containsStart(candidate.selectionRange ?? candidate.range, params.range.start),
			);
		if (declaration === undefined)
			return {
				status: "unknown",
				reason: "NotIndexed",
				detail: "no indexed declaration or type range matched the requested range",
			};
		return typeInfoFor(facts, declaration.symbolId);
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C move edits are not implemented" };
	}

	importEdits(_params: ImportEditsRequest): ImportEditsResponse {
		return notImplementedImportEdits("C import planning is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("C arrange edits are not implemented");
	}
}

////////////////////////////////
//  Functions & Helpers

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new CProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new CProvider()));
