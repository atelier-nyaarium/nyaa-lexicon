// The wire face of the PowerShell provider.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	DEFAULT_EXCLUDED_DIRECTORIES,
	type Declaration,
	defined,
	discoverByWalk,
	handlersFor,
	type ImportResolution,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
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
import { keyOf, wildcardMatches } from "./context.js";
import {
	LANGUAGE,
	type ParsedPowerShellFile,
	type PowerShellDeclaration,
	type PowerShellReference,
	parsePowerShellFile,
} from "./extract.js";
import { membersOf, parameterOf } from "./scope.js";

////////////////////////////////
//  Constants

const EXTENSIONS = [".ps1", ".psm1", ".psd1"];
const SHEBANGS = ["pwsh", "powershell"];
const EXCLUDED_DIRECTORIES = new Set([...DEFAULT_EXCLUDED_DIRECTORIES]);

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

function discover(root: string): ProjectModel {
	if (!existsSync(root)) return projectDiagnostic(root, `workspace root does not exist: ${root}`);
	try {
		if (!statSync(root).isDirectory()) return projectDiagnostic(root, `workspace root is not a directory: ${root}`);
		return discoverByWalk(root, {
			extensions: EXTENSIONS,
			shebangs: SHEBANGS,
			excludedDirectories: EXCLUDED_DIRECTORIES,
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
function exports(gate: ParsedPowerShellFile, kind: "function" | "variable", name: string): boolean {
	const patterns = kind === "function" ? gate.exportedFunctions : gate.exportedVariables;
	if (patterns === undefined) return kind === "function" || keyOf(gate.module).endsWith(".psd1");
	return [...patterns].some((pattern) => wildcardMatches(pattern, name));
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
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string): { model: ProjectModel; project: null } {
		return { model: discover(path.resolve(workspaceRoot)), project: null };
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
			if (named.length === 1) return { status: "resolved", module: named[0] as string };
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
				? { status: "resolved", module }
				: { status: "unresolved", reason: "NotIndexed", detail: `no workspace file at ${specifier}` };
		}
		const fromAbsolute = workspaceFile(root, params.fromModule);
		const directories = fromAbsolute === null ? [root] : [path.dirname(fromAbsolute), root];
		for (const directory of directories) {
			const module = workspaceModule(root, path.resolve(directory, relative));
			if (module !== null && this.hasFile(module)) return { status: "resolved", module };
			// A module folder: its manifest, else its module file.
			for (const inside of this.moduleFolderFiles(directory, relative)) {
				if (this.hasFile(inside)) return { status: "resolved", module: inside };
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

	/** Same file first, then every file it dot-sources or imports, transitively. */
	private bindReference(module: string, parsed: ParsedPowerShellFile, reference: PowerShellReference): Binding {
		if (reference.target !== undefined) return bound(reference.target);
		let reason: UnknownReason = "NotIndexed";
		let detail = `no PowerShell declaration matches ${reference.name}`;
		const report = (status: Exclude<ImportResolution, { status: "resolved" }>, specifier: string) => {
			if (status.status === "external") {
				reason = "ExternalDependency";
				detail = `${reference.name} may come from ${specifier}, outside the workspace`;
			} else {
				reason = status.reason;
				detail = status.detail ?? detail;
			}
		};
		const candidates = new Set<string>();
		// A member's overloads may sit in this file, unsettled because the call cannot tell them apart.
		const own = reference.of.kind === "member" ? [{ facts: parsed, gates: [] }] : [];
		for (const { facts, gates } of [...own, ...this.reachable(module, parsed, report)]) {
			for (const declaration of this.candidatesIn(facts, gates, reference)) candidates.add(declaration.symbolId);
		}
		if (candidates.size === 1) return bound([...candidates][0] as string);
		if (candidates.size > 1) return { status: "ambiguous", candidates: [...candidates], provenance: "bound" };
		return unbound(reason, detail);
	}

	/** What a reachable file holds for a reference, as far as the modules around it export. */
	private candidatesIn(
		facts: ParsedPowerShellFile,
		gates: readonly ParsedPowerShellFile[],
		reference: PowerShellReference,
	): PowerShellDeclaration[] {
		const key = keyOf(reference.name);
		const shown = (kind: "function" | "variable", declaration: PowerShellDeclaration) =>
			gates.every((gate) => exports(gate, kind, declaration.name));
		switch (reference.of.kind) {
			case "command": {
				const last = facts.functionsByName
					.get(key)
					?.filter((definition) => definition.visibility === "public")
					.at(-1);
				return last !== undefined && shown("function", last) ? [last] : [];
			}
			case "variable": {
				const variable = facts.variablesByName.get(key);
				return variable !== undefined && shown("variable", variable) ? [variable] : [];
			}
			case "type": {
				const type = facts.typesByName.get(key);
				return type === undefined ? [] : [type];
			}
			case "member":
				return membersOf(facts.typesByName, reference.of.typeName, reference.name, reference.of.arity);
			case "parameter": {
				const command = facts.functionsByName
					.get(keyOf(reference.of.command))
					?.filter((definition) => definition.visibility === "public")
					.at(-1);
				if (command === undefined || !shown("function", command)) return [];
				const parameter = parameterOf(command, reference.name);
				return parameter === undefined ? [] : [parameter];
			}
		}
	}

	/**
	 * The files a module brings in, each followed by what it brings in, read once each. Each carries
	 * the modules it came in through, whose exports decide what of it an importer sees; a dot-source
	 * shares everything with the file that runs it.
	 */
	private reachable(
		module: string,
		parsed: ParsedPowerShellFile,
		report: (status: Exclude<ImportResolution, { status: "resolved" }>, specifier: string) => void,
	): Array<{ facts: ParsedPowerShellFile; gates: ParsedPowerShellFile[] }> {
		const found: Array<{ facts: ParsedPowerShellFile; gates: ParsedPowerShellFile[] }> = [];
		const visited = new Set([module]);
		const pending: Array<{ module: string; facts: ParsedPowerShellFile; gates: ParsedPowerShellFile[] }> = [
			{ module, facts: parsed, gates: [] },
		];
		for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
			for (const source of next.facts.sources) {
				const resolution = this.resolveImport({ fromModule: next.module, specifier: source.specifier });
				if (resolution.status !== "resolved") {
					report(resolution, source.specifier);
					continue;
				}
				if (visited.has(resolution.module)) continue;
				visited.add(resolution.module);
				const target = this.factsFor(resolution.module);
				if (target === null) continue;
				const gates = source.kind === "module" ? [...next.gates, target] : next.gates;
				found.push({ facts: target, gates });
				pending.push({ module: resolution.module, facts: target, gates });
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
