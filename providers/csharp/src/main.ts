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
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	type TypeInfo,
	type UnknownReason,
	serveProvider as wireServeProvider,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { type CsharpFacts, CsharpParser, type DeclarationMeta, LANGUAGE } from "./parser.js";

export const TIERS = {
	projectModel: true,
	declarations: true,
	references: true,
	imports: true,
	binding: true,
	types: true,
	literals: true,
	comments: false,
	metrics: true,
	syntaxDiagnostics: true,
} as const;

export const REFERENCE_ROLES = [
	"call",
	"read",
	"write",
	"import",
	"extends",
	"implements",
	"instantiate",
	"typeUse",
] as const;

const EXTENSIONS = [".cs"];
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".vs",
	".idea",
	"bin",
	"obj",
	"build",
	"dist",
	"node_modules",
	"packages",
	"TestResults",
	"Debug",
	"Release",
]);
const EXTERNAL_ROOTS = new Set([
	"Microsoft",
	"Newtonsoft",
	"NUnit",
	"System",
	"Windows",
	"Xunit",
	"xunit",
	"mscorlib",
	"netstandard",
]);
const TYPE_DECLARATION_KINDS = new Set(["class", "interface", "struct", "enum"]);
const MEMBER_KINDS = new Set(["method", "constructor", "property", "field", "event", "constant", "variable"]);
type Range = Declaration["range"];

function modulePath(root: string, absolute: string): string | null {
	const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
	if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) return null;
	return relative;
}

function safePath(root: string, module: string): string | null {
	const absolute = path.resolve(root, ...module.split("/"));
	const relative = path.relative(root, absolute);
	return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? null : absolute;
}

function walkFiles(root: string): { files: string[]; configFiles: string[] } {
	const files: string[] = [];
	const configFiles: string[] = [];
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const module = modulePath(root, absolute);
			if (module === null) continue;
			if (entry.name.endsWith(".cs")) files.push(module);
			if (entry.name.endsWith(".csproj") || entry.name.endsWith(".sln")) configFiles.push(module);
		}
	}
	visit(root);
	return { files: files.sort(), configFiles: configFiles.sort() };
}

function projectDiagnostic(root: string, message: string): ProjectModel {
	return { files: [], externalRoots: [], configFiles: [], diagnostics: [{ severity: "error", message, path: root }] };
}

function contains(range: Range, position: Range["start"]): boolean {
	// Inclusive both ends
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function unknown(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function typeDeclaration(declaration: Declaration): boolean {
	return (
		TYPE_DECLARATION_KINDS.has(declaration.kind) ||
		declaration.kind === "typeParameter" ||
		declaration.languageKind === "delegate"
	);
}

function isMember(declaration: Declaration): boolean {
	return MEMBER_KINDS.has(declaration.kind);
}

function isExternalSpecifier(specifier: string): boolean {
	const root = specifier.split(".")[0] ?? specifier;
	return EXTERNAL_ROOTS.has(root);
}

function typeOwner(meta: DeclarationMeta): string {
	return meta.typePath;
}

export class CsharpProvider {
	private workspaceRoot = process.cwd();
	private parsedFacts = new Map<string, CsharpFacts>();
	private discoveredFiles: string[] | null = null;

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.parsedFacts.clear();
		this.discoveredFiles = null;
		return {
			providerId: "csharp-provider",
			language: LANGUAGE,
			extensions: [...EXTENSIONS],
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.parsedFacts.clear();
		this.discoveredFiles = null;
		try {
			if (!existsSync(this.workspaceRoot))
				return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
			if (!statSync(this.workspaceRoot).isDirectory())
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			const walked = walkFiles(this.workspaceRoot);
			this.discoveredFiles = walked.files;
			return { files: walked.files, externalRoots: [], configFiles: walked.configFiles, diagnostics: [] };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return projectDiagnostic(this.workspaceRoot, `unable to inspect workspace root: ${detail}`);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const outline = params.depth === "outline";
		const facts = new CsharpParser(params.module, params.text, outline).parse();
		this.parsedFacts.set(params.module, facts);
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: outline
				? []
				: facts.references.map((reference) => ({
						...reference,
						binding: this.bindingForReference(params.module, facts, reference),
					})),
			imports: facts.imports.map(({ specifier, imported, reExport }) => ({ specifier, imported, reExport })),
			literals: outline ? [] : facts.literals,
			diagnostics: facts.diagnostics,
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const candidates: string[] = [];
		for (const module of this.filesForLookup()) {
			const facts = this.factsForModule(module);
			const declaresNamespace = facts?.namespaceNames.includes(params.specifier) ?? false;
			const declaresType = [...(facts?.metadata.values() ?? [])].some((meta) => {
				if (!typeDeclaration(meta.declaration)) return false;
				const parts = [meta.namespaceName, meta.typePath, meta.declaration.name].filter(Boolean);
				return parts.join(".") === params.specifier;
			});
			if (declaresNamespace || declaresType) candidates.push(module);
		}
		if (candidates.length === 1) return { status: "resolved", module: candidates[0] as string };
		if (candidates.length > 1)
			return {
				status: "unresolved",
				reason: "Ambiguous",
				detail: "multiple workspace files declare this namespace",
			};
		const root = params.specifier.split(".")[0] ?? params.specifier;
		if (EXTERNAL_ROOTS.has(root)) return { status: "external", packageName: params.specifier };
		return {
			status: "unresolved",
			reason: "NotIndexed",
			detail: `no workspace declaration matches namespace ${params.specifier}`,
		};
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unbound("NotIndexed", "module is not indexed");
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && contains(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(params.module, facts, reference);
		const declaration = facts.declarations.find(
			(candidate) => candidate.name === params.name && contains(candidate.selectionRange, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return unbound("NotIndexed", "no indexed reference or declaration matched the requested range");
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		const symbolId = "symbolId" in params ? params.symbolId : undefined;
		const parsedId = symbolId === undefined ? undefined : parseSymbolId(symbolId);
		if (symbolId !== undefined && parsedId?.language !== LANGUAGE)
			return unknown("ParseError", "the symbol id is not a C# workspace id");
		const module = symbolId === undefined ? ("module" in params ? params.module : undefined) : parsedId?.module;
		if (module === undefined) return unknown("ParseError", "the symbol id is not a C# workspace id");
		const facts = this.factsForModule(module);
		if (facts === null) return unknown("NotIndexed", "module is not indexed");
		const metadata =
			symbolId === undefined
				? [...facts.metadata.values()].filter(
						(item) =>
							"range" in params &&
							(contains(item.declaration.selectionRange, params.range.start) ||
								contains(item.declaration.range, params.range.start)),
					)
				: [facts.metadata.get(symbolId)].filter((item): item is DeclarationMeta => item !== undefined);
		if (metadata.length === 0) return unknown("NotIndexed", "no declaration matches the requested range");
		if (metadata.length > 1) {
			metadata.sort((left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset));
			const first = metadata[0] as DeclarationMeta;
			const second = metadata[1] as DeclarationMeta;
			if (first.endOffset - first.startOffset === second.endOffset - second.startOffset)
				return unknown("Ambiguous", "the requested range matches equally sized declarations");
			return this.typeForMetadata(module, facts, first);
		}
		return this.typeForMetadata(module, facts, metadata[0] as DeclarationMeta);
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C# rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("C# move edits are not implemented");
	}

	private filesForLookup(): string[] {
		if (this.discoveredFiles !== null) return this.discoveredFiles;
		try {
			this.discoveredFiles = walkFiles(this.workspaceRoot).files;
			return this.discoveredFiles;
		} catch {
			return [];
		}
	}

	private factsForModule(module: string): CsharpFacts | null {
		const cached = this.parsedFacts.get(module);
		if (cached !== undefined) return cached;
		const absolute = safePath(this.workspaceRoot, module);
		if (absolute === null || !existsSync(absolute)) return null;
		try {
			if (!statSync(absolute).isFile()) return null;
			const facts = new CsharpParser(module, readFileSync(absolute, "utf8")).parse();
			this.parsedFacts.set(module, facts);
			return facts;
		} catch {
			return null;
		}
	}

	private typeForMetadata(module: string, facts: CsharpFacts, meta: DeclarationMeta): TypeInfo {
		if (meta.typeText !== undefined) {
			if (meta.typeText.trim() === "dynamic")
				return unknown("DynamicallyTyped", "the declaration uses C# dynamic");
			const symbolId = this.resolveTypeSymbol(module, facts, meta.typeName);
			return {
				status: "known",
				display: meta.typeText,
				provenance: "declared",
				...(symbolId === undefined ? {} : { symbolId }),
			};
		}
		if (meta.inferredType !== undefined)
			return { status: "inferred", display: meta.inferredType, basis: "literal initializer" };
		if (meta.declaration.kind === "constructor")
			return { status: "known", display: meta.declaration.name, provenance: "declared" };
		return unknown("NotImplemented", "no explicit annotation or supported initializer inference");
	}

	private resolveTypeSymbol(module: string, facts: CsharpFacts, typeName: string | undefined): string | undefined {
		if (typeName === undefined) return undefined;
		const current = facts.declarations.filter(
			(declaration) => typeDeclaration(declaration) && declaration.name === typeName,
		);
		if (current.length === 1) return current[0]?.symbolId;
		const imports = facts.imports;
		const candidates = new Map<string, Declaration>();
		for (const imported of imports) {
			const target = this.resolveImport({ fromModule: module, specifier: imported.specifier });
			if (target.status !== "resolved") continue;
			const targetFacts = this.factsForModule(target.module);
			if (imported.alias === typeName) {
				const parts = imported.specifier.split(".");
				const targetName = parts.at(-1);
				const targetNamespace = parts.slice(0, -1).join(".");
				const aliasTarget = [...(targetFacts?.metadata.values() ?? [])].find(
					(meta) =>
						typeDeclaration(meta.declaration) &&
						meta.declaration.name === targetName &&
						meta.namespaceName === targetNamespace,
				);
				if (aliasTarget !== undefined) return aliasTarget.declaration.symbolId;
			}
			for (const declaration of targetFacts?.declarations ?? []) {
				if (typeDeclaration(declaration) && declaration.name === typeName)
					candidates.set(declaration.symbolId, declaration);
			}
		}
		return candidates.size === 1 ? candidates.values().next().value?.symbolId : undefined;
	}

	private bindingForReference(module: string, facts: CsharpFacts, reference: Reference): Binding {
		const metadata = facts.metadata;
		const from = reference.fromId === undefined ? undefined : metadata.get(reference.fromId);
		const candidates = this.sameFileCandidates(facts, reference, from);
		if (candidates.length === 1)
			return { status: "bound", symbolId: candidates[0]?.symbolId as string, provenance: "bound" };
		if (candidates.length > 1)
			return { status: "ambiguous", candidates: candidates.map((item) => item.symbolId), provenance: "bound" };
		const partials = this.partialCandidates(module, facts, reference, from);
		if (partials.length > 1)
			return { status: "ambiguous", candidates: partials.map((item) => item.symbolId), provenance: "bound" };
		if (partials.length === 1)
			return unbound("Ambiguous", "member lookup requires another partial type declaration");
		if (reference.role === "import") {
			return isExternalSpecifier(reference.name)
				? unbound("ExternalDependency", "the namespace is outside the workspace")
				: unbound("NotIndexed", "the namespace is not indexed");
		}
		const imported = this.importCandidates(module, facts, reference);
		if (imported.length === 1)
			return { status: "bound", symbolId: imported[0]?.symbolId as string, provenance: "bound" };
		if (imported.length > 1)
			return { status: "ambiguous", candidates: imported.map((item) => item.symbolId), provenance: "bound" };
		const importedResolution = this.referenceImportResolution(module, facts, reference);
		if (importedResolution?.status === "external")
			return unbound("ExternalDependency", "the reference comes from an external namespace");
		if (importedResolution?.status === "unresolved")
			return unbound(importedResolution.reason, importedResolution.detail ?? "the import is not indexed");
		if (reference.role === "read" || reference.role === "write" || reference.role === "call")
			return unbound("NotIndexed", "no declaration matches this C# reference");
		return unbound("NotIndexed", "no declaration matches this C# reference");
	}

	private referenceImportResolution(
		module: string,
		facts: CsharpFacts,
		reference: Reference,
	): ImportResolution | undefined {
		for (const imported of facts.imports) {
			if (imported.alias !== undefined && imported.alias !== reference.name) continue;
			if (isExternalSpecifier(imported.specifier)) return { status: "external", packageName: imported.specifier };
			if (imported.alias === reference.name)
				return {
					status: "unresolved",
					reason: "NotIndexed",
					detail: `no workspace declaration matches namespace ${imported.specifier}`,
				};
			const typeReference =
				reference.role === "typeUse" ||
				reference.role === "extends" ||
				reference.role === "implements" ||
				reference.role === "instantiate";
			const memberReference =
				(reference.role === "call" || reference.role === "read" || reference.role === "write") &&
				imported.static;
			if (!typeReference && !memberReference) continue;
			const resolution = this.resolveImport({ fromModule: module, specifier: imported.specifier });
			if (resolution.status !== "resolved") return resolution;
		}
		return undefined;
	}

	private sameFileCandidates(
		facts: CsharpFacts,
		reference: Reference,
		from: DeclarationMeta | undefined,
	): Declaration[] {
		const candidates: Declaration[] = [];
		const chain = this.containerChain(facts, from);
		for (const meta of facts.metadata.values()) {
			const declaration = meta.declaration;
			if (declaration.name !== reference.name || !this.roleMatches(reference.role, declaration)) continue;
			if (
				reference.role === "typeUse" ||
				reference.role === "extends" ||
				reference.role === "implements" ||
				reference.role === "instantiate"
			) {
				if (meta.namespaceName === (from?.namespaceName ?? "") || meta.namespaceName === "")
					candidates.push(declaration);
				continue;
			}
			if (declaration.containerId !== undefined && chain.has(declaration.containerId))
				candidates.push(declaration);
		}
		return this.uniqueDeclarations(candidates);
	}

	private partialCandidates(
		module: string,
		facts: CsharpFacts,
		reference: Reference,
		from: DeclarationMeta | undefined,
	): Declaration[] {
		if (from === undefined || reference.role === "typeUse" || reference.role === "instantiate") return [];
		let ownerMeta: DeclarationMeta | undefined = from;
		while (ownerMeta !== undefined && !TYPE_DECLARATION_KINDS.has(ownerMeta.declaration.kind)) {
			ownerMeta = ownerMeta.parentId === undefined ? undefined : facts.metadata.get(ownerMeta.parentId);
		}
		if (ownerMeta?.isPartial !== true) return [];
		const owner = typeOwner(from);
		if (owner === "") return [];
		const candidates: Declaration[] = [];
		for (const otherModule of this.filesForLookup()) {
			if (otherModule === module) continue;
			const other = this.factsForModule(otherModule);
			for (const meta of other?.metadata.values() ?? []) {
				if (
					meta.declaration.name === reference.name &&
					meta.typePath === owner &&
					this.roleMatches(reference.role, meta.declaration)
				)
					candidates.push(meta.declaration);
			}
		}
		return this.uniqueDeclarations(candidates);
	}

	private importCandidates(module: string, facts: CsharpFacts, reference: Reference): Declaration[] {
		if (reference.role === "import") return [];
		const candidates: Declaration[] = [];
		for (const imported of facts.imports) {
			if (imported.alias !== undefined && imported.alias !== reference.name) continue;
			if (isExternalSpecifier(imported.specifier)) continue;
			if (
				(reference.role === "call" || reference.role === "read" || reference.role === "write") &&
				!imported.static
			)
				continue;
			const resolution = this.resolveImport({ fromModule: module, specifier: imported.specifier });
			if (resolution.status !== "resolved") continue;
			const target = this.factsForModule(resolution.module);
			const targetParts = imported.specifier.split(".");
			const targetName = targetParts.at(-1);
			const targetNamespace = targetParts.slice(0, -1).join(".");
			const targetType = [...(target?.metadata.values() ?? [])].find(
				(meta) =>
					typeDeclaration(meta.declaration) &&
					meta.declaration.name === targetName &&
					meta.namespaceName === targetNamespace,
			);
			for (const meta of target?.metadata.values() ?? []) {
				if (!this.roleMatches(reference.role, meta.declaration)) continue;
				if (imported.alias !== undefined) {
					if (targetType?.declaration.symbolId === meta.declaration.symbolId)
						candidates.push(meta.declaration);
					continue;
				}
				if (imported.static) {
					if (
						meta.declaration.name === reference.name &&
						targetType?.declaration.symbolId === meta.declaration.containerId
					)
						candidates.push(meta.declaration);
					continue;
				}
				if (meta.declaration.name !== reference.name) continue;
				if (
					meta.namespaceName === imported.specifier ||
					meta.namespaceName.startsWith(`${imported.specifier}.`)
				)
					candidates.push(meta.declaration);
			}
		}
		return this.uniqueDeclarations(candidates);
	}

	private roleMatches(role: Reference["role"], declaration: Declaration): boolean {
		if (role === "call")
			return (
				declaration.kind === "method" || declaration.kind === "function" || declaration.kind === "constructor"
			);
		if (role === "read" || role === "write") return isMember(declaration);
		if (role === "extends")
			return declaration.kind === "class" || declaration.kind === "interface" || declaration.kind === "struct";
		if (role === "implements") return declaration.kind === "interface";
		if (role === "typeUse" || role === "instantiate") return typeDeclaration(declaration);
		return false;
	}

	private uniqueDeclarations(declarations: Declaration[]): Declaration[] {
		const unique = new Map<string, Declaration>();
		for (const declaration of declarations) unique.set(declaration.symbolId, declaration);
		return [...unique.values()];
	}

	private containerChain(facts: CsharpFacts, from: DeclarationMeta | undefined): Set<string> {
		const chain = new Set<string>();
		let current = from;
		if (current !== undefined) chain.add(current.declaration.symbolId);
		while (current?.parentId !== undefined) {
			chain.add(current.parentId);
			current = facts.metadata.get(current.parentId);
		}
		return chain;
	}
}

export function handlersFor(provider: CsharpProvider): ProviderHandlers {
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
	provider = new CsharpProvider(),
): void {
	wireServeProvider(connection, handlersFor(provider));
}

export const serve = serveProvider;

if (import.meta.main) runProviderOnStdio(handlersFor(new CsharpProvider()));
