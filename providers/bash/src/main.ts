// The wire face of the Bash provider.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	DEFAULT_EXCLUDED_DIRECTORIES,
	type Declaration,
	type Diagnostic,
	discoverByWalk,
	handlersFor,
	type ImportResolution,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type Position,
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
import { type BashDeclaration, type BashReference, LANGUAGE, type ParsedBashFile, parseBash } from "./extract.js";

////////////////////////////////
//  Constants

const EXTENSIONS = [".sh", ".bash"];
const FILENAMES = [".bashrc", ".bash_profile", ".bash_aliases", ".bash_logout", ".profile"];
const EXCLUDED_DIRECTORIES = new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ".venv", "venv"]);

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

export const REFERENCE_ROLES = ["call", "read", "write", "import"] as const;

const TYPE_DISPLAY = {
	array: "array",
	assoc: "associative array",
	integer: "integer",
	nameref: "name reference",
} as const;

////////////////////////////////
//  Functions & Helpers

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function bound(symbolId: string): Binding {
	return { status: "bound", symbolId, provenance: "bound" };
}

function contains(range: Range, position: Position): boolean {
	const afterStart =
		position.line > range.start.line ||
		(position.line === range.start.line && position.character >= range.start.character);
	const beforeEnd =
		position.line < range.end.line ||
		(position.line === range.end.line && position.character <= range.end.character);
	return afterStart && beforeEnd;
}

function declarationWire(declaration: BashDeclaration): Declaration {
	const { declaredType: _type, ...wire } = declaration;
	return wire;
}

function diagnosticForRead(module: string, error: unknown): Diagnostic {
	const detail = error instanceof Error ? error.message : String(error);
	return { severity: "error", message: `unable to read ${module}: ${detail}`, path: module };
}

function emptyFacts(module: string, diagnostic: Diagnostic): ParsedBashFile {
	return {
		module,
		text: "",
		declarations: [],
		references: [],
		imports: [],
		sources: [],
		literals: [],
		comments: [],
		diagnostics: [diagnostic],
		functionsByName: new Map(),
		globalsByName: new Map(),
	};
}

////////////////////////////////
//  Class

export class BashProvider {
	private workspaceRoot = process.cwd();
	private readonly facts = new Map<string, ParsedBashFile>();

	initialize(workspaceRoot: string) {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.facts.clear();
		return {
			providerId: "bash-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			filenames: FILENAMES,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.facts.clear();
		if (!existsSync(this.workspaceRoot))
			return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
		try {
			if (!statSync(this.workspaceRoot).isDirectory())
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			return discoverByWalk(this.workspaceRoot, {
				extensions: EXTENSIONS,
				filenames: FILENAMES,
				excludedDirectories: EXCLUDED_DIRECTORIES,
			});
		} catch (error) {
			return projectDiagnostic(
				this.workspaceRoot,
				`unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string }) {
		const parsed = parseBash(params.module, params.text);
		this.facts.set(params.module, parsed);
		const references: Reference[] = [];
		for (const reference of parsed.references) {
			const binding = this.bindReference(params.module, parsed, reference);
			// An unbound command name is a program, not a symbol.
			if (reference.ofFunction && binding.status === "unbound") continue;
			references.push({
				name: reference.name,
				range: reference.range,
				role: reference.role,
				binding,
				...(reference.fromId === undefined ? {} : { fromId: reference.fromId }),
			});
		}
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: parsed.declarations.map(declarationWire),
			references,
			imports: parsed.imports,
			literals: parsed.literals,
			comments: parsed.comments,
			diagnostics: parsed.diagnostics,
		};
	}

	/** A sourced path resolves beside the file, then from the root; an expanding one cannot. */
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = params.specifier;
		if (/[$`]/.test(specifier))
			return {
				status: "unresolved",
				reason: "RuntimeConstructed",
				detail: "the sourced path expands at run time",
			};
		if (path.isAbsolute(specifier)) {
			const module = workspaceModule(this.workspaceRoot, specifier);
			if (module === null) return { status: "external", packageName: specifier };
			return this.hasFile(module)
				? { status: "resolved", module }
				: { status: "unresolved", reason: "NotIndexed", detail: `no workspace file at ${specifier}` };
		}
		const fromAbsolute = workspaceFile(this.workspaceRoot, params.fromModule);
		const directories =
			fromAbsolute === null ? [this.workspaceRoot] : [path.dirname(fromAbsolute), this.workspaceRoot];
		for (const directory of directories) {
			const module = workspaceModule(this.workspaceRoot, path.resolve(directory, specifier));
			if (module !== null && this.hasFile(module)) return { status: "resolved", module };
		}
		return { status: "unresolved", reason: "NotIndexed", detail: `no workspace file matches ${specifier}` };
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const parsed = this.factsFor(params.module);
		if (parsed === null) return unbound("NotIndexed", "module is not indexed");
		const reference = parsed.references.find(
			(candidate) => candidate.name === params.name && contains(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindReference(params.module, parsed, reference);
		const declaration = parsed.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				contains(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return bound(declaration.symbolId);
		return unbound("NotIndexed", "no indexed reference or declaration matched the requested range");
	}

	/** Only `declare` says a type; every other shell variable is a string at run time. */
	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		const declaration = "symbolId" in params ? this.declarationById(params.symbolId) : this.declarationAt(params);
		if (declaration === null)
			return { status: "unknown", reason: "NotIndexed", detail: "no indexed declaration matched the request" };
		if (declaration.declaredType !== undefined)
			return { status: "known", display: TYPE_DISPLAY[declaration.declaredType], provenance: "declared" };
		return {
			status: "unknown",
			reason: "DynamicallyTyped",
			detail: "a shell variable is a string unless declared otherwise",
		};
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "Bash rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "Bash move edits are not implemented" };
	}

	private hasFile(module: string): boolean {
		const absolute = workspaceFile(this.workspaceRoot, module);
		return absolute !== null && existsSync(absolute) && statSync(absolute).isFile();
	}

	private factsFor(module: string): ParsedBashFile | null {
		const cached = this.facts.get(module);
		if (cached !== undefined) return cached;
		const absolute = workspaceFile(this.workspaceRoot, module);
		if (absolute === null || !this.hasFile(module)) return null;
		let parsed: ParsedBashFile;
		try {
			parsed = parseBash(module, readFileSync(absolute, "utf8"));
		} catch (error) {
			parsed = emptyFacts(module, diagnosticForRead(module, error));
		}
		this.facts.set(module, parsed);
		return parsed;
	}

	private declarationById(symbolId: string): BashDeclaration | null {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE) return null;
		const facts = this.factsFor(parsed.module);
		return facts?.declarations.find((declaration) => declaration.symbolId === symbolId) ?? null;
	}

	private declarationAt(params: { module: string; range: Range }): BashDeclaration | null {
		const facts = this.factsFor(params.module);
		return (
			facts?.declarations.find((declaration) =>
				contains(declaration.selectionRange ?? declaration.range, params.range.start),
			) ?? null
		);
	}

	/** Same file first, then every file this one sources, transitively, in source order. */
	private bindReference(module: string, parsed: ParsedBashFile, reference: BashReference): Binding {
		if (reference.role === "import") return this.importBinding(module, reference.name);
		if (reference.target !== undefined) return bound(reference.target);
		const candidates: string[] = [];
		let reason: UnknownReason = "NotIndexed";
		let detail = `no bash declaration matches ${reference.name}`;
		const report = (status: Exclude<ImportResolution, { status: "resolved" }>, specifier: string) => {
			if (status.status === "external") {
				reason = "ExternalDependency";
				detail = `${reference.name} may come from ${specifier}, outside the workspace`;
			} else {
				reason = status.reason;
				detail = status.detail ?? detail;
			}
		};
		for (const target of this.sourcedFacts(module, parsed, new Set([module]), report)) {
			const held = reference.ofFunction
				? target.functionsByName.get(reference.name)?.at(-1)
				: target.globalsByName.get(reference.name);
			if (held !== undefined) candidates.push(held.symbolId);
		}
		if (candidates.length === 1) return bound(candidates[0] as string);
		if (candidates.length > 1) return { status: "ambiguous", candidates, provenance: "bound" };
		return unbound(reason, detail);
	}

	/** The files a module sources, each followed by what it sources in turn; a file is read once. */
	private sourcedFacts(
		module: string,
		parsed: ParsedBashFile,
		visited: Set<string>,
		report: (status: Exclude<ImportResolution, { status: "resolved" }>, specifier: string) => void,
	): ParsedBashFile[] {
		const found: ParsedBashFile[] = [];
		for (const source of parsed.sources) {
			const resolution = this.resolveImport({ fromModule: module, specifier: source.specifier });
			if (resolution.status !== "resolved") {
				report(resolution, source.specifier);
				continue;
			}
			if (visited.has(resolution.module)) continue;
			visited.add(resolution.module);
			const target = this.factsFor(resolution.module);
			if (target === null) continue;
			found.push(target, ...this.sourcedFacts(resolution.module, target, visited, report));
		}
		return found;
	}

	private importBinding(module: string, specifier: string): Binding {
		const resolution = this.resolveImport({ fromModule: module, specifier });
		if (resolution.status === "external")
			return unbound("ExternalDependency", "the sourced file is outside the workspace");
		if (resolution.status === "unresolved")
			return unbound(resolution.reason, resolution.detail ?? "the sourced path is unresolved");
		return unbound("NotIndexed", "a sourced path names a module, not a declaration");
	}
}

////////////////////////////////
//  Main

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new BashProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new BashProvider()));
