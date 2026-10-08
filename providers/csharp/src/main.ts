import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	type Binding,
	defined,
	discoverByWalk,
	handlersFor,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type IndexDepth,
	type ModuleStore,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
	notImplementedImportEdits,
	notImplementedMove,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	type TypeInfo,
	type UnknownReason,
	serveProvider as wireServeProvider,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { CsharpBinder } from "./binding.js";
import { unbound } from "./imports.js";
import { type DeclarationMeta, LANGUAGE, PROVIDER_ID } from "./model.js";
import { type IndexEntry, NamespaceIndex, namespaceEntries } from "./namespaces.js";
import { CsharpParser } from "./parser.js";
import { type CsharpProjectState, contextFor, discoverContexts, EMPTY_PROJECT_STATE } from "./project.js";
import { contains, type IndexedFacts, indexed, type Range } from "./workspace.js";

////////////////////////////////
//  Constants

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

/** C# reserved and contextual keywords. No builtin vocabulary: every primitive type is a keyword. */
export const WORDS = {
	keywords: [
		"abstract",
		"add",
		"alias",
		"and",
		"as",
		"ascending",
		"async",
		"await",
		"base",
		"bool",
		"break",
		"by",
		"byte",
		"case",
		"catch",
		"char",
		"checked",
		"class",
		"const",
		"continue",
		"decimal",
		"default",
		"delegate",
		"descending",
		"do",
		"double",
		"dynamic",
		"else",
		"enum",
		"equals",
		"event",
		"explicit",
		"extern",
		"file",
		"finally",
		"fixed",
		"float",
		"for",
		"foreach",
		"from",
		"get",
		"global",
		"goto",
		"group",
		"if",
		"implicit",
		"in",
		"init",
		"int",
		"interface",
		"internal",
		"into",
		"is",
		"join",
		"let",
		"lock",
		"long",
		"nameof",
		"namespace",
		"new",
		"nint",
		"not",
		"notnull",
		"nuint",
		"object",
		"on",
		"operator",
		"or",
		"orderby",
		"out",
		"override",
		"params",
		"partial",
		"private",
		"protected",
		"public",
		"readonly",
		"record",
		"ref",
		"remove",
		"required",
		"return",
		"sbyte",
		"scoped",
		"sealed",
		"select",
		"set",
		"short",
		"sizeof",
		"stackalloc",
		"static",
		"string",
		"struct",
		"switch",
		"this",
		"throw",
		"try",
		"typeof",
		"uint",
		"ulong",
		"unchecked",
		"unmanaged",
		"unsafe",
		"ushort",
		"using",
		"value",
		"var",
		"virtual",
		"void",
		"volatile",
		"when",
		"where",
		"while",
		"with",
		"yield",
	],
	builtins: [],
	literals: ["false", "null", "true"],
};

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

////////////////////////////////
//  Functions & Helpers

function unknown(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

////////////////////////////////
//  Classes

export class CsharpProvider extends CsharpBinder {
	readonly store: ModuleStore<IndexedFacts, CsharpProjectState, IndexEntry> = moduleStore<
		IndexedFacts,
		CsharpProjectState,
		IndexEntry
	>({
		read: (module, text, depth): IndexedFacts =>
			indexed(
				new CsharpParser(
					module,
					text,
					depth === "outline",
					contextFor(this.store.project, module)?.symbols,
				).parse(),
			),
		entries: (module, value) => namespaceEntries(module, value),
	});

	/** The workspace's namespaces and types, as the store keeps them. */
	protected readonly index = new NamespaceIndex(this.store);

	initialize(_workspaceRoot: string) {
		return {
			providerId: PROVIDER_ID,
			language: LANGUAGE,
			extensions: [...EXTENSIONS],
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(
		workspaceRoot: string,
		_previous: CsharpProjectState | undefined,
		scope?: string[],
	): { model: ProjectModel; project: CsharpProjectState } {
		const root = path.resolve(workspaceRoot);
		try {
			if (!existsSync(root))
				return {
					model: projectDiagnostic(root, `workspace root does not exist: ${root}`),
					project: EMPTY_PROJECT_STATE,
				};
			if (!statSync(root).isDirectory())
				return {
					model: projectDiagnostic(root, `workspace root is not a directory: ${root}`),
					project: EMPTY_PROJECT_STATE,
				};
			const walked = discoverByWalk(root, {
				extensions: EXTENSIONS,
				configExtensions: [".csproj", ".sln"],
				excludedDirectories: EXCLUDED_DIRECTORIES,
				scope,
			});
			const projects = walked.configFiles.filter((file) => file.endsWith(".csproj"));
			const discovered = discoverContexts(root, projects, this.store.policy);
			return {
				model: {
					files: walked.files,
					externalRoots: [],
					configFiles: [...new Set([...walked.configFiles, ...discovered.consulted])].sort(),
					diagnostics: discovered.diagnostics,
					fingerprint: discovered.fingerprint,
				},
				project: discovered.state,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return {
				model: projectDiagnostic(root, `unable to inspect workspace root: ${detail}`),
				project: EMPTY_PROJECT_STATE,
			};
		}
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		facts: IndexedFacts,
	) {
		const outline = params.depth === "outline";
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: outline
				? []
				: facts.references.map((reference) => {
						const binding = this.bindingForReference(facts, reference);
						return { ...reference, role: this.baseRole(facts, reference, binding), binding };
					}),
			imports: this.importFacts(facts),
			scopeContributions: this.scopeContributions(facts),
			role: facts.role,
			literals: outline ? [] : facts.literals,
			comments: outline ? [] : facts.comments,
			blankLines: facts.blankLines,
			diagnostics: facts.diagnostics,
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module, "full");
		if (facts === null) return unbound("NotIndexed", "module is not indexed");
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && contains(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(facts, reference);
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				contains(candidate.selectionRange ?? candidate.range, params.range.start),
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
		const facts = this.factsForModule(module, "full");
		if (facts === null) return unknown("NotIndexed", "module is not indexed");
		const metadata =
			symbolId === undefined
				? [...facts.metadata.values()].filter(
						(item) =>
							"range" in params &&
							(contains(item.declaration.selectionRange ?? item.declaration.range, params.range.start) ||
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
			return this.typeForMetadata(facts, first);
		}
		return this.typeForMetadata(facts, metadata[0] as DeclarationMeta);
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C# rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("C# move edits are not implemented");
	}

	importEdits(_params: ImportEditsRequest): ImportEditsResponse {
		return notImplementedImportEdits("C# import planning is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("C# arrange edits are not implemented");
	}

	private typeForMetadata(facts: IndexedFacts, meta: DeclarationMeta): TypeInfo {
		if (meta.typeText !== undefined) {
			if (meta.typeText.trim() === "dynamic")
				return unknown("DynamicallyTyped", "the declaration uses C# dynamic");
			const types =
				meta.typeSegments === undefined
					? []
					: this.lookupType(facts, meta, meta.typeSegments, { qualifier: meta.typeQualifier });
			const symbolId = types.length === 1 ? types[0]?.symbolId : undefined;
			return {
				status: "known",
				display: meta.typeText,
				provenance: "declared",
				...defined({ symbolId }),
			};
		}
		if (meta.inferredType !== undefined)
			return { status: "inferred", display: meta.inferredType, basis: "literal initializer" };
		if (meta.declaration.kind === "constructor")
			return { status: "known", display: meta.declaration.name, provenance: "declared" };
		return unknown("NotImplemented", "no explicit annotation or supported initializer inference");
	}

	/** A class's first base is its base class by position; an interface there is one it implements. */
	private baseRole(facts: IndexedFacts, reference: Reference, binding: Binding): Reference["role"] {
		if (reference.role !== "extends" || binding.status !== "bound") return reference.role;
		const from = reference.fromId === undefined ? undefined : facts.metadata.get(reference.fromId);
		if (from?.declaration.kind !== "class") return reference.role;
		return this.typeAt(binding.symbolId)?.meta.declaration.kind === "interface" ? "implements" : reference.role;
	}
}

////////////////////////////////
//  Functions & Helpers

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new CsharpProvider()): void {
	wireServeProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new CsharpProvider()));
