import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	DEFAULT_EXCLUDED_DIRECTORIES,
	type Declaration,
	defined,
	discoverByWalk,
	type FileRole,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Range,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
	type UnknownReason,
	workspaceFile,
	workspaceModule,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import {
	bindingCandidates,
	type CDeclaration,
	type CReference,
	type ParsedCFile,
	parseC,
	rangeContains,
	typeInfoFor,
} from "./parser.js";

const LANGUAGE = "c";
const EXTENSIONS = [".c", ".h"];

const EXCLUDED_DIRECTORIES = new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ".clangd", "CMakeFiles"]);

const PROJECT_CONFIGS = ["CMakeLists.txt", "Makefile", "compile_commands.json", ".clang-format", ".clangd"];

const COMMON_HEADERS = new Set([
	"assert.h",
	"complex.h",
	"ctype.h",
	"errno.h",
	"fcntl.h",
	"inttypes.h",
	"limits.h",
	"math.h",
	"memory.h",
	"pthread.h",
	"setjmp.h",
	"signal.h",
	"stdarg.h",
	"stdbool.h",
	"stddef.h",
	"stdint.h",
	"stdio.h",
	"stdlib.h",
	"string.h",
	"sys/types.h",
	"time.h",
	"unistd.h",
	"wchar.h",
	"windows.h",
]);

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

function containsStart(range: Range, position: Range["start"]): boolean {
	return rangeContains(range, position);
}

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
			metrics: declaration.metrics,
		}),
	};
}

function referenceWire(reference: CReference, binding: Binding): Reference {
	return {
		name: reference.name,
		range: reference.range,
		role: reference.role,
		binding,
		...defined({ fromId: reference.fromId }),
	};
}

function unknownBinding(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function conditionalAmbiguity(candidates: CDeclaration[]): Binding {
	return {
		status: "ambiguous",
		candidates: candidates.map((candidate) => candidate.symbolId),
		provenance: "bound",
		...({ detail: "conditional compilation supplies both declarations" } as object),
	} as Binding;
}

function ordinaryAmbiguity(candidates: CDeclaration[]): Binding {
	return {
		status: "ambiguous",
		candidates: candidates.map((candidate) => candidate.symbolId),
		provenance: "bound",
	} as Binding;
}

function headerName(specifier: string): string {
	if (
		(specifier.startsWith("<") && specifier.endsWith(">")) ||
		(specifier.startsWith('"') && specifier.endsWith('"'))
	) {
		return specifier.slice(1, -1);
	}
	return specifier;
}

function importCandidates(root: string, fromModule: string, specifier: string): string[] {
	const clean = headerName(specifier).replace(/\\/gu, "/");
	const fromAbsolute = workspaceFile(root, fromModule);
	const directories = fromAbsolute === null ? [] : [path.dirname(fromAbsolute), root];
	const candidates: string[] = [];
	for (const directory of directories) {
		const absolute = path.resolve(directory, clean);
		const module = workspaceModule(root, absolute);
		if (module === null) continue;
		candidates.push(module);
		if (path.extname(clean) === "") {
			candidates.push(`${module}.h`, `${module}.c`);
		}
	}
	return candidates;
}

function hasFile(root: string, module: string): boolean {
	const absolute = workspaceFile(root, module);
	return absolute !== null && existsSync(absolute) && statSync(absolute).isFile();
}

function pathForResolution(root: string, candidates: string[]): string | undefined {
	return candidates.find((candidate) => hasFile(root, candidate));
}

function discover(root: string): ProjectModel {
	if (!existsSync(root)) return projectDiagnostic(root, `workspace root does not exist: ${root}`);
	try {
		if (!statSync(root).isDirectory()) return projectDiagnostic(root, `workspace root is not a directory: ${root}`);
		const model = discoverByWalk(root, { extensions: EXTENSIONS, excludedDirectories: EXCLUDED_DIRECTORIES });
		const configFiles = PROJECT_CONFIGS.filter((name) => existsSync(path.join(root, name)));
		return model.diagnostics.length === 0 ? { ...model, configFiles } : model;
	} catch (error) {
		return projectDiagnostic(
			root,
			`unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export class CProvider {
	/** Include lookup uses held facts. */
	readonly store = moduleStore<ParsedCFile>({ read: (module, text) => parseC(module, text) });

	initialize(_workspaceRoot: string) {
		return {
			providerId: "c-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string): { model: ProjectModel; project: null } {
		return { model: discover(path.resolve(workspaceRoot)), project: null };
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		parsed: ParsedCFile,
	) {
		const bindingCache = new Map<string, Binding>();
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: parsed.declarations.map(declarationWire),
			references: parsed.references.map((reference) =>
				referenceWire(reference, this.bindingForReference(params.module, parsed, reference, bindingCache)),
			),
			imports: parsed.imports.map(({ specifier, imported, reExport }) => ({
				specifier,
				imported,
				reExport,
			})),
			literals: parsed.literals,
			comments: parsed.comments,
			diagnostics: parsed.diagnostics,
			role: fileRole(parsed),
		};
	}

	private factsForModule(module: string): ParsedCFile | null {
		return this.store.load(module) ?? null;
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const clean = headerName(params.specifier);
		// Use held import kind; infer from "<" otherwise.
		const written = this.store
			.peek(params.fromModule)
			?.imports.find((imported) => imported.specifier === clean || imported.specifier === params.specifier);
		const kind = written?.kind ?? (params.specifier.startsWith("<") ? "angle" : undefined);
		if (kind === "angle") return { status: "external", packageName: clean };
		const root = this.store.root;
		const resolved = pathForResolution(root, importCandidates(root, params.fromModule, clean));
		if (resolved !== undefined) return { status: "resolved", module: resolved };
		if (kind === "quoted")
			return { status: "unresolved", reason: "NotIndexed", detail: `no workspace header matches ${clean}` };
		if (
			COMMON_HEADERS.has(clean) ||
			clean.startsWith("sys/") ||
			clean.startsWith("linux/") ||
			clean.startsWith("windows/")
		) {
			return { status: "external", packageName: clean };
		}
		return { status: "unresolved", reason: "NotIndexed", detail: `no workspace header matches ${clean}` };
	}

	private bindingForReference(
		module: string,
		facts: ParsedCFile,
		reference: CReference,
		cache: Map<string, Binding>,
	): Binding {
		const cacheKey = `${reference.name}\u0000${reference.role}\u0000${reference.fromId ?? ""}`;
		const cached = cache.get(cacheKey);
		if (cached !== undefined) return cached;
		const result = this.bindingForReferenceUncached(module, facts, reference);
		cache.set(cacheKey, result);
		return result;
	}

	private bindingForReferenceUncached(module: string, facts: ParsedCFile, reference: CReference): Binding {
		if (reference.role === "import") {
			const resolution = this.resolveImport({ fromModule: module, specifier: reference.name });
			if (resolution.status === "external")
				return unknownBinding("ExternalDependency", "the included header is outside the workspace");
			if (resolution.status === "unresolved")
				return unknownBinding(resolution.reason, resolution.detail ?? "the included header is unresolved");
			return unknownBinding("NotIndexed", "an include path does not name a declaration");
		}
		const sameFile = bindingCandidates(facts, reference);
		if (sameFile.length === 1)
			return { status: "bound", symbolId: (sameFile[0] as CDeclaration).symbolId, provenance: "bound" };
		if (sameFile.length > 1) {
			const conditional = sameFile.some((candidate) => candidate.conditionalGroup !== "");
			return conditional ? conditionalAmbiguity(sameFile) : ordinaryAmbiguity(sameFile);
		}
		const imported = this.crossFileCandidates(module, facts, reference.name);
		if (imported.candidates.length === 1)
			return {
				status: "bound",
				symbolId: (imported.candidates[0] as CDeclaration).symbolId,
				provenance: "bound",
			};
		if (imported.candidates.length > 1) return ordinaryAmbiguity(imported.candidates);
		if (imported.external)
			return unknownBinding(
				"ExternalDependency",
				`no indexed declaration for ${reference.name} was found in an external header`,
			);
		if (imported.reason !== undefined)
			return unknownBinding(imported.reason, imported.detail ?? "the imported declaration is unresolved");
		return unknownBinding("NotIndexed", `no C declaration matches ${reference.name}`);
	}

	private crossFileCandidates(
		module: string,
		facts: ParsedCFile,
		name: string,
	): { candidates: CDeclaration[]; external: boolean; reason?: UnknownReason; detail?: string } {
		const candidates: CDeclaration[] = [];
		let external = false;
		let reason: UnknownReason | undefined;
		let detail: string | undefined;
		for (const imported of facts.imports) {
			const resolution = this.resolveImport({ fromModule: module, specifier: imported.specifier });
			if (resolution.status === "external") {
				external = true;
				continue;
			}
			if (resolution.status === "unresolved") {
				reason = resolution.reason;
				detail = resolution.detail;
				continue;
			}
			const target = this.factsForModule(resolution.module);
			if (target === null) {
				reason = "NotIndexed";
				detail = `the included module ${resolution.module} is not indexed`;
				continue;
			}
			for (const declaration of target.declarationsByName.get(name) ?? []) {
				if (
					declaration.name === name &&
					declaration.containerId === undefined &&
					declaration.exported !== false
				)
					candidates.push(declaration);
			}
		}
		return {
			candidates,
			external,
			...defined({ reason, detail }),
		};
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknownBinding("NotIndexed", "module is not indexed");
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && containsStart(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(params.module, facts, reference, new Map());
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				containsStart(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return unknownBinding("NotIndexed", "no indexed reference or declaration matched the requested range");
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
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new CProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new CProvider()));
