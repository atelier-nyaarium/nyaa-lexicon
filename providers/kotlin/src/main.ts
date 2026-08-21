import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	comparePositions,
	type Declaration,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	notImplementedMove,
	PROTOCOL_VERSION,
	type ProjectModel,
	type ProviderHandlers,
	parseSymbolId,
	type Range,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	type TypeInfo,
	type UnknownReason,
	serveProvider as wireProvider,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { type KotlinFile, LANGUAGE, parseKotlin, REFERENCE_ROLES } from "./parser.js";

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

const EXTENSIONS = [".kt"];
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".gradle",
	".idea",
	".kotlin",
	".mvn",
	"build",
	"dist",
	"generated",
	"node_modules",
	"out",
	"target",
]);

export { LANGUAGE, REFERENCE_ROLES };

type RangeLike = Declaration["range"];

function contains(range: RangeLike, position: RangeLike["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function modulePath(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).replace(/\\/g, "/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	return relative;
}

function safeWorkspacePath(root: string, module: string): string | null {
	const absolute = path.resolve(root, ...module.split("/"));
	const relative = path.relative(root, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return absolute;
}

function walkKotlinFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".kt")) continue;
			const module = modulePath(root, absolute);
			if (module !== null) files.push(module);
		}
	};
	visit(root);
	return files.sort();
}

function projectDiagnostic(root: string, message: string): ProjectModel {
	return {
		files: [],
		externalRoots: [],
		configFiles: [],
		diagnostics: [{ severity: "error", message, path: root }],
	};
}

function unknown(reason: UnknownReason, detail: string): { status: "unbound"; reason: UnknownReason; detail: string } {
	return { status: "unbound", reason, detail };
}

function unknownType(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

function bound(symbolId: string): Binding {
	return { status: "bound", symbolId, provenance: "bound" };
}

function ambiguous(candidates: string[]): Binding {
	return { status: "ambiguous", candidates, provenance: "bound" };
}

function topLevel(declaration: Declaration): boolean {
	return declaration.containerId === undefined;
}

function matchesRole(declaration: Declaration, role: Reference["role"]): boolean {
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
	if (role === "typeUse" || role === "extends")
		return ["class", "interface", "enum", "type", "package"].includes(declaration.kind);
	if (role === "write") return declaration.kind === "property" || declaration.kind === "variable";
	if (role === "import") return topLevel(declaration) && declaration.kind !== "package";
	return declaration.kind !== "package";
}

function externalSpecifier(specifier: string): boolean {
	return ["kotlin", "kotlinx", "java"].some((root) => specifier === root || specifier.startsWith(`${root}.`));
}

function cleanSpecifier(specifier: string): string {
	return specifier.endsWith(".*") ? specifier.slice(0, -2) : specifier;
}

function simpleTypeName(display: string): string | undefined {
	const match = /(?:^|[<,( ])([A-Za-z_][A-Za-z0-9_]*)(?:\?|$)/u.exec(display.trim());
	return match?.[1];
}

export class KotlinProvider {
	private workspaceRoot = process.cwd();
	private readonly parsedFacts = new Map<string, KotlinFile>();
	private workspaceFiles: string[] | null = null;

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.parsedFacts.clear();
		this.workspaceFiles = null;
		return {
			providerId: "kotlin-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.parsedFacts.clear();
		this.workspaceFiles = null;
		try {
			if (!existsSync(this.workspaceRoot))
				return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
			if (!statSync(this.workspaceRoot).isDirectory())
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			return { files: this.filesInWorkspace(), externalRoots: [], configFiles: [], diagnostics: [] };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return projectDiagnostic(this.workspaceRoot, `unable to inspect workspace root: ${detail}`);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const outline = params.depth === "outline";
		const facts = parseKotlin(params.module, params.text, outline);
		this.parsedFacts.set(params.module, facts);
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: outline ? [] : this.wireReferences(facts),
			imports: facts.imports.map(({ specifier, imported, reExport }) => ({ specifier, imported, reExport })),
			literals: outline ? [] : facts.literals,
			comments: outline ? [] : facts.comments,
			diagnostics: facts.diagnostics,
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = cleanSpecifier(params.specifier);
		if (specifier === "")
			return { status: "unresolved", reason: "ParseError", detail: "the import specifier is empty" };
		const segments = specifier.split(".").filter((segment) => segment !== "");
		for (let length = segments.length; length > 0; length--) {
			const packageName = segments.slice(0, length).join(".");
			const matches = this.modulesDeclaringPackage(packageName);
			if (matches.length === 1) return { status: "resolved", module: matches[0] as string };
			if (matches.length > 1)
				return {
					status: "unresolved",
					reason: "Ambiguous",
					detail: `several workspace files declare package ${packageName}`,
				};
		}
		if (externalSpecifier(specifier)) return { status: "external", packageName: specifier };
		return {
			status: "unresolved",
			reason: "NotIndexed",
			detail: `no workspace file declares an imported package for ${params.specifier}`,
		};
	}

	bind(params: { module: string; name: string; range: Range }) {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknown("NotIndexed", "module is not indexed");
		const reference = facts.references.find(
			(candidate) =>
				candidate.reference.name === params.name && contains(candidate.reference.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(facts, reference);
		const declaration = facts.declarations.find(
			(candidate) => candidate.name === params.name && contains(candidate.selectionRange, params.range.start),
		);
		if (declaration !== undefined) return bound(declaration.symbolId);
		return unknown("NotIndexed", "no indexed reference or declaration matched the requested range");
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) return this.typeOfSymbol(params.symbolId);
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");
		if (facts.diagnostics.some((item) => item.severity === "error"))
			return unknownType("ParseError", "the module has syntax errors");
		const annotation = facts.typeFacts.find(
			(fact) => fact.annotationRange !== undefined && contains(fact.annotationRange, params.range.start),
		);
		if (annotation !== undefined) return this.withTypeSymbol(facts.module, annotation.answer);
		const declaration = facts.declarations.find((candidate) =>
			contains(candidate.selectionRange, params.range.start),
		);
		if (declaration !== undefined) return this.typeForDeclaration(facts, declaration);
		const reference = facts.references.find((candidate) => contains(candidate.reference.range, params.range.start));
		if (reference !== undefined) {
			const binding = this.bindingForReference(facts, reference);
			if (binding.status === "bound") return this.typeOfSymbol(binding.symbolId);
		}
		return unknownType("NotIndexed", "no indexed type target matched the requested range");
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "Kotlin rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("Kotlin move edits are not implemented");
	}

	private filesInWorkspace(): string[] {
		if (this.workspaceFiles !== null) return this.workspaceFiles;
		if (!existsSync(this.workspaceRoot) || !statSync(this.workspaceRoot).isDirectory()) return [];
		this.workspaceFiles = walkKotlinFiles(this.workspaceRoot);
		return this.workspaceFiles;
	}

	private factsForModule(module: string): KotlinFile | null {
		const cached = this.parsedFacts.get(module);
		if (cached !== undefined) return cached;
		const absolute = safeWorkspacePath(this.workspaceRoot, module);
		if (absolute === null || !existsSync(absolute)) return null;
		try {
			if (!statSync(absolute).isFile()) return null;
			const facts = parseKotlin(module, readFileSync(absolute, "utf8"));
			this.parsedFacts.set(module, facts);
			return facts;
		} catch {
			return null;
		}
	}

	private modulesDeclaringPackage(packageName: string): string[] {
		const modules = new Set<string>();
		for (const [module, facts] of this.parsedFacts) if (facts.packageName === packageName) modules.add(module);
		for (const module of this.filesInWorkspace()) {
			const facts = this.factsForModule(module);
			if (facts?.packageName === packageName) modules.add(module);
		}
		return [...modules].sort();
	}

	private wireReferences(facts: KotlinFile): Reference[] {
		return facts.references.map((info) => ({ ...info.reference, binding: this.bindingForReference(facts, info) }));
	}

	private bindingForReference(facts: KotlinFile, info: KotlinFile["references"][number]): Binding {
		if (info.importInfo !== undefined) return this.bindingForImport(facts, info.importInfo, info.reference);
		const local = this.sameFileCandidates(facts, info);
		if (local.length > 1) return ambiguous(local.map((candidate) => candidate.symbolId));
		if (local.length === 1) return bound((local[0] as Declaration).symbolId);
		const imports = facts.imports.filter(
			(item) =>
				item.localName === info.reference.name ||
				(!item.star && item.importedName === info.reference.name && item.localName === undefined),
		);
		if (imports.length > 1) return ambiguous(imports.map((item) => item.specifier));
		const imported = imports[0];
		if (imported !== undefined) return this.bindingForImport(facts, imported, info.reference);
		const star = facts.imports.find((item) => item.star);
		if (star !== undefined) return this.bindingForImport(facts, star, info.reference);
		return unknown("NotIndexed", `no Kotlin declaration matches ${info.reference.name}`);
	}

	private bindingForImport(
		facts: KotlinFile,
		importInfo: KotlinFile["imports"][number],
		reference: Reference,
	): Binding {
		const resolution = this.resolveImport({ fromModule: facts.module, specifier: importInfo.specifier });
		if (importInfo.star) {
			if (resolution.status === "external")
				return unknown("ExternalDependency", "a star import comes from an external package");
			if (resolution.status !== "resolved") return unknown("Ambiguous", "a star import cannot prove one binding");
			const target = this.factsForModule(resolution.module);
			const candidates =
				target?.declarations.filter(
					(declaration) =>
						declaration.name === reference.name &&
						topLevel(declaration) &&
						matchesRole(declaration, reference.role),
				) ?? [];
			if (candidates.length >= 2) return ambiguous(candidates.map((candidate) => candidate.symbolId));
			return unknown("Ambiguous", "a star import makes this binding ambiguous");
		}
		if (resolution.status === "external")
			return unknown("ExternalDependency", `import ${importInfo.specifier} is outside the workspace`);
		if (resolution.status !== "resolved")
			return unknown(resolution.reason, resolution.detail ?? "the imported package is unresolved");
		const target = this.factsForModule(resolution.module);
		if (target === null) return unknown("NotIndexed", "the imported module is not indexed");
		const name = importInfo.importedName ?? reference.name;
		const candidates = target.declarations.filter(
			(declaration) =>
				declaration.name === name &&
				topLevel(declaration) &&
				declaration.exported !== false &&
				matchesRole(declaration, reference.role),
		);
		if (candidates.length > 1) return ambiguous(candidates.map((candidate) => candidate.symbolId));
		const candidate = candidates[0];
		return candidate === undefined
			? unknown("NotIndexed", `the imported name ${name} is not indexed`)
			: bound(candidate.symbolId);
	}

	private sameFileCandidates(facts: KotlinFile, info: KotlinFile["references"][number]): Declaration[] {
		const candidates = facts.declarations.filter(
			(declaration) =>
				declaration.name === info.reference.name &&
				matchesRole(declaration, info.reference.role) &&
				this.visibleInScope(facts, declaration, info.scopeId),
		);
		if (candidates.length < 2) return candidates;
		const distances = new Map<string, number>();
		let current = info.scopeId;
		let distance = 0;
		let guard = 0;
		while (current !== undefined && !distances.has(current)) {
			distances.set(current, distance);
			current = facts.scopeParents.get(current);
			distance++;
			guard++;
			if (guard > facts.scopeParents.size + 1) break;
		}
		const topLevelDistance = distance;
		const ranked = candidates.map((declaration) => ({
			declaration,
			distance:
				declaration.containerId === undefined
					? topLevelDistance
					: (distances.get(declaration.containerId) ?? Number.POSITIVE_INFINITY),
		}));
		const nearest = Math.min(...ranked.map((item) => item.distance));
		return ranked.filter((item) => item.distance === nearest).map((item) => item.declaration);
	}

	private visibleInScope(facts: KotlinFile, declaration: Declaration, scopeId: string | undefined): boolean {
		if (declaration.containerId === undefined) return true;
		let current = scopeId;
		let guard = 0;
		while (current !== undefined) {
			if (current === declaration.containerId) return true;
			current = facts.scopeParents.get(current);
			guard++;
			if (guard > facts.scopeParents.size + 1) return false;
		}
		return false;
	}

	private typeOfSymbol(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE)
			return unknownType("ParseError", "the symbol id is not a Kotlin workspace id");
		const facts = this.factsForModule(parsed.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");
		const declaration = facts.declarations.find((candidate) => candidate.symbolId === symbolId);
		if (declaration === undefined) return unknownType("ParseError", "the symbol id has no Kotlin declaration");
		return this.typeForDeclaration(facts, declaration);
	}

	private typeForDeclaration(facts: KotlinFile, declaration: Declaration): TypeInfo {
		const answer = facts.typeFacts.find((fact) => fact.symbolId === declaration.symbolId)?.answer;
		if (answer === undefined)
			return unknownType(
				"NotImplemented",
				"Kotlin type inference is limited to declared types and literal properties",
			);
		return this.withTypeSymbol(facts.module, answer);
	}

	private withTypeSymbol(module: string, answer: TypeInfo): TypeInfo {
		if (answer.status !== "known") return answer;
		const typeName = simpleTypeName(answer.display);
		if (typeName === undefined) return answer;
		const facts = this.factsForModule(module);
		const local =
			facts?.declarations.filter(
				(declaration) =>
					declaration.name === typeName && ["class", "interface", "enum"].includes(declaration.kind),
			) ?? [];
		if (local.length === 1) return { ...answer, symbolId: (local[0] as Declaration).symbolId };
		const workspace: Declaration[] = [];
		for (const candidateModule of this.filesInWorkspace()) {
			const candidateFacts = this.factsForModule(candidateModule);
			for (const declaration of candidateFacts?.declarations ?? []) {
				if (
					declaration.name === typeName &&
					["class", "interface", "enum"].includes(declaration.kind) &&
					declaration.exported !== false
				)
					workspace.push(declaration);
			}
		}
		return workspace.length === 1 ? { ...answer, symbolId: (workspace[0] as Declaration).symbolId } : answer;
	}
}

export function handlersFor(provider: KotlinProvider): ProviderHandlers {
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

export function serveProvider(
	connection: ReturnType<typeof createMessageConnection>,
	provider = new KotlinProvider(),
): void {
	wireProvider(connection, handlersFor(provider));
}

export const serve = serveProvider;

if (import.meta.main) runProviderOnStdio(handlersFor(new KotlinProvider()));
