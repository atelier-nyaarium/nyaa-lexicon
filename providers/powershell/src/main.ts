// The wire face of the PowerShell provider.

import { SECRET_READERS } from "@nyaa-lexicon/formats/secret";
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
	notImplementedRenameEdits,
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
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { dropsWhenUnbound, PowerShellBinding } from "./binding.js";
import { keyOf } from "./context.js";
import { LANGUAGE, type ParsedPowerShellFile, type PowerShellDeclaration, parsePowerShellFile } from "./extract.js";
import { PowerShellImports } from "./imports.js";

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

////////////////////////////////
//  Class

export class PowerShellProvider {
	readonly store = moduleStore<ParsedPowerShellFile>({ read: (module, text) => parsePowerShellFile(module, text) });
	private readonly imports = new PowerShellImports(this.store);
	private readonly binding = new PowerShellBinding({
		factsFor: (module) => this.factsFor(module),
		resolveImport: (params) => this.resolveImport(params),
	});

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

	discoverProject(
		workspaceRoot: string,
		_previous: null | undefined,
		scope?: string[],
	): { model: ProjectModel; project: null } {
		return {
			model: discoverByWalk(workspaceRoot, {
				extensions: EXTENSIONS,
				shebangs: SHEBANGS,
				excludedDirectories: EXCLUDED_DIRECTORIES,
				policy: this.store.policy,
				scope,
			}),
			project: null,
		};
	}

	parseFile(params: { module: string; contentHash: string; text: string }, parsed: ParsedPowerShellFile) {
		const references: Reference[] = [];
		for (const reference of parsed.references) {
			const binding = this.binding.bindReference(params.module, parsed, reference);
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

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		return this.imports.resolveImport(params);
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const parsed = this.factsFor(params.module);
		if (parsed === null) return { status: "unbound", reason: "NotIndexed", detail: "module is not indexed" };
		const reference = parsed.references.find(
			(candidate) =>
				keyOf(candidate.name) === keyOf(params.name) && positionInRange(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.binding.bindReference(params.module, parsed, reference);
		const declaration = parsed.declarations.find(
			(candidate) =>
				keyOf(candidate.name) === keyOf(params.name) &&
				positionInRange(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return {
			status: "unbound",
			reason: "NotIndexed",
			detail: "no indexed reference or declaration matched the requested range",
		};
	}

	/** A type constraint says a type; a value, or what a function outputs, infers one. */
	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		const declaration = "symbolId" in params ? this.declarationById(params.symbolId) : this.declarationAt(params);
		const module = "symbolId" in params ? parseSymbolId(params.symbolId)?.module : params.module;
		if (declaration === null || module === undefined)
			return { status: "unknown", reason: "NotIndexed", detail: "no indexed declaration matched the request" };
		if (declaration.declaredType !== undefined) {
			const symbolId = this.binding.typeSymbol(module, declaration.declaredType);
			return {
				status: "known",
				display: declaration.declaredType,
				provenance: "declared",
				...defined({ symbolId }),
			};
		}
		if (declaration.inferredType !== undefined) {
			const symbolId = this.binding.typeSymbol(module, declaration.inferredType);
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

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return notImplementedRenameEdits("PowerShell rename edits are not implemented");
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("PowerShell move edits are not implemented");
	}

	importEdits(_params: ImportEditsRequest): ImportEditsResponse {
		return notImplementedImportEdits("PowerShell import planning is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("PowerShell arrange edits are not implemented");
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
				positionInRange(declaration.selectionRange ?? declaration.range, params.range.start),
			) ?? null
		);
	}
}

////////////////////////////////
//  Main

export function serve(
	connection: ReturnType<typeof createMessageConnection>,
	provider = new PowerShellProvider(),
): void {
	serveProvider(connection, handlersFor(provider, SECRET_READERS));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new PowerShellProvider(), SECRET_READERS));
