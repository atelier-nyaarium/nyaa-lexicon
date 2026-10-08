// The wire face of the Bash provider.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	type Binding,
	comparePositions,
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
	type BashDeclaration,
	type BashReference,
	LANGUAGE,
	type ParsedBashFile,
	parseBash,
	type SourceImport,
} from "./extract.js";

////////////////////////////////
//  Interfaces & Types

type Unresolved = Exclude<ImportResolution, { status: "resolved" }>;

/** One reference settling across the files a module sources. */
interface Settling {
	reference: BashReference;
	report: (status: Unresolved, specifier: string) => void;
	/** What each sourced file leaves, by module, so a file sourced on two paths is read once. */
	memo: Map<string, string | undefined>;
}

/** A file's own definition of a name, and where it last took effect. */
interface Binder {
	symbolId: string;
	/** Absent when it took no effect before the read. */
	at?: Position;
}

////////////////////////////////
//  Constants

const EXPANDS: Unresolved = {
	status: "unresolved",
	reason: "RuntimeConstructed",
	detail: "the sourced path expands at run time",
};

const EXTENSIONS = [".sh", ".bash"];
const FILENAMES = [".bashrc", ".bash_profile", ".bash_aliases", ".bash_logout", ".profile"];
/** Interpreters an extensionless script's shebang may name, `env` looked through by the kit. */
const SHEBANGS = ["bash", "sh"];
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

function landed(module: string): ImportResolution {
	return { status: "resolved", landing: { kind: "module", module } };
}

/** Where a definition last took effect, before `before` when given: a variable at its last top-level write. */
function binderOf(facts: ParsedBashFile, declaration: BashDeclaration, before?: Position): Binder {
	let at: Position | undefined;
	const consider = (position: Position) => {
		if (before !== undefined && comparePositions(position, before) >= 0) return;
		if (at === undefined || comparePositions(position, at) > 0) at = position;
	};
	consider(declaration.range.start);
	if (declaration.kind !== "function") {
		for (const reference of facts.references) {
			if (
				reference.role === "write" &&
				reference.fromId === undefined &&
				reference.target === declaration.symbolId
			)
				consider(reference.range.start);
		}
	}
	return { symbolId: declaration.symbolId, ...defined({ at }) };
}

/** A sourced file's own definition: its last function of the name, or its variable. */
function ownDefinition(facts: ParsedBashFile, reference: BashReference): Binder | undefined {
	const declaration = reference.ofFunction
		? facts.functionsByName.get(reference.name)?.at(-1)
		: facts.globalsByName.get(reference.name);
	return declaration === undefined ? undefined : binderOf(facts, declaration);
}

function declarationWire(declaration: BashDeclaration): Declaration {
	const { declaredType: _type, ...wire } = declaration;
	return wire;
}

function discover(root: string, scope?: string[]): ProjectModel {
	if (!existsSync(root)) return projectDiagnostic(root, `workspace root does not exist: ${root}`);
	try {
		if (!statSync(root).isDirectory()) return projectDiagnostic(root, `workspace root is not a directory: ${root}`);
		return discoverByWalk(root, {
			extensions: EXTENSIONS,
			filenames: FILENAMES,
			shebangs: SHEBANGS,
			excludedDirectories: EXCLUDED_DIRECTORIES,
			scope,
		});
	} catch (error) {
		return projectDiagnostic(
			root,
			`unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
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
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string, scope?: string[]): { model: ProjectModel; project: null } {
		return { model: discover(path.resolve(workspaceRoot), scope), project: null };
	}

	parseFile(params: { module: string; contentHash: string; text: string }, parsed: ParsedBashFile) {
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

	/** At the top level, the last definition or source before the read; in a body, the file's own first. */
	private bindReference(module: string, parsed: ParsedBashFile, reference: BashReference): Binding {
		if (reference.role === "import") return this.importBinding(module, reference.name);
		const target = reference.target;
		// A write names the variable it assigns, whatever a source left.
		if (target !== undefined && (reference.fromId !== undefined || reference.role === "write"))
			return bound(target);
		let reason: UnknownReason = "NotIndexed";
		let detail = `no bash declaration matches ${reference.name}`;
		const settling: Settling = {
			reference,
			memo: new Map(),
			report: (status, specifier) => {
				if (status.status === "external") {
					reason = "ExternalDependency";
					detail = `${reference.name} may come from ${specifier}, outside the workspace`;
				} else {
					reason = status.reason;
					detail = status.detail ?? detail;
				}
			},
		};
		const visiting = new Set([module]);
		// A function body may run after any source, so each source's definition stands.
		if (reference.fromId !== undefined) {
			const candidates = new Set<string>();
			for (const source of parsed.sources) {
				const settled = this.settledThrough(settling, module, source, visiting);
				if (settled !== undefined) candidates.add(settled);
			}
			if (candidates.size > 1) return { status: "ambiguous", candidates: [...candidates], provenance: "bound" };
			const [only] = candidates;
			return only === undefined ? unbound(reason, detail) : bound(only);
		}
		const declaration = parsed.declarations.find((candidate) => candidate.symbolId === target);
		const own = declaration === undefined ? undefined : binderOf(parsed, declaration, reference.range.start);
		const settled = this.settledIn(settling, module, parsed, own, reference.range.start, visiting);
		return settled === undefined ? unbound(reason, detail) : bound(settled);
	}

	/**
	 * What running `facts` up to `before`, or whole, leaves: the last of its own definition and the
	 * sources that bring the name.
	 */
	private settledIn(
		s: Settling,
		module: string,
		facts: ParsedBashFile,
		own: Binder | undefined,
		before: Position | undefined,
		visiting: ReadonlySet<string>,
	): string | undefined {
		let settled = own?.symbolId;
		let since = own?.at;
		for (const source of facts.sources) {
			const at = source.range.start;
			if (before !== undefined && comparePositions(at, before) >= 0) continue;
			if (since !== undefined && comparePositions(at, since) < 0) continue;
			const through = this.settledThrough(s, module, source, visiting);
			if (through === undefined) continue;
			settled = through;
			since = at;
		}
		return settled;
	}

	/** What one source leaves once its file has run. */
	private settledThrough(
		s: Settling,
		module: string,
		source: SourceImport,
		visiting: ReadonlySet<string>,
	): string | undefined {
		const resolution = this.resolveImport({ fromModule: module, specifier: source.specifier });
		if (resolution.status !== "resolved") {
			s.report(resolution, source.specifier);
			return undefined;
		}
		const { landing } = resolution;
		if (landing.kind !== "module" || visiting.has(landing.module)) return undefined;
		if (s.memo.has(landing.module)) return s.memo.get(landing.module);
		const target = this.factsFor(landing.module);
		const settled =
			target === null
				? undefined
				: this.settledIn(
						s,
						landing.module,
						target,
						ownDefinition(target, s.reference),
						undefined,
						new Set([...visiting, landing.module]),
					);
		s.memo.set(landing.module, settled);
		return settled;
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
