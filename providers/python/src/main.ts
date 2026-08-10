import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Binding,
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	type ImportedName,
	type ImportResolution,
	type Literal,
	notImplementedImport,
	PROTOCOL_VERSION,
	type ProjectModel,
	type ProviderHandlers,
	parseSymbolId,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
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
	metrics: true,
} as const;

export const REFERENCE_ROLES = ["call", "read", "write", "extends", "typeUse"] as const;

//////// Types

type Range = Declaration["range"];
type RawDescriptor = Pick<Descriptor, "kind" | "name">;

interface RawDeclaration {
	name: string;
	kind: Declaration["kind"];
	descriptorPath: RawDescriptor[];
	containerPath: RawDescriptor[];
	range: Range;
	selectionRange: Range;
	visibility: Declaration["visibility"];
	exported: boolean;
	signature?: string;
	docComment?: string;
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
	scopePath: RawDescriptor[];
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
	imports: { specifier: string; imported: ImportedName[]; reExport: boolean }[];
	importBindings: RawImportBinding[];
	scopeInfos: RawScopeInfo[];
	typeAnnotations: RawTypeAnnotation[];
	inferredTypes: RawInferredType[];
	literals: RawLiteral[];
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
	referenceScopes: Map<Reference, RawDescriptor[]>;
	imports: RawFacts["imports"];
	importBindings: RawImportBinding[];
	scopeInfos: RawScopeInfo[];
	diagnostics: Diagnostic[];
	typeAnnotations: MappedTypeAnnotation[];
	inferredTypes: RawInferredType[];
	literals: Literal[];
	typeAnswers: Map<string, TypeAnswer>;
}

//////// Helpers

function modulePath(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).replace(/\\/g, "/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	return relative;
}

function idFor(module: string, descriptors: RawDescriptor[]): string {
	return composeSymbolId({ language: LANGUAGE, module, descriptors });
}

function runExtractor(python3: Python3Dispatch, module: string, text: string): RawFacts {
	const facts = python3.runJson<RawFacts>([HELPER_PATH], {
		input: JSON.stringify({ module, text }),
		maxBuffer: 32 * 1024 * 1024,
	});
	if (facts === null) throw new Error(python3.unavailableDetail);
	return facts;
}

function extractFacts(python3: Python3Dispatch, module: string, text: string): RawFacts {
	try {
		return runExtractor(python3, module, text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			declarations: [],
			references: [],
			imports: [],
			importBindings: [],
			scopeInfos: [],
			typeAnnotations: [],
			inferredTypes: [],
			literals: [],
			diagnostics: [{ severity: "error", message: detail }],
		};
	}
}

function mapFacts(module: string, raw: RawFacts): MappedFacts {
	const declarations: Declaration[] = raw.declarations.map((declaration) => ({
		symbolId: idFor(module, declaration.descriptorPath),
		kind: declaration.kind,
		name: declaration.name,
		range: declaration.range,
		selectionRange: declaration.selectionRange,
		visibility: declaration.visibility,
		exported: declaration.exported,
		...(declaration.signature === undefined ? {} : { signature: declaration.signature }),
		...(declaration.docComment === undefined ? {} : { docComment: declaration.docComment }),
		...(declaration.metrics === undefined ? {} : { metrics: declaration.metrics }),
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
		...(literal.number === undefined ? {} : { number: literal.number }),
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
				...(declaration.typeReference === undefined ? {} : { typeReference: declaration.typeReference }),
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
				...(inferred.detail === undefined ? {} : { detail: inferred.detail }),
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
			...(reference.scopePath.length === 0 ? {} : { fromId: idFor(module, reference.scopePath) }),
		};
		referenceScopes.set(mapped, reference.scopePath);
		return mapped;
	});
	return {
		declarations,
		references,
		referenceScopes,
		imports: raw.imports,
		importBindings: raw.importBindings,
		scopeInfos: raw.scopeInfos,
		diagnostics: raw.diagnostics,
		typeAnnotations,
		inferredTypes: raw.inferredTypes,
		literals,
		typeAnswers,
	};
}

function walkPythonFiles(root: string): string[] {
	const files: string[] = [];
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			if (entry.isFile() && entry.name.endsWith(".py")) {
				const module = modulePath(root, absolute);
				if (module !== null) files.push(module);
			}
		}
	}
	visit(root);
	return files.sort();
}

function safeWorkspacePath(root: string, parts: string[]): string | null {
	const absolute = path.resolve(root, ...parts);
	const relative = path.relative(root, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return absolute;
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
		.map((candidate) => safeWorkspacePath(root, candidate.split("/")))
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

function pythonStdlibModuleNames(python3: Python3Dispatch): Set<string> | null {
	const parsed = python3.runJson<PythonStdlibResponse>(
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

function pythonModuleAvailable(python3: Python3Dispatch, moduleName: string): boolean | null {
	const parsed = python3.runJson<PythonModuleResponse>(
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
		const packageRoot = safeWorkspacePath(root, [...rootParts, ...packageParts]);
		return packageRoot !== null && existsSync(packageRoot);
	});
}

function projectDiagnostic(root: string, message: string): ProjectModel {
	return {
		files: [],
		externalRoots: [],
		configFiles: [],
		diagnostics: [{ severity: "error", message, path: root }],
	};
}

function comparePosition(left: Range["start"], right: Range["start"]): number {
	if (left.line !== right.line) return left.line - right.line;
	return left.character - right.character;
}

function containsPosition(range: Range, position: Range["start"]): boolean {
	return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function sameRange(left: Range, right: Range): boolean {
	return comparePosition(left.start, right.start) === 0 && comparePosition(left.end, right.end) === 0;
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
	private workspaceRoot = process.cwd();
	private parsedFacts = new Map<string, ReturnType<typeof mapFacts>>();

	constructor(private readonly python3 = new Python3Dispatch()) {}

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.parsedFacts.clear();
		return {
			providerId: "python-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		try {
			if (!existsSync(this.workspaceRoot)) {
				return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
			}
			if (!statSync(this.workspaceRoot).isDirectory()) {
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			}
			return {
				files: walkPythonFiles(this.workspaceRoot),
				externalRoots: [],
				configFiles: [],
				diagnostics: [],
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return projectDiagnostic(this.workspaceRoot, `unable to inspect workspace root: ${detail}`);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string }) {
		const facts = mapFacts(params.module, extractFacts(this.python3, params.module, params.text));
		this.parsedFacts.set(params.module, facts);
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: this.wireReferences(params.module, facts),
			imports: facts.imports,
			literals: facts.literals,
			diagnostics: facts.diagnostics,
		};
	}

	private factsForModule(module: string): ReturnType<typeof mapFacts> | null {
		const cached = this.parsedFacts.get(module);
		if (cached !== undefined) return cached;
		const absolute = safeWorkspacePath(this.workspaceRoot, module.split("/"));
		if (absolute === null || !existsSync(absolute) || !statSync(absolute).isFile()) return null;
		const facts = mapFacts(module, extractFacts(this.python3, module, readFileSync(absolute, "utf8")));
		this.parsedFacts.set(module, facts);
		return facts;
	}

	private wireReferences(module: string, facts: ReturnType<typeof mapFacts>): Reference[] {
		return facts.references.map((reference) => ({
			...reference,
			binding: this.bindingForReference(module, facts, reference),
		}));
	}

	private typeSymbolForReference(
		module: string,
		facts: ReturnType<typeof mapFacts>,
		target: RawTypeReference,
	): string | undefined {
		const matches = facts.references.filter(
			(reference) =>
				reference.name === target.name &&
				reference.role === target.role &&
				sameRange(reference.range, target.range),
		);
		if (matches.length !== 1) return undefined;
		const reference = matches[0];
		if (reference === undefined) return undefined;
		const binding = this.bindingForReference(module, facts, reference);
		return binding.status === "bound" ? binding.symbolId : undefined;
	}

	private bindingForReference(module: string, facts: ReturnType<typeof mapFacts>, reference: Reference): Binding {
		if (reference.binding.status !== "unbound") return reference.binding;
		if (reference.binding.reason === "Ambiguous" || reference.binding.reason === "RuntimeConstructed") {
			return reference.binding;
		}
		return this.crossFileBinding(module, facts, reference) ?? reference.binding;
	}

	private crossFileBinding(module: string, facts: ReturnType<typeof mapFacts>, reference: Reference): Binding | null {
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

		const resolution = this.resolveImport({ fromModule: module, specifier: imported.specifier });
		if (resolution.status === "external") {
			return unboundBinding("ExternalDependency", "the imported declaration is outside the workspace");
		}
		if (resolution.status === "unresolved") {
			return unboundBinding(resolution.reason, resolution.detail ?? "the import target is unresolved");
		}
		const targetFacts = this.factsForModule(resolution.module);
		if (targetFacts === null) return unboundBinding("NotIndexed", "the imported module is not indexed");
		const declarations = targetFacts.declarations.filter(
			(declaration) => declaration.name === imported.importedName && declaration.containerId === undefined,
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

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const parts = importParts(params.fromModule, params.specifier);
		const candidates = fileCandidates(this.workspaceRoot, parts);
		const firstCandidate = candidates[0];
		if (firstCandidate !== undefined) {
			const module = modulePath(this.workspaceRoot, firstCandidate);
			if (module !== null) return { status: "resolved" as const, module };
		}
		if (!params.specifier.startsWith(".")) {
			const packageName = packageNameOf(params.specifier);
			const stdlibModuleNames = pythonStdlibModuleNames(this.python3);
			if (stdlibModuleNames === null) {
				return notImplementedImport(this.python3.unavailableDetail);
			}
			if (stdlibModuleNames.has(packageName) || externalPackageExists(this.workspaceRoot, params.specifier)) {
				return { status: "external" as const, packageName };
			}
			const moduleAvailable = pythonModuleAvailable(this.python3, packageName);
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

	bind(params: { module: string; name: string; range: Range }) {
		const facts = this.factsForModule(params.module);
		if (facts === null) {
			return { status: "unbound" as const, reason: "NotIndexed" as const, detail: "module is not indexed" };
		}
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && containsPosition(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(params.module, facts, reference);
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name && containsPosition(candidate.selectionRange, params.range.start),
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

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) {
			const parsed = parseSymbolId(params.symbolId);
			if (parsed === null || parsed.language !== LANGUAGE) {
				return {
					status: "unknown",
					reason: "ParseError",
					detail: "the symbol id is not a Python workspace id",
				};
			}
			const facts = this.factsForModule(parsed.module);
			if (facts === null) return unknownType("NotIndexed", "module is not indexed");
			const answer = facts.typeAnswers.get(params.symbolId);
			return answer === undefined
				? unknownAnnotationType()
				: typeOfAnswer(answer, (reference) => this.typeSymbolForReference(parsed.module, facts, reference));
		}

		const facts = this.factsForModule(params.module);
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
			: typeOfAnnotation(annotation, (reference) => this.typeSymbolForReference(params.module, facts, reference));
	}

	renameEdits(params: RenameEditsRequest): RenameEditsResponse {
		try {
			const response = this.python3.runJson<RenameEditsResponse>([HELPER_PATH], {
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

function typeOfAnnotation(
	annotation: Pick<
		Extract<TypeAnswer, { kind: "declared" }>,
		"text" | "forwardReference" | "symbolId" | "typeReference"
	>,
	resolveSymbolId?: (reference: RawTypeReference) => string | undefined,
): TypeInfo {
	if (annotation.forwardReference) {
		return { status: "unknown", reason: "NotImplemented", detail: "string forward references are not resolved" };
	}
	const symbolId =
		annotation.symbolId ??
		(annotation.typeReference === undefined ? undefined : resolveSymbolId?.(annotation.typeReference));
	return {
		status: "known",
		display: annotation.text,
		...(symbolId === undefined ? {} : { symbolId }),
		provenance: "declared",
	};
}

function typeOfAnswer(
	answer: TypeAnswer,
	resolveSymbolId?: (reference: RawTypeReference) => string | undefined,
): TypeInfo {
	if (answer.kind === "declared") return typeOfAnnotation(answer, resolveSymbolId);
	if (answer.kind === "inferred") {
		const symbolId =
			answer.symbolId ??
			(answer.typeReference === undefined ? undefined : resolveSymbolId?.(answer.typeReference));
		return {
			status: "inferred",
			display: answer.display,
			basis: answer.basis,
			...(symbolId === undefined ? {} : { symbolId }),
		};
	}
	return unknownType(answer.reason, answer.detail ?? "inference could not establish a type");
}

function unknownType(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

//////// Main

export function handlersFor(provider: PythonProvider): ProviderHandlers {
	return {
		initialize: (params) => provider.initialize(params.workspaceRoot),
		discoverProject: (params) => provider.discoverProject(params.workspaceRoot),
		parseFile: (params) => provider.parseFile(params),
		resolveImport: (params) => provider.resolveImport(params),
		bind: (params) => provider.bind(params),
		typeOf: (params) => provider.typeOf(params),
		renameEdits: (params) => provider.renameEdits(params),
		shutdown: () => ({}),
	};
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new PythonProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new PythonProvider()));
