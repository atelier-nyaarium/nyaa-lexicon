import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	comparePositions,
	type Declaration,
	type Diagnostic,
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
	serveProvider,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import type { ImportBinding, ParsedFile, RawDeclaration, RawReference } from "./model.js";
import { parseRustFile } from "./parser.js";
import { RustProjectResolver } from "./project.js";

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
	comments: false,
	metrics: true,
	syntaxDiagnostics: true,
} as const;

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
	if (role === "call") return declaration.kind === "function" || declaration.kind === "method";
	if (role === "instantiate") return declaration.kind === "struct" || declaration.kind === "enum";
	if (role === "typeUse" || role === "implements")
		return ["struct", "enum", "interface", "class"].includes(declaration.kind);
	if (role === "write") return declaration.kind !== "constant" && declaration.languageKind !== "variant";
	return true;
}

function parseFailure(module: string, detail: string): ParsedFile {
	const diagnostic: Diagnostic = { severity: "error", message: detail, path: module };
	return {
		module,
		text: "",
		declarations: [],
		references: [],
		imports: [],
		literals: [],
		diagnostics: [diagnostic],
		rawDeclarations: [],
		rawReferences: [],
		importBindings: [],
		typeAnswers: new Map(),
		lineTokens: new Map(),
	};
}

export class RustProvider {
	private workspaceRoot = process.cwd();
	private resolver = new RustProjectResolver(this.workspaceRoot);
	private readonly parsedFacts = new Map<string, ParsedFile>();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.resolver = new RustProjectResolver(this.workspaceRoot);
		this.parsedFacts.clear();
		return {
			providerId: "rust-provider",
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
		return this.resolver.reset(this.workspaceRoot);
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const outline = params.depth === "outline";
		let facts: ParsedFile;
		try {
			facts = parseRustFile(params.module, params.text, outline ? "outline" : "full");
		} catch (error) {
			facts = parseFailure(params.module, error instanceof Error ? error.message : String(error));
		}
		this.parsedFacts.set(params.module, facts);
		const references = outline ? [] : this.wireReferences(facts);
		facts.references = references;
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references,
			imports: facts.imports,
			literals: facts.literals,
			diagnostics: facts.diagnostics,
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }) {
		return this.resolver.resolveImport(params.fromModule, params.specifier);
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unbound("NotIndexed", "module is not indexed");
		const raw = facts.rawReferences.find(
			(candidate) =>
				candidate.reference.name === params.name && contains(candidate.reference.range, params.range.start),
		);
		if (raw !== undefined) return this.bindingFor(facts, raw);
		const declaration = facts.rawDeclarations.find(
			(candidate) =>
				candidate.declaration.name === params.name &&
				contains(candidate.declaration.selectionRange, params.range.start),
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
				contains(candidate.declaration.selectionRange, params.range.start) ||
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

	private factsForModule(module: string): ParsedFile | null {
		const cached = this.parsedFacts.get(module);
		if (cached !== undefined) return cached;
		const absolute = this.safeWorkspaceModule(module);
		if (absolute === null || !existsSync(absolute) || !statSync(absolute).isFile()) return null;
		try {
			const facts = parseRustFile(module, readFileSync(absolute, "utf8"));
			this.parsedFacts.set(module, facts);
			return facts;
		} catch {
			return null;
		}
	}

	private safeWorkspaceModule(module: string): string | null {
		const absolute = path.resolve(this.workspaceRoot, ...module.split("/"));
		const relative = path.relative(this.workspaceRoot, absolute);
		return relative.startsWith("..") || path.isAbsolute(relative) ? null : absolute;
	}

	private wireReferences(facts: ParsedFile): Reference[] {
		return facts.rawReferences.map((raw) => ({ ...raw.reference, binding: this.bindingFor(facts, raw) }));
	}

	private bindingFor(facts: ParsedFile, raw: RawReference): Binding {
		if (
			raw.reference.binding.status === "unbound" &&
			["RuntimeConstructed", "ExternalDependency"].includes(raw.reference.binding.reason)
		)
			return raw.reference.binding;
		if (raw.path.length > 0) {
			const qualified = this.qualifiedCandidates(facts, raw);
			if (qualified.length > 1)
				return ambiguity(
					qualified.map((candidate) => candidate.declaration.symbolId),
					"multiple qualified declarations match this name",
				);
			const qualifiedCandidate = qualified[0];
			if (qualifiedCandidate !== undefined) return bound(qualifiedCandidate.declaration.symbolId);
		}
		const local = this.sameFileCandidates(facts, raw);
		if (local.length > 1)
			return ambiguity(
				local.map((candidate) => candidate.declaration.symbolId),
				"multiple declarations match this name in scope",
			);
		const localCandidate = local[0];
		if (localCandidate !== undefined) return bound(localCandidate.declaration.symbolId);
		const visibleImports = this.visibleImports(facts, raw);
		const directImports = visibleImports.filter((candidate) => !candidate.glob);
		const imports = directImports.length > 0 ? directImports : visibleImports;
		if (imports.length === 0) return unbound("NotIndexed", "no indexed declaration matches this name");
		const results: Binding[] = [];
		for (const imported of imports) results.push(...this.resolveImportBinding(facts, raw, imported));
		const boundResults = results.filter(
			(result): result is Extract<Binding, { status: "bound" }> => result.status === "bound",
		);
		const ambiguousResults = results.filter((result) => result.status === "ambiguous");
		if (ambiguousResults.length > 0) return ambiguousResults[0] as Binding;
		if (boundResults.length > 1)
			return ambiguity(
				boundResults.map((result) => result.symbolId),
				"multiple imports supply this name",
			);
		if (boundResults.length === 1) return boundResults[0] as Binding;
		return results[0] ?? unbound("NotIndexed", "the import target is not indexed");
	}

	private qualifiedCandidates(facts: ParsedFile, raw: RawReference): RawDeclaration[] {
		const receiver = raw.path.at(-1);
		if (receiver === undefined) return [];
		const localType = facts.rawDeclarations.find(
			(candidate) =>
				candidate.declaration.name === receiver &&
				["struct", "enum", "interface", "class"].includes(candidate.declaration.kind),
		);
		if (localType !== undefined) {
			return facts.rawDeclarations.filter(
				(candidate) =>
					candidate.declaration.name === raw.reference.name &&
					candidate.declaration.containerId === localType.declaration.symbolId &&
					declarationKindMatches(raw.reference.role, candidate.declaration),
			);
		}
		const imported = facts.importBindings.find(
			(candidate) => candidate.localName === receiver && candidate.sourceName !== null,
		);
		if (imported === undefined) return [];
		const module = this.importTargetModule(facts.module, imported);
		if (module === null) return [];
		const target = this.factsForModule(module);
		if (target === null) return [];
		const targetType = target.rawDeclarations.find(
			(candidate) =>
				candidate.declaration.name === imported.sourceName &&
				["struct", "enum", "interface", "class"].includes(candidate.declaration.kind),
		);
		if (targetType === undefined) return [];
		return target.rawDeclarations.filter(
			(candidate) =>
				candidate.declaration.name === raw.reference.name &&
				candidate.declaration.containerId === targetType.declaration.symbolId &&
				declarationKindMatches(raw.reference.role, candidate.declaration),
		);
	}

	private sameFileCandidates(facts: ParsedFile, raw: RawReference): RawDeclaration[] {
		return facts.rawDeclarations.filter((candidate) => {
			if (
				candidate.declaration.name !== raw.reference.name ||
				!declarationKindMatches(raw.reference.role, candidate.declaration)
			)
				return false;
			if (candidate.declaration.symbolId === raw.reference.fromId) return false;
			return this.visibleInScope(facts, raw.containerId, candidate.declaration.containerId);
		});
	}

	private visibleInScope(
		facts: ParsedFile,
		fromId: string | undefined,
		candidateContainer: string | undefined,
	): boolean {
		if (candidateContainer === undefined) return true;
		if (fromId === undefined) return false;
		const visible = new Set<string>();
		let current: string | undefined = fromId;
		while (current !== undefined && !visible.has(current)) {
			visible.add(current);
			const owner = facts.rawDeclarations.find((candidate) => candidate.declaration.symbolId === current);
			current = owner?.declaration.containerId;
		}
		return visible.has(candidateContainer);
	}

	private visibleImports(facts: ParsedFile, raw: RawReference): ImportBinding[] {
		return facts.importBindings.filter((binding) => {
			if (binding.glob) return true;
			if (
				binding.localName !== raw.reference.name &&
				!(raw.reference.role === "import" && binding.sourceName === raw.reference.name)
			)
				return false;
			return this.visibleInScope(facts, raw.containerId, binding.containerId);
		});
	}

	private resolveImportBinding(facts: ParsedFile, raw: RawReference, imported: ImportBinding): Binding[] {
		const module = this.importTargetModule(facts.module, imported);
		const resolution = this.resolver.resolveImport(facts.module, imported.path.join("::"));
		if (module === null) {
			if (resolution.status === "external")
				return [unbound("ExternalDependency", `crate ${resolution.packageName} is outside the workspace`)];
			return [
				unbound(
					resolution.status === "unresolved" ? resolution.reason : "NotIndexed",
					"the imported module is not indexed",
				),
			];
		}
		const target = this.factsForModule(module);
		if (target === null) return [unbound("NotIndexed", "the imported module is not indexed")];
		if (imported.glob) {
			const candidates = target.rawDeclarations
				.filter(
					(candidate) => candidate.declaration.containerId === undefined && candidate.declaration.name !== "",
				)
				.map((candidate) => candidate.declaration.symbolId);
			return [ambiguity(candidates, "a glob import can supply more than one declaration")];
		}
		const sourceName = imported.sourceName ?? raw.reference.name;
		const matches = target.rawDeclarations.filter(
			(candidate) => candidate.declaration.name === sourceName && candidate.declaration.containerId === undefined,
		);
		if (matches.length > 1)
			return [
				ambiguity(
					matches.map((candidate) => candidate.declaration.symbolId),
					"multiple imported declarations match this name",
				),
			];
		const match = matches[0];
		if (match !== undefined) return [bound(match.declaration.symbolId)];
		return [unbound("NotIndexed", `the imported declaration ${sourceName} is not indexed`)];
	}

	private importTargetModule(fromModule: string, imported: ImportBinding): string | null {
		const resolution = this.resolver.resolveImport(fromModule, imported.path.join("::"));
		if (resolution.status === "external") return null;
		const full = this.resolver.resolvePath(fromModule, imported.path);
		if (full !== null) {
			const facts = this.factsForModule(full);
			if (
				imported.glob ||
				imported.sourceName === null ||
				facts?.rawDeclarations.some((candidate) => candidate.declaration.name === imported.sourceName)
			)
				return full;
		}
		if (imported.path.length > 1) return this.resolver.resolvePath(fromModule, imported.path.slice(0, -1));
		return full;
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
			...(typeSymbol === undefined ? {} : { symbolId: typeSymbol }),
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
		const imported = facts.importBindings.find(
			(candidate) => candidate.localName === name && candidate.sourceName !== null,
		);
		if (imported === undefined) return undefined;
		const module = this.importTargetModule(facts.module, imported);
		if (module === null) return undefined;
		return this.factsForModule(module)?.rawDeclarations.find(
			(candidate) => candidate.declaration.name === imported.sourceName,
		)?.declaration.symbolId;
	}
}

export function handlersFor(provider: RustProvider): ProviderHandlers {
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

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new RustProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new RustProvider()));
