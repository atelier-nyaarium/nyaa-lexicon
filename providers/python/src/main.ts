import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	asyncModuleStore,
	type Binding,
	type CommentSpan,
	comparePositions,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	defined,
	discoverByWalk,
	type FileRole,
	handlersFor,
	type ImportedName,
	type ImportResolution,
	type Literal,
	type MoveEditsRequest,
	type MoveEditsResponse,
	notImplementedImport,
	PROTOCOL_VERSION,
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
import { type RawHeader, signatureOf } from "./header";
import { isValidTargetModule, makeMoveEdits } from "./move";
import { Python3Dispatch } from "./python3";

//////// Constants

const LANGUAGE = "python";
const EXTENSIONS = [".py"];
const HELPER_PATH = fileURLToPath(new URL("./extract.py", import.meta.url));
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

/** Kinds a typeUse reference may bind to. */
const TYPE_USE_KINDS = new Set<Declaration["kind"]>(["class", "variable", "function", "interface", "typeParameter"]);

//////// Types

type Range = Declaration["range"];
type RawDescriptor = Pick<Descriptor, "kind" | "name" | "disambiguator">;

interface RawDeclaration {
	name: string;
	kind: Declaration["kind"];
	descriptorPath: RawDescriptor[];
	containerPath: RawDescriptor[];
	range: Range;
	selectionRange: Range;
	visibility: Declaration["visibility"];
	exported: boolean;
	header?: RawHeader;
	metrics?: {
		lines?: number;
		parameters?: number;
		nesting?: number;
		branches?: number;
	};
	typeText?: string;
	typeForwardReference?: boolean;
	typeDescriptorPath?: RawDescriptor[];
	typeReference?: RawTypeReference;
}

interface RawTypeReference {
	name: string;
	range: Range;
	role: "call" | "typeUse";
}

interface RawTypeAnnotation {
	anchorRange: Range;
	annotationRange: Range;
	text: string;
	forwardReference: boolean;
	typeDescriptorPath?: RawDescriptor[];
	typeReference?: RawTypeReference;
}

interface RawInferredType {
	descriptorPath: RawDescriptor[];
	display?: string;
	basis?: string;
	typeDescriptorPath?: RawDescriptor[];
	reason?: UnknownReason;
	detail?: string;
}

interface RawLiteral {
	kind: Literal["kind"];
	value: string;
	number?: number;
	range: Range;
	containerPath?: RawDescriptor[];
}

interface RawImportBinding {
	specifier: string;
	localName: string;
	importedName: string | null;
	scopePath: RawDescriptor[];
	conditional: boolean;
	star: boolean;
}

interface RawImportAlias {
	name: string;
	localName: string;
	range: Range;
	importedRange?: Range | null;
	localRange?: Range | null;
	star: boolean;
}

interface RawImportStatement {
	kind: "import" | "from";
	specifier: string;
	range: Range;
	reExport: boolean;
	aliases: RawImportAlias[];
}

interface RawScopeInfo {
	scopePath: RawDescriptor[];
	kind: "module" | "class" | "function";
	locals: string[];
	parameters: string[];
	globals: string[];
	nonlocals: string[];
	conditional: string[];
	dynamic: boolean;
}

interface RawReference {
	name: string;
	range: Range;
	role: Reference["role"];
	/** Where the name resolves, which a header takes from outside its declaration. */
	scopePath: RawDescriptor[];
	/** Declaration the use is written in, header included. */
	ownerPath: RawDescriptor[];
	binding: RawBinding;
}

type RawBinding =
	| { status: "bound"; descriptorPath: RawDescriptor[] }
	| {
			status: "unbound";
			reason: "NotImplemented" | "NotIndexed" | "Ambiguous" | "RuntimeConstructed";
			detail: string;
	  };

interface RawFacts {
	declarations: RawDeclaration[];
	references: RawReference[];
	role: FileRole;
	imports: { specifier: string; imported: ImportedName[]; reExport: boolean }[];
	importStatements: RawImportStatement[];
	moduleDocstring?: Range | null;
	importBindings: RawImportBinding[];
	scopeInfos: RawScopeInfo[];
	typeAnnotations: RawTypeAnnotation[];
	inferredTypes: RawInferredType[];
	literals: RawLiteral[];
	comments: CommentSpan[];
	diagnostics: Diagnostic[];
}

type TypeAnswer =
	| {
			kind: "declared";
			text: string;
			forwardReference: boolean;
			symbolId?: string;
			typeReference?: RawTypeReference;
	  }
	| {
			kind: "inferred";
			display: string;
			basis: string;
			symbolId?: string;
			typeReference?: RawTypeReference;
	  }
	| { kind: "unknown"; reason: UnknownReason; detail?: string };

type MappedTypeAnnotation = RawTypeAnnotation & { symbolId?: string };

interface MappedFacts {
	declarations: Declaration[];
	references: Reference[];
	role: FileRole;
	referenceScopes: Map<Reference, RawDescriptor[]>;
	imports: RawFacts["imports"];
	importBindings: RawImportBinding[];
	scopeInfos: RawScopeInfo[];
	diagnostics: Diagnostic[];
	typeAnnotations: MappedTypeAnnotation[];
	inferredTypes: RawInferredType[];
	literals: Literal[];
	comments: CommentSpan[];
	typeAnswers: Map<string, TypeAnswer>;
}

//////// Helpers

function idFor(module: string, descriptors: RawDescriptor[]): string {
	return composeSymbolId({ language: LANGUAGE, module, descriptors });
}

async function runExtractor(python3: Python3Dispatch, module: string, text: string): Promise<RawFacts> {
	const facts = await python3.runJson<RawFacts>([HELPER_PATH], {
		input: JSON.stringify({ module, text }),
		maxBuffer: 32 * 1024 * 1024,
	});
	if (facts === null) throw new Error(python3.unavailableDetail);
	return facts;
}

async function extractFacts(python3: Python3Dispatch, module: string, text: string): Promise<RawFacts> {
	try {
		return await runExtractor(python3, module, text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			declarations: [],
			references: [],
			role: { kind: "unknown", reason: "NotImplemented" },
			imports: [],
			importStatements: [],
			moduleDocstring: null,
			importBindings: [],
			scopeInfos: [],
			typeAnnotations: [],
			inferredTypes: [],
			literals: [],
			comments: [],
			diagnostics: [{ severity: "error", message: detail }],
		};
	}
}

function mapFacts(module: string, text: string, raw: RawFacts): MappedFacts {
	const coordinates = coordinatesOf(text);
	const declarations: Declaration[] = raw.declarations.map((declaration) => ({
		symbolId: idFor(module, declaration.descriptorPath),
		kind: declaration.kind,
		name: declaration.name,
		range: declaration.range,
		selectionRange: declaration.selectionRange,
		visibility: declaration.visibility,
		exported: declaration.exported,
		...defined({
			signature:
				declaration.header === undefined ? undefined : signatureOf(text, coordinates, declaration.header),
			metrics: declaration.metrics,
		}),
		...(declaration.containerPath.length === 0 ? {} : { containerId: idFor(module, declaration.containerPath) }),
	}));
	const typeAnnotations: MappedTypeAnnotation[] = raw.typeAnnotations.map((annotation) => ({
		...annotation,
		...(annotation.typeDescriptorPath === undefined
			? {}
			: { symbolId: idFor(module, annotation.typeDescriptorPath) }),
	}));
	const literals: Literal[] = raw.literals.map((literal) => ({
		kind: literal.kind,
		value: literal.value,
		...defined({ number: literal.number }),
		range: literal.range,
		...(literal.containerPath === undefined || literal.containerPath.length === 0
			? {}
			: { containerId: idFor(module, literal.containerPath) }),
	}));
	const typeAnswers = new Map<string, TypeAnswer>();
	for (const declaration of raw.declarations) {
		if (declaration.typeText !== undefined) {
			typeAnswers.set(idFor(module, declaration.descriptorPath), {
				kind: "declared",
				text: declaration.typeText,
				forwardReference: declaration.typeForwardReference === true,
				...(declaration.typeDescriptorPath === undefined
					? {}
					: { symbolId: idFor(module, declaration.typeDescriptorPath) }),
				...defined({ typeReference: declaration.typeReference }),
			});
		}
	}
	for (const inferred of raw.inferredTypes) {
		const symbolId = idFor(module, inferred.descriptorPath);
		if (inferred.display !== undefined && inferred.basis !== undefined) {
			typeAnswers.set(symbolId, {
				kind: "inferred",
				display: inferred.display,
				basis: inferred.basis,
				...(inferred.typeDescriptorPath === undefined
					? {}
					: { symbolId: idFor(module, inferred.typeDescriptorPath) }),
			});
		} else if (inferred.reason !== undefined) {
			typeAnswers.set(symbolId, {
				kind: "unknown",
				reason: inferred.reason,
				...defined({ detail: inferred.detail }),
			});
		}
	}
	const referenceScopes = new Map<Reference, RawDescriptor[]>();
	const references: Reference[] = raw.references.map((reference) => {
		const mapped: Reference = {
			name: reference.name,
			range: reference.range,
			role: reference.role,
			binding:
				reference.binding.status === "bound"
					? {
							status: "bound",
							symbolId: idFor(module, reference.binding.descriptorPath),
							provenance: "bound",
						}
					: reference.binding,
			...(reference.ownerPath.length === 0 ? {} : { fromId: idFor(module, reference.ownerPath) }),
		};
		referenceScopes.set(mapped, reference.scopePath);
		return mapped;
	});
	return {
		declarations,
		references,
		role: raw.role,
		referenceScopes,
		imports: raw.imports,
		importBindings: raw.importBindings,
		scopeInfos: raw.scopeInfos,
		diagnostics: raw.diagnostics,
		typeAnnotations,
		inferredTypes: raw.inferredTypes,
		literals,
		comments: raw.comments,
		typeAnswers,
	};
}

function importParts(fromModule: string, specifier: string): string[] {
	const fromParts = fromModule.replace(/\\/g, "/").split("/");
	fromParts.pop();
	if (!specifier.startsWith(".")) return specifier.split(".").filter(Boolean);
	const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
	const remainder = specifier.slice(dots).replace(/^\/+/, "");
	const levels = Math.max(0, dots - 1);
	const base = fromParts.slice(0, Math.max(0, fromParts.length - levels));
	return [...base, ...remainder.split(/[/.]/).filter(Boolean)];
}

function fileCandidates(root: string, parts: string[]): string[] {
	const relative = parts.join("/");
	const candidates = [`${relative}.py`, `${relative}.pyi`, `${relative}/__init__.py`];
	return candidates
		.map((candidate) => workspaceFile(root, candidate))
		.filter(
			(candidate): candidate is string =>
				candidate !== null && existsSync(candidate) && statSync(candidate).isFile(),
		);
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

function samePath(left: RawDescriptor[], right: RawDescriptor[]): boolean {
	return (
		left.length === right.length &&
		left.every((descriptor, index) => {
			const other = right[index];
			return other?.kind === descriptor.kind && other.name === descriptor.name;
		})
	);
}

function isPathPrefix(prefix: RawDescriptor[], pathValue: RawDescriptor[]): boolean {
	return prefix.length <= pathValue.length && samePath(prefix, pathValue.slice(0, prefix.length));
}

function unboundBinding(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

//////// Provider

export class PythonProvider {
	readonly store;

	constructor(private readonly python3 = new Python3Dispatch()) {
		this.store = asyncModuleStore<MappedFacts>({
			read: async (module, text) => mapFacts(module, text, await extractFacts(this.python3, module, text)),
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

	async parseFile(params: { module: string; contentHash: string; text: string }, facts: MappedFacts) {
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: await this.wireReferences(params.module, facts),
			role: facts.role,
			imports: facts.imports,
			literals: facts.literals,
			comments: facts.comments,
			diagnostics: facts.diagnostics,
		};
	}

	private async factsForModule(module: string): Promise<MappedFacts | null> {
		return (await this.store.load(module)) ?? null;
	}

	private async wireReferences(module: string, facts: ReturnType<typeof mapFacts>): Promise<Reference[]> {
		return Promise.all(
			facts.references.map(async (reference) => ({
				...reference,
				binding: await this.bindingForReference(module, facts, reference),
			})),
		);
	}

	private async typeSymbolForReference(
		module: string,
		facts: ReturnType<typeof mapFacts>,
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
		const binding = await this.bindingForReference(module, facts, reference);
		return binding.status === "bound" ? binding.symbolId : undefined;
	}

	private async bindingForReference(
		module: string,
		facts: ReturnType<typeof mapFacts>,
		reference: Reference,
	): Promise<Binding> {
		if (reference.binding.status !== "unbound") return reference.binding;
		if (reference.binding.reason === "Ambiguous" || reference.binding.reason === "RuntimeConstructed") {
			return reference.binding;
		}
		return (await this.crossFileBinding(module, facts, reference)) ?? reference.binding;
	}

	private async crossFileBinding(
		module: string,
		facts: ReturnType<typeof mapFacts>,
		reference: Reference,
	): Promise<Binding | null> {
		const referencePath = facts.referenceScopes.get(reference) ?? [];
		const visible = facts.importBindings.filter((importBinding) =>
			this.importVisible(facts, importBinding, reference.name, referencePath),
		);
		const direct = visible.filter(
			(importBinding) => !importBinding.star && importBinding.localName === reference.name,
		);
		const stars = visible.filter((importBinding) => importBinding.star);
		if (
			direct.some((importBinding) => importBinding.conditional) ||
			stars.some((importBinding) => importBinding.conditional)
		) {
			return unboundBinding("Ambiguous", "a conditional import can supply this name");
		}
		if (direct.length === 0) {
			return stars.length === 0 ? null : unboundBinding("Ambiguous", "a star import can supply this name");
		}
		if (direct.length !== 1 || stars.length !== 0) {
			return unboundBinding("Ambiguous", "multiple imports can supply this name");
		}
		const imported = direct[0];
		if (imported === undefined || imported.importedName === null) {
			return unboundBinding("Ambiguous", "module imports require receiver lookup");
		}

		const resolution = await this.resolveImport({ fromModule: module, specifier: imported.specifier });
		if (resolution.status === "external") {
			return unboundBinding("ExternalDependency", "the imported declaration is outside the workspace");
		}
		if (resolution.status === "unresolved") {
			return unboundBinding(resolution.reason, resolution.detail ?? "the import target is unresolved");
		}
		const targetFacts = await this.factsForModule(resolution.module);
		if (targetFacts === null) return unboundBinding("NotIndexed", "the imported module is not indexed");
		const declarations = targetFacts.declarations.filter(
			(declaration) =>
				declaration.name === imported.importedName &&
				declaration.containerId === undefined &&
				(reference.role !== "typeUse" || TYPE_USE_KINDS.has(declaration.kind)),
		);
		if (declarations.length > 1) {
			return unboundBinding("Ambiguous", "multiple declarations match the imported name");
		}
		const declaration = declarations[0];
		return declaration === undefined
			? unboundBinding("NotIndexed", "the imported declaration is not indexed")
			: { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
	}

	private importVisible(
		facts: ReturnType<typeof mapFacts>,
		importBinding: RawImportBinding,
		name: string,
		referencePath: RawDescriptor[],
	): boolean {
		const importPath = importBinding.scopePath;
		if (!isPathPrefix(importPath, referencePath)) return false;
		const afterImport = referencePath.slice(importPath.length);
		if (
			importPath.some((descriptor) => descriptor.kind === "type") ||
			(importPath.length > 0 && afterImport.some((descriptor) => descriptor.kind === "type"))
		) {
			return afterImport.length === 0 && samePath(importPath, referencePath);
		}
		for (const info of facts.scopeInfos) {
			if (!isPathPrefix(importPath, info.scopePath) || !isPathPrefix(info.scopePath, referencePath)) continue;
			if (info.globals.includes(name)) continue;
			if (info.nonlocals.includes(name)) return false;
			const sameImportScope = samePath(info.scopePath, importPath);
			if (sameImportScope) {
				if (info.parameters.includes(name) || this.hasWriteInScope(facts, name, info.scopePath)) return false;
				continue;
			}
			if (info.locals.includes(name) || info.parameters.includes(name)) return false;
		}
		return true;
	}

	private hasWriteInScope(facts: ReturnType<typeof mapFacts>, name: string, scopePath: RawDescriptor[]): boolean {
		return facts.references.some(
			(reference) =>
				reference.name === name &&
				reference.role === "write" &&
				samePath(facts.referenceScopes.get(reference) ?? [], scopePath),
		);
	}

	async resolveImport(params: { fromModule: string; specifier: string }): Promise<ImportResolution> {
		const root = this.store.root;
		const parts = importParts(params.fromModule, params.specifier);
		const candidates = fileCandidates(root, parts);
		const firstCandidate = candidates[0];
		if (firstCandidate !== undefined) {
			const module = workspaceModule(root, firstCandidate);
			if (module !== null) return { status: "resolved" as const, module };
		}
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

	async bind(params: { module: string; name: string; range: Range }) {
		const facts = await this.factsForModule(params.module);
		if (facts === null) {
			return { status: "unbound" as const, reason: "NotIndexed" as const, detail: "module is not indexed" };
		}
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && containsPosition(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(params.module, facts, reference);
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

	async moveEdits(params: MoveEditsRequest): Promise<MoveEditsResponse> {
		if (!isValidTargetModule(params.toModule)) {
			return {
				status: "refused",
				reason: "InvalidTarget",
				detail: `the target is not a Python module: ${params.toModule}`,
			};
		}
		return makeMoveEdits(params, await extractFacts(this.python3, params.module, params.text));
	}

	async renameEdits(params: RenameEditsRequest): Promise<RenameEditsResponse> {
		try {
			const response = await this.python3.runJson<RenameEditsResponse>([HELPER_PATH], {
				input: JSON.stringify({ mode: "rename", ...params }),
				maxBuffer: 32 * 1024 * 1024,
			});
			return response ?? { status: "refused", reason: "NotImplemented", detail: this.python3.unavailableDetail };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { status: "refused", reason: "NotImplemented", detail };
		}
	}
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
