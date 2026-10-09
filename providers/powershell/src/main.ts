// The wire face of the PowerShell provider.

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
import { keyOf, type MemberFilter, wildcardMatches } from "./context.js";
import {
	LANGUAGE,
	type ParsedPowerShellFile,
	type PowerShellDeclaration,
	type PowerShellReference,
	parsePowerShellFile,
	type SourceImport,
} from "./extract.js";
import { membersOf, parameterOf } from "./scope.js";

////////////////////////////////
//  Interfaces & Types

type Unresolved = Exclude<ImportResolution, { status: "resolved" }>;

type MemberKind = "function" | "variable";

/** Where a binding lands: the scope a file runs in, or the global scope that scope's own names shadow. */
type Level = "scope" | "global";

/** What a brought-in file passes through on its way to the file that binds. */
interface Through {
	/** The modules it came in through, whose exports decide what an importer sees. */
	gates: ParsedPowerShellFile[];
	/** The `Import-Module` member filters it came in through. */
	filters: MemberFilter[];
	/** Runs in a module's session state, where an import lands in the module's own scope. */
	inModule: boolean;
}

/** One name settling across the files a module brings in. */
interface Settling {
	kind: MemberKind;
	name: string;
	report: (status: Unresolved, specifier: string) => void;
	/** What each file leaves, by module, name and what it came through, so a shared file is read once. */
	memo: Map<string, Left>;
}

/** What a run leaves for one name: the last binding in each scope it reaches. */
interface Left {
	scope?: PowerShellDeclaration;
	global?: PowerShellDeclaration;
	/** In the importer's scope, by a manifest's scripts. */
	caller?: PowerShellDeclaration;
}

/** A file's own definition of a name, and where it last took effect. */
interface Binder {
	declaration: PowerShellDeclaration;
	at: Position;
}

////////////////////////////////
//  Constants

const EXTENSIONS = [".ps1", ".psm1", ".psd1"];
const SHEBANGS = ["pwsh", "powershell"];
const EXCLUDED_DIRECTORIES = DEFAULT_EXCLUDED_DIRECTORIES;

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

/** Type names PowerShell ships as accelerators; a reference to one names no workspace type. */
const ACCELERATORS = [
	"array",
	"bigint",
	"bool",
	"byte",
	"char",
	"datetime",
	"decimal",
	"double",
	"float",
	"guid",
	"hashtable",
	"int",
	"int16",
	"int32",
	"int64",
	"ipaddress",
	"long",
	"object",
	"ordered",
	"pscustomobject",
	"psobject",
	"ref",
	"regex",
	"sbyte",
	"scriptblock",
	"securestring",
	"single",
	"string",
	"timespan",
	"type",
	"uint16",
	"uint32",
	"uint64",
	"uri",
	"version",
	"void",
	"xml",
];

export const WORDS = {
	keywords: [
		"begin",
		"break",
		"catch",
		"class",
		"clean",
		"configuration",
		"continue",
		"data",
		"define",
		"do",
		"dynamicparam",
		"else",
		"elseif",
		"end",
		"enum",
		"exit",
		"filter",
		"finally",
		"for",
		"foreach",
		"from",
		"function",
		"hidden",
		"if",
		"in",
		"inlinescript",
		"parallel",
		"param",
		"process",
		"return",
		"sequence",
		"static",
		"switch",
		"throw",
		"trap",
		"try",
		"until",
		"using",
		"var",
		"while",
		"workflow",
	],
	builtins: ACCELERATORS,
	literals: ["false", "null", "true"],
};

export const REFERENCE_ROLES = ["call", "read", "write", "extends", "implements", "instantiate", "typeUse"] as const;

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

function declarationWire(declaration: PowerShellDeclaration): Declaration {
	const {
		declaredType: _declared,
		inferredType: _inferred,
		members: _members,
		parameters: _parameters,
		...wire
	} = declaration;
	return wire;
}

function discover(root: string, scope?: string[]): ProjectModel {
	if (!existsSync(root)) return projectDiagnostic(root, `workspace root does not exist: ${root}`);
	try {
		if (!statSync(root).isDirectory()) return projectDiagnostic(root, `workspace root is not a directory: ${root}`);
		return discoverByWalk(root, {
			extensions: EXTENSIONS,
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

/** A path a script names, `$PSScriptRoot` read as its own folder and `\` as `/`. */
function normalizedPath(specifier: string): { path: string; besideScript: boolean } {
	const forward = specifier.split("\\").join("/");
	const root = /^\$\{?psscriptroot\}?/i.exec(forward);
	if (root === null) return { path: forward, besideScript: false };
	return { path: `.${forward.slice(root[0].length)}`, besideScript: true };
}

function isPathLike(specifier: string): boolean {
	return specifier.includes("/") || specifier.includes("\\") || /\.(ps1|psm1|psd1|dll)$/i.test(specifier);
}

/**
 * Whether a module lets a name out to its importer: a function unless its list says otherwise, a
 * variable only as listed, and a manifest lets through what it does not list.
 */
function exports(gate: ParsedPowerShellFile, kind: MemberKind, name: string): boolean {
	const patterns = kind === "function" ? gate.exportedFunctions : gate.exportedVariables;
	if (patterns === undefined) return kind === "function" || keyOf(gate.module).endsWith(".psd1");
	return [...patterns].some((pattern) => wildcardMatches(pattern, name));
}

function admits(filter: MemberFilter, kind: MemberKind, name: string): boolean {
	const patterns = kind === "function" ? filter.functions : filter.variables;
	return patterns.some((pattern) => wildcardMatches(pattern, name));
}

/** What `through` lets out, as a memo key. */
function signature(through: Through): string {
	return JSON.stringify([through.gates.map((gate) => gate.module), through.filters, through.inModule]);
}

/** Nothing between a file and what it runs in its own scope. */
function direct(module: string): Through {
	const key = keyOf(module);
	return { gates: [], filters: [], inModule: key.endsWith(".psm1") || key.endsWith(".psd1") };
}

/** Where a module import's names land: a script imports into the global scope, a module into its own. */
function importLevel(source: SourceImport, through: Through): Level {
	if (source.scope !== undefined) return source.scope === "local" ? "scope" : "global";
	return through.inModule ? "scope" : "global";
}

/** `Verb-PNoun` read back as `Verb-Noun`, and `PName` with no verb as `Name`; none without the prefix. */
function unprefixed(name: string, prefix: string): string | undefined {
	const dash = name.indexOf("-");
	const verb = dash < 0 ? "" : name.slice(0, dash + 1);
	const noun = name.slice(verb.length);
	if (noun.length <= prefix.length || !keyOf(noun).startsWith(keyOf(prefix))) return undefined;
	return verb + noun.slice(prefix.length);
}

/** The name a module import reaches for `sought`: a command's without its prefix, a variable's as written. */
function importedName(sought: Pick<Settling, "kind" | "name">, source: SourceImport): string | undefined {
	const prefix = source.prefix;
	if (sought.kind === "variable" || prefix === undefined) return sought.name;
	return prefix.kind === "static" ? unprefixed(sought.name, prefix.text) : undefined;
}

/** Where a definition last took effect, before `before` when given: a variable at its last top-level write. */
function binderOf(
	facts: ParsedPowerShellFile,
	declaration: PowerShellDeclaration,
	before?: Position,
): Binder | undefined {
	let at: Position | undefined;
	const consider = (position: Position) => {
		if (before !== undefined && comparePositions(position, before) >= 0) return;
		if (at === undefined || comparePositions(position, at) > 0) at = position;
	};
	consider(declaration.range.start);
	if (declaration.kind === "variable") {
		for (const reference of facts.references) {
			if (
				reference.role === "write" &&
				reference.of.kind === "variable" &&
				reference.fromId === undefined &&
				reference.target === declaration.symbolId
			)
				consider(reference.range.start);
		}
	}
	return at === undefined ? undefined : { declaration, at };
}

/** A script's own scope shadows the global one. */
function visible(left: Left): PowerShellDeclaration | undefined {
	return left.scope ?? left.global;
}

/** The function or variable a reference settles on; a parameter settles its command. */
function soughtBy(reference: PowerShellReference): Pick<Settling, "kind" | "name"> | undefined {
	switch (reference.of.kind) {
		case "command":
			return { kind: "function", name: reference.name };
		case "variable":
			return { kind: "variable", name: reference.name };
		case "parameter":
			return { kind: "function", name: reference.of.command };
		case "type":
		case "member":
			return undefined;
	}
}

/** A file's own definition of the name, as far as what it came through lets out. */
function ownDefinition(
	facts: ParsedPowerShellFile,
	through: Through,
	sought: Pick<Settling, "kind" | "name">,
): Binder | undefined {
	const { kind, name } = sought;
	const declaration =
		kind === "function"
			? facts.functionsByName
					.get(keyOf(name))
					?.filter((definition) => definition.visibility === "public")
					.at(-1)
			: facts.variablesByName.get(keyOf(name));
	if (declaration === undefined) return undefined;
	const shown =
		through.gates.every((gate) => exports(gate, kind, declaration.name)) &&
		through.filters.every((filter) => admits(filter, kind, declaration.name));
	return shown ? binderOf(facts, declaration) : undefined;
}

/** What a reachable file holds for a type or member reference. */
function typeCandidates(facts: ParsedPowerShellFile, reference: PowerShellReference): PowerShellDeclaration[] {
	if (reference.of.kind === "member")
		return membersOf(facts.typesByName, reference.of.typeName, reference.name, reference.of.arity);
	const type = facts.typesByName.get(keyOf(reference.name));
	return type === undefined ? [] : [type];
}

/** A reference whose target the file cannot name, and that only a declaration makes a symbol. */
function dropsWhenUnbound(reference: PowerShellReference): boolean {
	switch (reference.of.kind) {
		// An unbound command is a program or a cmdlet, not a symbol; so is an unbound type, member or
		// argument, which a .NET type or a cmdlet owns.
		case "command":
		case "type":
		case "member":
		case "parameter":
			return true;
		case "variable":
			return false;
	}
}

////////////////////////////////
//  Class

export class PowerShellProvider {
	readonly store = moduleStore<ParsedPowerShellFile>({ read: (module, text) => parsePowerShellFile(module, text) });

	initialize(_workspaceRoot: string) {
		return {
			providerId: "powershell-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			filenames: [],
			shebangs: SHEBANGS,
			excludedDirectories: EXCLUDED_DIRECTORIES,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string, scope?: string[]): { model: ProjectModel; project: null } {
		return { model: discover(path.resolve(workspaceRoot), scope), project: null };
	}

	parseFile(params: { module: string; contentHash: string; text: string }, parsed: ParsedPowerShellFile) {
		const references: Reference[] = [];
		for (const reference of parsed.references) {
			const binding = this.bindReference(params.module, parsed, reference);
			if (binding.status === "unbound" && dropsWhenUnbound(reference)) continue;
			references.push({
				name: reference.name,
				range: reference.range,
				role: reference.role,
				binding,
				...defined({ fromId: reference.fromId }),
				qualified: reference.qualified,
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

	/**
	 * A path resolves beside the file, then from the root; a module name, to the workspace's module
	 * of that name.
	 */
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = params.specifier;
		if (/[$`]/.test(normalizedPath(specifier).path))
			return { status: "unresolved", reason: "RuntimeConstructed", detail: "the path expands at run time" };
		const root = this.store.root;
		if (!isPathLike(specifier)) {
			const named = this.modulesNamed(specifier);
			if (named.length === 1) return landed(named[0] as string);
			if (named.length > 1)
				return {
					status: "unresolved",
					reason: "Ambiguous",
					detail: `${named.length} workspace modules are named ${specifier}`,
				};
			return { status: "external", packageName: specifier };
		}
		const { path: relative } = normalizedPath(specifier);
		if (path.isAbsolute(relative) || /^[A-Za-z]:\//.test(relative)) {
			const module = workspaceModule(root, relative);
			if (module === null) return { status: "external", packageName: specifier };
			return this.hasFile(module)
				? landed(module)
				: { status: "unresolved", reason: "NotIndexed", detail: `no workspace file at ${specifier}` };
		}
		const fromAbsolute = workspaceFile(root, params.fromModule);
		const directories = fromAbsolute === null ? [root] : [path.dirname(fromAbsolute), root];
		for (const directory of directories) {
			const module = workspaceModule(root, path.resolve(directory, relative));
			if (module !== null && this.hasFile(module)) return landed(module);
			// A module folder: its manifest, else its module file.
			for (const inside of this.moduleFolderFiles(directory, relative)) {
				if (this.hasFile(inside)) return landed(inside);
			}
		}
		return { status: "unresolved", reason: "NotIndexed", detail: `no workspace file matches ${specifier}` };
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const parsed = this.factsFor(params.module);
		if (parsed === null) return unbound("NotIndexed", "module is not indexed");
		const reference = parsed.references.find(
			(candidate) =>
				keyOf(candidate.name) === keyOf(params.name) && contains(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindReference(params.module, parsed, reference);
		const declaration = parsed.declarations.find(
			(candidate) =>
				keyOf(candidate.name) === keyOf(params.name) &&
				contains(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return bound(declaration.symbolId);
		return unbound("NotIndexed", "no indexed reference or declaration matched the requested range");
	}

	/** A type constraint says a type; a value, or what a function outputs, infers one. */
	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		const declaration = "symbolId" in params ? this.declarationById(params.symbolId) : this.declarationAt(params);
		const module = "symbolId" in params ? parseSymbolId(params.symbolId)?.module : params.module;
		if (declaration === null || module === undefined)
			return { status: "unknown", reason: "NotIndexed", detail: "no indexed declaration matched the request" };
		if (declaration.declaredType !== undefined) {
			const symbolId = this.typeSymbol(module, declaration.declaredType);
			return {
				status: "known",
				display: declaration.declaredType,
				provenance: "declared",
				...defined({ symbolId }),
			};
		}
		if (declaration.inferredType !== undefined) {
			const symbolId = this.typeSymbol(module, declaration.inferredType);
			return {
				status: "inferred",
				display: declaration.inferredType,
				basis: declaration.inferredBasis ?? "usage",
				...defined({ symbolId }),
			};
		}
		return {
			status: "unknown",
			reason: "DynamicallyTyped",
			detail: "no type constraint, value or output names a type",
		};
	}

	/** The class a type name reaches from a module: its own, else one a file it brings in declares. */
	private typeSymbol(module: string, typeName: string): string | undefined {
		const facts = this.factsFor(module);
		if (facts === null) return undefined;
		const own = facts.typesByName.get(keyOf(typeName));
		if (own !== undefined) return own.symbolId;
		const zero = { line: 0, character: 0 };
		const binding = this.bindReference(module, facts, {
			name: typeName,
			range: { start: zero, end: zero },
			role: "typeUse",
			of: { kind: "type" },
			qualified: false,
		});
		return binding.status === "bound" ? binding.symbolId : undefined;
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "PowerShell rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "PowerShell move edits are not implemented" };
	}

	importEdits(_params: ImportEditsRequest): ImportEditsResponse {
		return notImplementedImportEdits("PowerShell import planning is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("PowerShell arrange edits are not implemented");
	}

	private hasFile(module: string): boolean {
		const absolute = workspaceFile(this.store.root, module);
		return absolute !== null && existsSync(absolute) && statSync(absolute).isFile();
	}

	/** `Folder` naming a module folder: `Folder/Folder.psd1`, then `Folder/Folder.psm1`. */
	private moduleFolderFiles(directory: string, relative: string): string[] {
		const folder = path.resolve(directory, relative);
		const base = path.basename(folder);
		return [".psd1", ".psm1"].flatMap((extension) => {
			const module = workspaceModule(this.store.root, path.join(folder, `${base}${extension}`));
			return module === null ? [] : [module];
		});
	}

	/** Workspace modules a name imports: its manifest where one exists, else its module file. */
	private modulesNamed(name: string): string[] {
		const index = this.store.memo("modulesByName", () => {
			const byName = new Map<string, string[]>();
			for (const module of this.store.modules()) {
				const extension = path.extname(module).toLowerCase();
				if (extension !== ".psd1" && extension !== ".psm1") continue;
				const key = keyOf(path.basename(module, path.extname(module)));
				byName.set(key, [...(byName.get(key) ?? []), module]);
			}
			return byName;
		});
		const found = index.get(keyOf(name)) ?? [];
		const manifests = found.filter((module) => module.toLowerCase().endsWith(".psd1"));
		return manifests.length > 0 ? manifests : found;
	}

	private factsFor(module: string): ParsedPowerShellFile | null {
		return this.store.load(module) ?? null;
	}

	private declarationById(symbolId: string): PowerShellDeclaration | null {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE) return null;
		const facts = this.factsFor(parsed.module);
		return facts?.declarations.find((declaration) => declaration.symbolId === symbolId) ?? null;
	}

	private declarationAt(params: { module: string; range: Range }): PowerShellDeclaration | null {
		const facts = this.factsFor(params.module);
		return (
			facts?.declarations.find((declaration) =>
				contains(declaration.selectionRange ?? declaration.range, params.range.start),
			) ?? null
		);
	}

	/**
	 * At the top level, the last definition or import before the read, the script's own scope over
	 * the global one; in a body, the file's own definition first.
	 */
	private bindReference(module: string, parsed: ParsedPowerShellFile, reference: PowerShellReference): Binding {
		const sought = soughtBy(reference);
		const target = reference.target;
		// A write names the variable it assigns, whatever an import left.
		const kept =
			sought === undefined ||
			reference.fromId !== undefined ||
			(reference.of.kind === "variable" && reference.role === "write");
		if (target !== undefined && kept) return bound(target);
		let reason: UnknownReason = "NotIndexed";
		let detail = `no PowerShell declaration matches ${reference.name}`;
		const report = (status: Unresolved, specifier: string) => {
			if (status.status === "external") {
				reason = "ExternalDependency";
				detail = `${reference.name} may come from ${specifier}, outside the workspace`;
			} else {
				reason = status.reason;
				detail = status.detail ?? detail;
			}
		};
		const candidates = new Set<string>();
		if (sought === undefined) {
			// A member's overloads may sit in this file, unsettled because the call cannot tell them apart.
			const own = reference.of.kind === "member" ? [parsed] : [];
			for (const facts of [...own, ...this.reachable(module, parsed, report)]) {
				for (const declaration of typeCandidates(facts, reference)) candidates.add(declaration.symbolId);
			}
		} else {
			const s: Settling = { ...sought, report, memo: new Map() };
			const visiting = new Set([module]);
			const start = direct(module);
			// A function body may run after any import, so each import's definition stands.
			const settled =
				reference.fromId === undefined
					? [
							visible(
								this.settledIn(
									s,
									module,
									parsed,
									start,
									start,
									this.ownBinder(parsed, reference),
									visiting,
									reference.range.start,
								),
							),
						]
					: parsed.sources.map((source) =>
							visible(this.settledThrough(s, module, source, start, start, visiting)),
						);
			for (const declaration of settled) {
				const found =
					declaration !== undefined && reference.of.kind === "parameter"
						? parameterOf(declaration, reference.name)
						: declaration;
				if (found !== undefined) candidates.add(found.symbolId);
			}
		}
		if (candidates.size === 1) return bound([...candidates][0] as string);
		if (candidates.size > 1) return { status: "ambiguous", candidates: [...candidates], provenance: "bound" };
		return unbound(reason, detail);
	}

	/** The definition a top-level read reached in its own file, where it last took effect before the read. */
	private ownBinder(parsed: ParsedPowerShellFile, reference: PowerShellReference): Binder | undefined {
		const id = reference.of.kind === "variable" ? reference.target : reference.callee;
		const declaration = parsed.declarations.find((candidate) => candidate.symbolId === id);
		return declaration === undefined ? undefined : binderOf(parsed, declaration, reference.range.start);
	}

	/** What running `facts` up to `before`, or whole, leaves in each scope: the last binding there. */
	private settledIn(
		s: Settling,
		module: string,
		facts: ParsedPowerShellFile,
		through: Through,
		caller: Through,
		own: Binder | undefined,
		visiting: ReadonlySet<string>,
		before?: Position,
	): Left {
		const left: Left = own === undefined ? {} : { scope: own.declaration };
		let scopeSince = own?.at;
		let globalSince: Position | undefined;
		const later = (at: Position, since: Position | undefined) =>
			since === undefined || comparePositions(at, since) >= 0;
		for (const source of facts.sources) {
			const at = source.range.start;
			if (before !== undefined && comparePositions(at, before) >= 0) continue;
			const brought = this.settledThrough(s, module, source, through, caller, visiting);
			if (brought.scope !== undefined && later(at, scopeSince)) {
				left.scope = brought.scope;
				scopeSince = at;
			}
			if (brought.global !== undefined && later(at, globalSince)) {
				left.global = brought.global;
				globalSince = at;
			}
			if (brought.caller !== undefined) left.caller = brought.caller;
		}
		return left;
	}

	/**
	 * What one import leaves once its file has run, in the importer's scopes. `caller` is what the
	 * importing module came through, where a manifest's scripts run.
	 */
	private settledThrough(
		s: Settling,
		module: string,
		source: SourceImport,
		through: Through,
		caller: Through,
		visiting: ReadonlySet<string>,
	): Left {
		const resolution = this.resolveImport({ fromModule: module, specifier: source.specifier });
		if (resolution.status !== "resolved") {
			s.report(resolution, source.specifier);
			return {};
		}
		const { landing } = resolution;
		if (landing.kind !== "module" || visiting.has(landing.module)) return {};
		const target = this.factsFor(landing.module);
		if (target === null) return {};
		const visits = new Set([...visiting, landing.module]);
		if (source.kind === "dotSource") return this.leftBy(s, landing.module, target, through, caller, visits);
		if (source.kind === "importerScript") {
			const left = this.leftBy(s, landing.module, target, caller, caller, visits);
			return defined({ caller: left.scope, global: left.global });
		}
		const name = importedName(s, source);
		if (name === undefined) return {};
		const inner: Through = {
			gates: [...through.gates, target],
			filters: source.filter === undefined ? through.filters : [...through.filters, source.filter],
			inModule: true,
		};
		const left = this.leftBy({ ...s, name }, landing.module, target, inner, through, visits);
		const members = visible(left);
		return importLevel(source, through) === "scope"
			? defined({ scope: members ?? left.caller })
			: defined({ scope: left.caller, global: members });
	}

	/** What running a brought-in file whole leaves, read once per name and what it came through. */
	private leftBy(
		s: Settling,
		module: string,
		facts: ParsedPowerShellFile,
		through: Through,
		caller: Through,
		visiting: ReadonlySet<string>,
	): Left {
		const key = JSON.stringify([module, s.name, signature(through), signature(caller)]);
		const held = s.memo.get(key);
		if (held !== undefined) return held;
		const left = this.settledIn(s, module, facts, through, caller, ownDefinition(facts, through, s), visiting);
		s.memo.set(key, left);
		return left;
	}

	/** The files a module brings in, each followed by what it brings in, read once each. */
	private reachable(
		module: string,
		parsed: ParsedPowerShellFile,
		report: Settling["report"],
	): ParsedPowerShellFile[] {
		const found: ParsedPowerShellFile[] = [];
		const visited = new Set([module]);
		const pending = [{ module, facts: parsed }];
		for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
			for (const source of next.facts.sources) {
				const resolution = this.resolveImport({ fromModule: next.module, specifier: source.specifier });
				if (resolution.status !== "resolved") {
					report(resolution, source.specifier);
					continue;
				}
				const { landing } = resolution;
				if (landing.kind !== "module" || visited.has(landing.module)) continue;
				visited.add(landing.module);
				const target = this.factsFor(landing.module);
				if (target === null) continue;
				found.push(target);
				pending.push({ module: landing.module, facts: target });
			}
		}
		return found;
	}
}

////////////////////////////////
//  Main

export function serve(
	connection: ReturnType<typeof createMessageConnection>,
	provider = new PowerShellProvider(),
): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new PowerShellProvider()));
