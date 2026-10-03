import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	asyncModuleStore,
	type Binding,
	comparePositions,
	defined,
	discoverByWalk,
	type FileFacts,
	handlersFor,
	type ImportResolution,
	type MoveEditsRequest,
	type MoveEditsResponse,
	notImplementedImport,
	PROTOCOL_VERSION,
	type ProbeBatchRequest,
	type ProbeBatchResponse,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	sameRange,
	serveProvider,
	type TypeInfo,
	type UnknownReason,
	workspaceFile,
	workspaceModule,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { makeArrangeEdits } from "./arrange";
import { Binder, type Resolution } from "./binding";
import { extractFacts } from "./facts/extract";
import { renameEdits } from "./facts/rename";
import type { Range, RawTypeReference } from "./facts/types";
import { LANGUAGE, type MappedFacts, mapFacts, type TypeAnswer } from "./mapped";
import { isValidTargetModule, makeMoveEdits } from "./move";
import { Python3Dispatch } from "./python3";
import { wireAllList, wireImports } from "./wiring";

//////// Constants

const EXTENSIONS = [".py"];
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".mypy_cache",
	".pytest_cache",
	".venv",
	"__pycache__",
	"build",
	"dist",
	"node_modules",
	"venv",
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
	exports: true,
	renameKeep: true,
} as const;

/** Python 3.12 hard and soft keywords (`keyword.kwlist` and `keyword.softkwlist`), merged. */
export const WORDS = {
	keywords: [
		"_",
		"and",
		"as",
		"assert",
		"async",
		"await",
		"break",
		"case",
		"class",
		"continue",
		"def",
		"del",
		"elif",
		"else",
		"except",
		"finally",
		"for",
		"from",
		"global",
		"if",
		"import",
		"in",
		"is",
		"lambda",
		"match",
		"nonlocal",
		"not",
		"or",
		"pass",
		"raise",
		"return",
		"try",
		"type",
		"while",
		"with",
		"yield",
	],
	builtins: [
		"bool",
		"bytearray",
		"bytes",
		"complex",
		"dict",
		"float",
		"frozenset",
		"int",
		"list",
		"object",
		"set",
		"str",
		"tuple",
	],
	literals: ["False", "None", "True"],
};

export const REFERENCE_ROLES = ["call", "read", "write", "extends", "typeUse"] as const;

//////// Helpers

/** The directories a module sits in, outermost first. */
function directoriesOf(module: string): string[] {
	const parts = module.replace(/\\/g, "/").split("/");
	parts.pop();
	return parts;
}

/** Null when a relative specifier climbs above the workspace root. */
function importParts(fromModule: string, specifier: string): string[] | null {
	const fromParts = directoriesOf(fromModule);
	if (!specifier.startsWith(".")) return specifier.split(".").filter(Boolean);
	const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
	const remainder = specifier.slice(dots).replace(/^\/+/, "");
	const levels = Math.max(0, dots - 1);
	if (levels > fromParts.length) return null;
	const base = fromParts.slice(0, fromParts.length - levels);
	return [...base, ...remainder.split(/[/.]/).filter(Boolean)];
}

/**
 * Modules the parts name, in Python's order: a package before a module, then stubs. One the store
 * shows counts though not yet on disk.
 */
function moduleCandidates(root: string, parts: string[], shown: ReadonlySet<string>): string[] {
	const relative = parts.join("/");
	return existingModules(
		root,
		[`${relative}/__init__.py`, `${relative}.py`, `${relative}/__init__.pyi`, `${relative}.pyi`],
		shown,
	);
}

/** A module at the workspace root has a parent package only when the root holds an `__init__`. */
function hasParentPackage(root: string, fromModule: string, shown: ReadonlySet<string>): boolean {
	if (directoriesOf(fromModule).length > 0) return true;
	return existingModules(root, ["__init__.py", "__init__.pyi"], shown).length > 0;
}

function existingModules(root: string, candidates: readonly string[], shown: ReadonlySet<string>): string[] {
	return candidates.flatMap((candidate) => {
		const file = workspaceFile(root, candidate);
		if (file === null) return [];
		const module = workspaceModule(root, file);
		if (module === null) return [];
		return shown.has(module) || (existsSync(file) && statSync(file).isFile()) ? [module] : [];
	});
}

function packageNameOf(specifier: string): string {
	return specifier.split(".").filter(Boolean)[0] ?? specifier;
}

interface PythonStdlibResponse {
	available: boolean;
	names: unknown[];
}

interface PythonModuleResponse {
	available: boolean;
	found: boolean;
}

async function pythonStdlibModuleNames(python3: Python3Dispatch): Promise<Set<string> | null> {
	const parsed = await python3.runJson<PythonStdlibResponse>(
		[
			"-c",
			"import json, sys; print(json.dumps({'available': hasattr(sys, 'stdlib_module_names'), 'names': sorted(getattr(sys, 'stdlib_module_names', ())) }))",
		],
		{},
		"stdlib-module-names",
	);
	if (
		parsed === null ||
		!parsed.available ||
		!Array.isArray(parsed.names) ||
		!parsed.names.every((name) => typeof name === "string")
	)
		return null;
	return new Set(parsed.names as string[]);
}

async function pythonModuleAvailable(python3: Python3Dispatch, moduleName: string): Promise<boolean | null> {
	const parsed = await python3.runJson<PythonModuleResponse>(
		[
			"-c",
			"import importlib.util, json, sys; name = sys.argv[1];\ntry:\n    found = importlib.util.find_spec(name) is not None\nexcept (ImportError, ModuleNotFoundError, ValueError):\n    found = False\nprint(json.dumps({'available': True, 'found': found}))",
			moduleName,
		],
		{},
		`module-availability:${moduleName}`,
	);
	if (parsed === null || parsed.available !== true || typeof parsed.found !== "boolean") return null;
	return parsed.found;
}

function externalPackageExists(root: string, specifier: string): boolean {
	const parts = specifier.split(".").filter(Boolean);
	if (parts.length === 0) return false;
	const packageParts = specifier.startsWith(".") ? parts : parts.slice(0, 1);
	const roots = [
		["site-packages"],
		[".venv", "lib", "python3.12", "site-packages"],
		["venv", "lib", "python3.12", "site-packages"],
	];
	return roots.some((rootParts) => {
		const packageRoot = workspaceFile(root, [...rootParts, ...packageParts].join("/"));
		return packageRoot !== null && existsSync(packageRoot);
	});
}

// Inclusive at both ends.
function containsPosition(range: Range, position: Range["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

//////// Provider

export class PythonProvider {
	readonly store;

	constructor(private readonly python3 = new Python3Dispatch()) {
		this.store = asyncModuleStore<MappedFacts>({
			read: async (module, text) => mapFacts(module, text, extractFacts(module, text)),
		});
	}

	initialize(_workspaceRoot: string) {
		return {
			providerId: "python-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string): { model: ProjectModel; project: null } {
		const root = path.resolve(workspaceRoot);
		try {
			if (!existsSync(root)) {
				return { model: projectDiagnostic(root, `workspace root does not exist: ${root}`), project: null };
			}
			if (!statSync(root).isDirectory()) {
				return {
					model: projectDiagnostic(root, `workspace root is not a directory: ${root}`),
					project: null,
				};
			}
			return {
				model: {
					files: discoverByWalk(root, {
						extensions: EXTENSIONS,
						excludedDirectories: EXCLUDED_DIRECTORIES,
					}).files,
					externalRoots: [],
					configFiles: [],
					diagnostics: [],
				},
				project: null,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { model: projectDiagnostic(root, `unable to inspect workspace root: ${detail}`), project: null };
		}
	}

	async parseFile(
		params: { module: string; contentHash: string; text: string },
		facts: MappedFacts,
	): Promise<FileFacts> {
		const binder = this.binder();
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: await this.wireReferences(params.module, facts, binder),
			role: facts.role,
			imports: await wireImports(params.module, facts, binder),
			...defined({ exports: facts.exports, allList: await wireAllList(params.module, facts, binder) }),
			literals: facts.literals,
			comments: facts.comments,
			...defined({ blankLines: facts.blankLines }),
			diagnostics: facts.diagnostics,
		};
	}

	/** Every proposed text read as one view, as the store shows it while the batch is open. */
	async probeBatch(params: ProbeBatchRequest): Promise<ProbeBatchResponse> {
		const proposed = new Map(params.files.map((file) => [file.module, file.contentHash]));
		const facts: FileFacts[] = [];
		for (const module of params.answer) {
			const held = await this.store.text(module);
			const value = await this.store.load(module);
			if (held === undefined || value === undefined) {
				return { status: "unsupported", detail: `${module} is neither proposed nor held` };
			}
			const contentHash = proposed.get(module) ?? held.contentHash;
			facts.push(await this.parseFile({ module, contentHash, text: held.text }, value));
		}
		const asked = new Map<string, { module: string; specifier: string }>();
		for (const each of facts) {
			for (const { specifier } of each.imports) {
				asked.set(JSON.stringify([each.module, specifier]), { module: each.module, specifier });
			}
		}
		const landings = await Promise.all(
			[...asked.values()].map(async ({ module, specifier }) => ({
				module,
				specifier,
				resolution: await this.resolveImport({ fromModule: module, specifier }),
			})),
		);
		return { status: "ready", facts, landings };
	}

	private async factsForModule(module: string): Promise<MappedFacts | null> {
		return (await this.store.load(module)) ?? null;
	}

	private binder(): Binder {
		return new Binder({
			load: (module) => this.factsForModule(module),
			resolve: (fromModule, specifier) => this.resolveImport({ fromModule, specifier }),
		});
	}

	private async wireReferences(module: string, facts: MappedFacts, binder: Binder): Promise<Reference[]> {
		return Promise.all(
			facts.references.map(async (reference) => {
				const { binding, origin } = await binder.resolve(module, facts, reference);
				return { ...reference, binding, ...defined({ origin }) };
			}),
		);
	}

	private async typeSymbolForReference(
		module: string,
		facts: MappedFacts,
		target: RawTypeReference,
	): Promise<string | undefined> {
		const matches = facts.references.filter(
			(reference) =>
				reference.name === target.name &&
				reference.role === target.role &&
				sameRange(reference.range, target.range),
		);
		if (matches.length !== 1) return undefined;
		const reference = matches[0];
		if (reference === undefined) return undefined;
		const { binding } = await this.resolution(module, facts, reference);
		return binding.status === "bound" ? binding.symbolId : undefined;
	}

	private resolution(module: string, facts: MappedFacts, reference: Reference): Promise<Resolution> {
		return this.binder().resolve(module, facts, reference);
	}

	async resolveImport(params: { fromModule: string; specifier: string }): Promise<ImportResolution> {
		const root = this.store.root;
		const shown = new Set(this.store.modules());
		if (params.specifier.startsWith(".") && !hasParentPackage(root, params.fromModule, shown)) {
			return {
				status: "unresolved" as const,
				reason: "BrokenImport" as const,
				detail: "a relative import needs a parent package, and this module is in none",
			};
		}
		const parts = importParts(params.fromModule, params.specifier);
		if (parts === null) {
			return {
				status: "unresolved" as const,
				reason: "ExternalDependency" as const,
				detail: "the relative import climbs above the workspace root",
			};
		}
		const module = moduleCandidates(root, parts, shown)[0];
		if (module !== undefined) return { status: "resolved" as const, landing: { kind: "module" as const, module } };
		if (!params.specifier.startsWith(".")) {
			const packageName = packageNameOf(params.specifier);
			const stdlibModuleNames = await pythonStdlibModuleNames(this.python3);
			if (stdlibModuleNames === null) {
				return notImplementedImport(this.python3.unavailableDetail);
			}
			if (stdlibModuleNames.has(packageName) || externalPackageExists(root, params.specifier)) {
				return { status: "external" as const, packageName };
			}
			const moduleAvailable = await pythonModuleAvailable(this.python3, packageName);
			if (moduleAvailable === null) return notImplementedImport(this.python3.unavailableDetail);
			if (moduleAvailable) return { status: "external" as const, packageName };
		}
		const relative = params.specifier.startsWith(".");
		return {
			status: "unresolved" as const,
			reason: relative ? ("RuntimeConstructed" as const) : ("ExternalDependency" as const),
			detail: relative
				? "no workspace module matched the relative specifier"
				: `${packageNameOf(params.specifier)} is outside the indexed workspace`,
		};
	}

	async bind(params: { module: string; name: string; range: Range }): Promise<Binding> {
		const facts = await this.factsForModule(params.module);
		if (facts === null) {
			return { status: "unbound" as const, reason: "NotIndexed" as const, detail: "module is not indexed" };
		}
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && containsPosition(candidate.range, params.range.start),
		);
		if (reference !== undefined) return (await this.resolution(params.module, facts, reference)).binding;
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				// Every declaration this provider extracts has its name in the source.
				containsPosition(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) {
			return { status: "bound" as const, symbolId: declaration.symbolId, provenance: "bound" as const };
		}
		return {
			status: "unbound" as const,
			reason: "NotIndexed" as const,
			detail: "no indexed reference or declaration matched the requested range",
		};
	}

	async typeOf(params: { symbolId: string } | { module: string; range: Range }): Promise<TypeInfo> {
		if ("symbolId" in params) {
			const parsed = parseSymbolId(params.symbolId);
			if (parsed === null || parsed.language !== LANGUAGE) {
				return {
					status: "unknown",
					reason: "ParseError",
					detail: "the symbol id is not a Python workspace id",
				};
			}
			const facts = await this.factsForModule(parsed.module);
			if (facts === null) return unknownType("NotIndexed", "module is not indexed");
			const answer = facts.typeAnswers.get(params.symbolId);
			return answer === undefined
				? unknownAnnotationType()
				: await typeOfAnswer(answer, (reference) =>
						this.typeSymbolForReference(parsed.module, facts, reference),
					);
		}

		const facts = await this.factsForModule(params.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");
		const matches = facts.typeAnnotations.filter(
			(annotation) =>
				containsPosition(annotation.anchorRange, params.range.start) ||
				containsPosition(annotation.annotationRange, params.range.start),
		);
		if (matches.length > 1) return unknownType("Ambiguous", "the range matches several annotations");
		const annotation = matches[0];
		return annotation === undefined
			? unknownAnnotationType()
			: await typeOfAnnotation(annotation, (reference) =>
					this.typeSymbolForReference(params.module, facts, reference),
				);
	}

	moveEdits(params: MoveEditsRequest): MoveEditsResponse {
		return invalidTarget(params.toModule) ?? makeMoveEdits(params, extractFacts(params.module, params.text));
	}

	arrangeEdits(params: ArrangeEditsRequest): MoveEditsResponse {
		return invalidTarget(params.toModule) ?? makeArrangeEdits(params, extractFacts(params.module, params.text));
	}

	renameEdits(params: RenameEditsRequest): RenameEditsResponse {
		return renameEdits(params);
	}
}

function invalidTarget(toModule: string): MoveEditsResponse | undefined {
	if (isValidTargetModule(toModule)) return undefined;
	return { status: "refused", reason: "InvalidTarget", detail: `the target is not a Python module: ${toModule}` };
}

function unknownAnnotationType(): TypeInfo {
	return unknownType("NotImplemented", "no annotation or inferable initializer");
}

async function typeOfAnnotation(
	annotation: Pick<
		Extract<TypeAnswer, { kind: "declared" }>,
		"text" | "forwardReference" | "symbolId" | "typeReference"
	>,
	resolveSymbolId?: (reference: RawTypeReference) => Promise<string | undefined>,
): Promise<TypeInfo> {
	if (annotation.forwardReference) {
		return { status: "unknown", reason: "NotImplemented", detail: "string forward references are not resolved" };
	}
	const symbolId =
		annotation.symbolId ??
		(annotation.typeReference === undefined ? undefined : await resolveSymbolId?.(annotation.typeReference));
	return {
		status: "known",
		display: annotation.text,
		...defined({ symbolId }),
		provenance: "declared",
	};
}

async function typeOfAnswer(
	answer: TypeAnswer,
	resolveSymbolId?: (reference: RawTypeReference) => Promise<string | undefined>,
): Promise<TypeInfo> {
	if (answer.kind === "declared") return typeOfAnnotation(answer, resolveSymbolId);
	if (answer.kind === "inferred") {
		const symbolId =
			answer.symbolId ??
			(answer.typeReference === undefined ? undefined : await resolveSymbolId?.(answer.typeReference));
		return {
			status: "inferred",
			display: answer.display,
			basis: answer.basis,
			...defined({ symbolId }),
		};
	}
	return unknownType(answer.reason, answer.detail ?? "inference could not establish a type");
}

function unknownType(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

//////// Main

// PythonProvider answers six methods asynchronously (it spawns python3); the shared provider
// contract is written sync-only for every other language, and the wire dispatch loop awaits
// whatever a handler returns regardless of this declared type.
export function wireHandlers(provider: PythonProvider): ReturnType<typeof handlersFor> {
	return handlersFor(provider);
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new PythonProvider()): void {
	serveProvider(connection, wireHandlers(provider));
}

if (import.meta.main) runProviderOnStdio(wireHandlers(new PythonProvider()));
