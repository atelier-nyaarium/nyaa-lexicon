// The wire face of the Bash provider.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	type Binding,
	DEFAULT_EXCLUDED_DIRECTORIES,
	type Declaration,
	defined,
	discoverByWalk,
	handlersFor,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportResolution,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
	notImplementedImportEdits,
	notImplementedMove,
	type Position,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	positionInRange,
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
import { bindBashReference } from "./binding.js";
import { type BashDeclaration, LANGUAGE, type ParsedBashFile, parseBash } from "./extract.js";

////////////////////////////////
//  Constants

const EXPANDS: Exclude<ImportResolution, { status: "resolved" }> = {
	status: "unresolved",
	reason: "RuntimeConstructed",
	detail: "the sourced path expands at run time",
};

const EXTENSIONS = [".sh", ".bash"];
const FILENAMES = [".bashrc", ".bash_profile", ".bash_aliases", ".bash_logout", ".profile"];
/** Interpreters an extensionless script's shebang may name, `env` looked through by the kit. */
const SHEBANGS = ["bash", "sh"];
const EXCLUDED_DIRECTORIES = {
	...DEFAULT_EXCLUDED_DIRECTORIES,
	anywhere: [...DEFAULT_EXCLUDED_DIRECTORIES.anywhere, "venv"],
};

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

/** POSIX and bash reserved words. Builtins are the shell's built-in commands, `true`/`false` excepted: those are literals. */
export const WORDS = {
	keywords: [
		"case",
		"coproc",
		"do",
		"done",
		"elif",
		"else",
		"esac",
		"fi",
		"for",
		"function",
		"if",
		"in",
		"select",
		"then",
		"time",
		"until",
		"while",
	],
	builtins: [
		"alias",
		"bg",
		"bind",
		"break",
		"builtin",
		"caller",
		"cd",
		"command",
		"compgen",
		"complete",
		"compopt",
		"continue",
		"declare",
		"dirs",
		"disown",
		"echo",
		"enable",
		"eval",
		"exec",
		"exit",
		"export",
		"fc",
		"fg",
		"getopts",
		"hash",
		"help",
		"history",
		"jobs",
		"kill",
		"let",
		"local",
		"logout",
		"mapfile",
		"popd",
		"printf",
		"pushd",
		"pwd",
		"read",
		"readarray",
		"readonly",
		"return",
		"set",
		"shift",
		"shopt",
		"source",
		"suspend",
		"test",
		"times",
		"trap",
		"type",
		"typeset",
		"ulimit",
		"umask",
		"unalias",
		"unset",
		"wait",
	],
	literals: ["false", "true"],
};

export const REFERENCE_ROLES = ["call", "read", "write", "import"] as const;

const TYPE_DISPLAY = {
	array: "array",
	assoc: "associative array",
	integer: "integer",
	nameref: "name reference",
} as const;

////////////////////////////////
//  Functions & Helpers

function contains(range: Range, position: Position): boolean {
	return positionInRange(range, position);
}

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function landed(module: string): ImportResolution {
	return { status: "resolved", landing: { kind: "module", module } };
}

function declarationWire(declaration: BashDeclaration): Declaration {
	const { declaredType: _type, ...wire } = declaration;
	return wire;
}

////////////////////////////////
//  Class

export class BashProvider {
	/** Sourced bindings use held facts. */
	readonly store = moduleStore<ParsedBashFile>({ read: (module, text) => parseBash(module, text) });

	initialize(_workspaceRoot: string) {
		return {
			providerId: "bash-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			filenames: FILENAMES,
			shebangs: SHEBANGS,
			excludedDirectories: EXCLUDED_DIRECTORIES,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string, scope?: string[]): { model: ProjectModel; project: null } {
		return {
			model: discoverByWalk(workspaceRoot, {
				extensions: EXTENSIONS,
				filenames: FILENAMES,
				shebangs: SHEBANGS,
				excludedDirectories: EXCLUDED_DIRECTORIES,
				scope,
			}),
			project: null,
		};
	}

	parseFile(params: { module: string; contentHash: string; text: string }, parsed: ParsedBashFile) {
		const references: Reference[] = [];
		const bindingContext = {
			factsFor: (module: string) => this.factsFor(module),
			resolveImport: (request: { fromModule: string; specifier: string }) => this.resolveImport(request),
		};
		for (const reference of parsed.references) {
			const binding = bindBashReference(params.module, parsed, reference, bindingContext);
			// An unbound command name is a program, not a symbol.
			if (reference.ofFunction && binding.status === "unbound") continue;
			references.push({
				name: reference.name,
				range: reference.range,
				role: reference.role,
				binding,
				...defined({ fromId: reference.fromId }),
				// No receiver or path syntax.
				qualified: false,
			});
		}
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: parsed.declarations.map(declarationWire),
			references,
			imports: parsed.imports,
			literals: parsed.literals,
			role: parsed.role,
			comments: parsed.comments,
			blankLines: parsed.blankLines,
			diagnostics: parsed.diagnostics,
		};
	}

	/** A sourced path resolves beside the file, then from the root; one that expands or globs cannot. */
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = params.specifier;
		// An unquoted pattern reads the same as a quoted path; only the file says which was written.
		const written = this.factsFor(params.fromModule)?.sources.filter((source) => source.specifier === specifier);
		const expands = written !== undefined && written.length > 0 && written.every((source) => !source.literal);
		if (expands || /[$`]/.test(specifier)) return EXPANDS;
		const root = this.store.root;
		if (path.isAbsolute(specifier)) {
			const module = workspaceModule(root, specifier);
			if (module === null) return { status: "external", packageName: specifier };
			return this.hasFile(module)
				? landed(module)
				: { status: "unresolved", reason: "NotIndexed", detail: `no workspace file at ${specifier}` };
		}
		const fromAbsolute = workspaceFile(root, params.fromModule);
		const directories = fromAbsolute === null ? [root] : [path.dirname(fromAbsolute), root];
		for (const directory of directories) {
			const module = workspaceModule(root, path.resolve(directory, specifier));
			if (module !== null && this.hasFile(module)) return landed(module);
		}
		return { status: "unresolved", reason: "NotIndexed", detail: `no workspace file matches ${specifier}` };
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const parsed = this.factsFor(params.module);
		if (parsed === null) return unbound("NotIndexed", "module is not indexed");
		const reference = parsed.references.find(
			(candidate) => candidate.name === params.name && contains(candidate.range, params.range.start),
		);
		if (reference !== undefined)
			return bindBashReference(params.module, parsed, reference, {
				factsFor: (module) => this.factsFor(module),
				resolveImport: (request) => this.resolveImport(request),
			});
		const declaration = parsed.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				contains(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
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

	importEdits(_params: ImportEditsRequest): ImportEditsResponse {
		return notImplementedImportEdits("Bash import planning is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("Bash arrange edits are not implemented");
	}

	private hasFile(module: string): boolean {
		const absolute = workspaceFile(this.store.root, module);
		return absolute !== null && existsSync(absolute) && statSync(absolute).isFile();
	}

	private factsFor(module: string): ParsedBashFile | null {
		return this.store.load(module) ?? null;
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
}

////////////////////////////////
//  Main

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new BashProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new BashProvider()));
