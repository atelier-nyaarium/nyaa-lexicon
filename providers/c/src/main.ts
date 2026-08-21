import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	type Declaration,
	type Diagnostic,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	PROTOCOL_VERSION,
	type ProjectModel,
	type ProviderHandlers,
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

const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".clangd",
	".venv",
	"CMakeFiles",
	"build",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor-cache",
]);

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
} as const;

export const REFERENCE_ROLES = ["call", "read", "write", "import", "typeUse"] as const;

interface StoredFacts {
	contentHash: string;
	parsed: ParsedCFile;
}

function modulePath(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).replace(/\\/gu, "/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	return relative;
}

function projectDiagnostic(root: string, message: string): ProjectModel {
	return {
		files: [],
		externalRoots: [],
		configFiles: [],
		diagnostics: [{ severity: "error", message, path: root }],
	};
}

function walkCFiles(root: string): string[] {
	const files: string[] = [];
	function visit(directory: string): void {
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true, encoding: "utf8" })) {
				if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
				const absolute = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					visit(absolute);
					continue;
				}
				if (!entry.isFile() || (!entry.name.endsWith(".c") && !entry.name.endsWith(".h"))) continue;
				const module = modulePath(root, absolute);
				if (module !== null) files.push(module);
			}
		} catch {
			return;
		}
	}
	visit(root);
	return files.sort();
}

function safeWorkspacePath(root: string, module: string): string | null {
	const absolute = path.resolve(root, ...module.replace(/\\/gu, "/").split("/"));
	const relative = path.relative(root, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return absolute;
}

function containsStart(range: Range, position: Range["start"]): boolean {
	return rangeContains(range, position);
}

function declarationWire(declaration: CDeclaration): Declaration {
	return {
		symbolId: declaration.symbolId,
		kind: declaration.kind,
		...(declaration.languageKind === undefined ? {} : { languageKind: declaration.languageKind }),
		name: declaration.name,
		range: declaration.range,
		selectionRange: declaration.selectionRange,
		visibility: declaration.visibility,
		...(declaration.exported === undefined ? {} : { exported: declaration.exported }),
		...(declaration.signature === undefined ? {} : { signature: declaration.signature }),
		...(declaration.containerId === undefined ? {} : { containerId: declaration.containerId }),
		...(declaration.metrics === undefined ? {} : { metrics: declaration.metrics }),
	};
}

function referenceWire(reference: CReference, binding: Binding): Reference {
	return {
		name: reference.name,
		range: reference.range,
		role: reference.role,
		binding,
		...(reference.fromId === undefined ? {} : { fromId: reference.fromId }),
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

function importKey(module: string, specifier: string): string {
	return `${module}\u0000${specifier}`;
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
	const fromAbsolute = safeWorkspacePath(root, fromModule);
	const directories = fromAbsolute === null ? [] : [path.dirname(fromAbsolute), root];
	const candidates: string[] = [];
	for (const directory of directories) {
		const absolute = path.resolve(directory, clean);
		const module = modulePath(root, absolute);
		if (module === null) continue;
		candidates.push(module);
		if (path.extname(clean) === "") {
			candidates.push(`${module}.h`, `${module}.c`);
		}
	}
	return candidates;
}

function hasFile(root: string, module: string): boolean {
	const absolute = safeWorkspacePath(root, module);
	return absolute !== null && existsSync(absolute) && statSync(absolute).isFile();
}

function pathForResolution(root: string, candidates: string[]): string | undefined {
	return candidates.find((candidate) => hasFile(root, candidate));
}

function diagnosticForRead(module: string, error: unknown): Diagnostic {
	const detail = error instanceof Error ? error.message : String(error);
	return { severity: "error", message: `unable to read ${module}: ${detail}`, path: module };
}

export class CProvider {
	private workspaceRoot = process.cwd();
	private readonly facts = new Map<string, StoredFacts>();
	private readonly includeKinds = new Map<string, "quoted" | "angle">();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.facts.clear();
		this.includeKinds.clear();
		return {
			providerId: "c-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.facts.clear();
		this.includeKinds.clear();
		if (!existsSync(this.workspaceRoot))
			return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
		try {
			if (!statSync(this.workspaceRoot).isDirectory())
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			const configFiles = PROJECT_CONFIGS.filter((name) => existsSync(path.join(this.workspaceRoot, name)));
			return { files: walkCFiles(this.workspaceRoot), externalRoots: [], configFiles, diagnostics: [] };
		} catch (error) {
			return projectDiagnostic(
				this.workspaceRoot,
				`unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const stored = this.parseAndStore(params.module, params.contentHash, params.text);
		const bindingCache = new Map<string, Binding>();
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: stored.parsed.declarations.map(declarationWire),
			references: stored.parsed.references.map((reference) =>
				referenceWire(
					reference,
					this.bindingForReference(params.module, stored.parsed, reference, bindingCache),
				),
			),
			imports: stored.parsed.imports.map(({ specifier, imported, reExport }) => ({
				specifier,
				imported,
				reExport,
			})),
			literals: stored.parsed.literals,
			comments: stored.parsed.comments,
			diagnostics: stored.parsed.diagnostics,
		};
	}

	private parseAndStore(module: string, contentHash: string, text: string): StoredFacts {
		const parsed = parseC(module, text);
		const stored = { contentHash, parsed };
		this.facts.set(module, stored);
		for (const imported of parsed.imports)
			this.includeKinds.set(importKey(module, imported.specifier), imported.kind);
		return stored;
	}

	private factsForModule(module: string): StoredFacts | null {
		const cached = this.facts.get(module);
		if (cached !== undefined) return cached;
		const absolute = safeWorkspacePath(this.workspaceRoot, module);
		if (absolute === null || !existsSync(absolute) || !statSync(absolute).isFile()) return null;
		try {
			return this.parseAndStore(module, "disk", readFileSync(absolute, "utf8"));
		} catch (error) {
			const parsed: ParsedCFile = {
				module,
				declarations: [],
				declarationsByName: new Map(),
				declarationsById: new Map(),
				references: [],
				imports: [],
				literals: [],
				comments: [],
				diagnostics: [diagnosticForRead(module, error)],
				typeAnswers: new Map(),
			};
			const stored = { contentHash: "disk", parsed };
			this.facts.set(module, stored);
			return stored;
		}
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const clean = headerName(params.specifier);
		const kind =
			this.includeKinds.get(importKey(params.fromModule, clean)) ??
			this.includeKinds.get(importKey(params.fromModule, params.specifier)) ??
			(params.specifier.startsWith("<") ? "angle" : undefined);
		if (kind === "angle") return { status: "external", packageName: clean };
		const resolved = pathForResolution(
			this.workspaceRoot,
			importCandidates(this.workspaceRoot, params.fromModule, clean),
		);
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
			for (const declaration of target.parsed.declarationsByName.get(name) ?? []) {
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
			...(reason === undefined ? {} : { reason }),
			...(detail === undefined ? {} : { detail }),
		};
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const stored = this.factsForModule(params.module);
		if (stored === null) return unknownBinding("NotIndexed", "module is not indexed");
		const reference = stored.parsed.references.find(
			(candidate) => candidate.name === params.name && containsStart(candidate.range, params.range.start),
		);
		if (reference !== undefined)
			return this.bindingForReference(params.module, stored.parsed, reference, new Map());
		const declaration = stored.parsed.declarations.find(
			(candidate) =>
				candidate.name === params.name && containsStart(candidate.selectionRange, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return unknownBinding("NotIndexed", "no indexed reference or declaration matched the requested range");
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) {
			const parsed = parseSymbolId(params.symbolId);
			if (parsed === null || parsed.language !== LANGUAGE)
				return { status: "unknown", reason: "ParseError", detail: "the symbol id is not a C workspace id" };
			const stored = this.factsForModule(parsed.module);
			if (stored === null) return { status: "unknown", reason: "NotIndexed", detail: "module is not indexed" };
			if (!stored.parsed.declarations.some((declaration) => declaration.symbolId === params.symbolId))
				return { status: "unknown", reason: "NotIndexed", detail: "the symbol id has no indexed declaration" };
			return typeInfoFor(stored.parsed, params.symbolId);
		}
		const stored = this.factsForModule(params.module);
		if (stored === null) return { status: "unknown", reason: "NotIndexed", detail: "module is not indexed" };
		const declaration =
			stored.parsed.declarations.find(
				(candidate) =>
					candidate.typeRange !== undefined && containsStart(candidate.typeRange, params.range.start),
			) ??
			stored.parsed.declarations.find((candidate) => containsStart(candidate.selectionRange, params.range.start));
		if (declaration === undefined)
			return {
				status: "unknown",
				reason: "NotIndexed",
				detail: "no indexed declaration or type range matched the requested range",
			};
		return typeInfoFor(stored.parsed, declaration.symbolId);
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C move edits are not implemented" };
	}
}

export function handlersFor(provider: CProvider): ProviderHandlers {
	return {
		initialize: (params) => provider.initialize(params.workspaceRoot),
		discoverProject: (params) => provider.discoverProject(params.workspaceRoot),
		parseFile: (params) => provider.parseFile(params),
		resolveImport: (params) => provider.resolveImport(params),
		bind: (params) => provider.bind(params),
		typeOf: (params) => provider.typeOf(params),
		renameEdits: (params) => provider.renameEdits(params),
		moveEdits: (params) => provider.moveEdits(params),
		shutdown: () => ({}),
	};
}

export { serveProvider };

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new CProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new CProvider()));
