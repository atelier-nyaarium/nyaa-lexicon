import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type ArrangeEditsRequest,
	type Binding,
	comparePositions,
	discoverByWalk,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
	notImplementedMove,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Range,
	type RenameEditsRequest,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { CppBinder } from "./binder.js";
import { importsOf } from "./imports.js";
import { type CppFacts, LANGUAGE } from "./model.js";
import { parseCppFile } from "./parser.js";
import {
	bareProject,
	type CppProject,
	contextOf,
	discoverCppProject,
	type FoundInclude,
	findInclude,
	forcedDirectories,
	type IncludeKind,
	type SearchContext,
	searchOrders,
} from "./project.js";
import { type Reaches, reachesOf } from "./reach.js";

////////////////////////////////
//  Constants

const PROVIDER_ID = "cpp-provider";

const EXTENSIONS = [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"];
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"build",
	"cmake-build-debug",
	"cmake-build-release",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
	"bazel-bin",
	"bazel-out",
]);
export const REFERENCE_ROLES = ["call", "read", "write", "import", "extends", "instantiate", "typeUse"] as const;

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

/** C++20 keywords. Builtins are fixed-width typedefs and `std::string`; fundamental types are real keywords. */
export const WORDS = {
	keywords: [
		"alignas",
		"alignof",
		"and",
		"and_eq",
		"asm",
		"auto",
		"bitand",
		"bitor",
		"bool",
		"break",
		"case",
		"catch",
		"char",
		"char16_t",
		"char32_t",
		"char8_t",
		"class",
		"co_await",
		"co_return",
		"co_yield",
		"compl",
		"concept",
		"const",
		"const_cast",
		"consteval",
		"constexpr",
		"constinit",
		"continue",
		"decltype",
		"default",
		"delete",
		"do",
		"double",
		"dynamic_cast",
		"else",
		"enum",
		"explicit",
		"export",
		"extern",
		"float",
		"for",
		"friend",
		"goto",
		"if",
		"import",
		"inline",
		"int",
		"long",
		"module",
		"mutable",
		"namespace",
		"new",
		"noexcept",
		"not",
		"not_eq",
		"operator",
		"or",
		"or_eq",
		"private",
		"protected",
		"public",
		"register",
		"reinterpret_cast",
		"requires",
		"return",
		"short",
		"signed",
		"sizeof",
		"static",
		"static_assert",
		"static_cast",
		"struct",
		"switch",
		"template",
		"this",
		"thread_local",
		"throw",
		"try",
		"typedef",
		"typeid",
		"typename",
		"union",
		"unsigned",
		"using",
		"virtual",
		"void",
		"volatile",
		"wchar_t",
		"while",
		"xor",
		"xor_eq",
	],
	builtins: [
		"int16_t",
		"int32_t",
		"int64_t",
		"int8_t",
		"intptr_t",
		"nullptr_t",
		"ptrdiff_t",
		"size_t",
		"string",
		"uint16_t",
		"uint32_t",
		"uint64_t",
		"uint8_t",
		"uintptr_t",
	],
	literals: ["false", "nullptr", "true"],
};

////////////////////////////////
//  Functions & Helpers

// Inclusive at both ends.
function contains(range: Range, position: Range["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function unknown(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

/** An include's name without its `<>` or `""`. */
function headerName(specifier: string): string {
	const delimited =
		(specifier.startsWith("<") && specifier.endsWith(">")) ||
		(specifier.startsWith('"') && specifier.endsWith('"'));
	return delimited ? specifier.slice(1, -1) : specifier;
}

/** A relative path, a directory or a C++ source extension, as a workspace header's name is. */
function looksLikeWorkspacePath(name: string): boolean {
	return name.startsWith(".") || name.includes("/") || EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** The one answer every reading gives, else Ambiguous. */
function agreed(answers: readonly ImportResolution[], detail: string): ImportResolution {
	const first = answers[0] as ImportResolution;
	return answers.every((answer) => isDeepStrictEqual(answer, first))
		? first
		: { status: "unresolved", reason: "Ambiguous", detail };
}

/**
 * What finding `name`, or not, means for an include of `kind`: a bare name found nowhere is
 * external unless it reads like a workspace path.
 */
function resolutionOf(found: FoundInclude | undefined, name: string, kind: IncludeKind | undefined): ImportResolution {
	if (found !== undefined && "module" in found)
		return { status: "resolved", landing: { kind: "module", module: found.module } };
	if (found !== undefined || kind === "angle") return { status: "external", packageName: name };
	if (kind === undefined && !looksLikeWorkspacePath(name)) return { status: "external", packageName: name };
	return { status: "unresolved", reason: "NotIndexed", detail: `no workspace header matches ${name}` };
}

////////////////////////////////
//  Classes

export class CppProvider {
	/** Include lookup reads the store's project and held facts. */
	readonly store = moduleStore<CppFacts, CppProject>({ read: (module, text) => parseCppFile(module, text) });

	constructor(private readonly meter?: { steps: number }) {}

	initialize(_workspaceRoot: string) {
		return {
			providerId: PROVIDER_ID,
			language: LANGUAGE,
			extensions: EXTENSIONS,
			sharedExtensions: [{ extension: ".h", beside: EXTENSIONS }],
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string, _previous?: CppProject): { model: ProjectModel; project: CppProject } {
		const root = path.resolve(workspaceRoot);
		const failed = (message: string) => ({ model: projectDiagnostic(root, message), project: bareProject(root) });
		try {
			if (!existsSync(root)) return failed(`workspace root does not exist: ${root}`);
			if (!statSync(root).isDirectory()) return failed(`workspace root is not a directory: ${root}`);
			const walked = discoverByWalk(root, {
				extensions: EXTENSIONS,
				excludedDirectories: EXCLUDED_DIRECTORIES,
			});
			if (walked.diagnostics.length > 0) return { model: walked, project: bareProject(root) };
			const project = discoverCppProject(root, EXCLUDED_DIRECTORIES, this.store.policy);
			return {
				model: {
					// A forced include is no file's import, so its header is named here, however its directory is kept out.
					files: [...new Set([...walked.files, ...project.forcedModules])].sort(),
					externalRoots: [],
					configFiles: [...new Set([...walked.configFiles, ...project.databases])],
					diagnostics: [...project.diagnostics],
					fingerprint: project.fingerprint,
				},
				project,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return failed(`unable to inspect workspace root: ${detail}`);
		}
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		facts: CppFacts,
	) {
		const binder = this.binder(params.module, facts);
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: facts.references.map((reference) => ({
				name: reference.name,
				range: reference.range,
				role: reference.role,
				qualified: reference.qualified,
				binding: binder.bind(params.module, reference),
				...(reference.from === null ? {} : { fromId: reference.from.declaration.symbolId }),
			})),
			imports: importsOf(facts, (specifier) => this.namespaceLanding(params.module, facts, binder, specifier)),
			scopeContributions: facts.scopeContributions,
			literals: facts.literals,
			comments: facts.comments,
			blankLines: facts.blankLines,
			diagnostics: facts.diagnostics,
			role: facts.role,
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const name = headerName(params.specifier);
		const delimited = params.specifier.startsWith("<")
			? "angle"
			: params.specifier.startsWith('"')
				? "quoted"
				: undefined;
		const context = contextOf(this.store.project, params.fromModule);
		if (delimited !== undefined) return this.resolveInclude(context, params.fromModule, name, delimited);
		const facts = this.store.load(params.fromModule);
		if (facts?.transfers.some((transfer) => transfer.specifier === name))
			return this.namespaceLanding(params.fromModule, facts, this.binder(params.fromModule, facts), name);
		// A bare name takes the kinds its includes are written with; two finding different files, neither.
		const kinds = new Set(
			(facts?.importFacts ?? [])
				.filter((item) => item.specifier === name)
				.map((item): IncludeKind => (item.quoted ? "quoted" : "angle")),
		);
		const answers = (kinds.size === 0 ? [undefined] : [...kinds]).map((kind) =>
			this.resolveInclude(context, params.fromModule, name, kind),
		);
		return agreed(answers, `the file includes ${name} both ways, finding different files`);
	}

	/**
	 * The scope the namespace `specifier` written in `module` opens, the same for every using and
	 * alias writing it; external when only an external header can hold it.
	 */
	private namespaceLanding(module: string, facts: CppFacts, binder: CppBinder, specifier: string): ImportResolution {
		if (facts.importFacts.some((include) => include.specifier === specifier))
			return {
				status: "unresolved",
				reason: "Ambiguous",
				detail: `the file writes ${specifier} as a header and as a namespace`,
			};
		const answers = facts.transfers
			.filter((transfer) => transfer.specifier === specifier)
			.map((transfer): ImportResolution => {
				const found = binder.namespaceAt(module, transfer.scopeToken);
				if ("scopeId" in found)
					return {
						status: "resolved",
						landing: { kind: "packageScope", providerId: PROVIDER_ID, scopeId: found.scopeId },
					};
				if (found.reason === "ExternalDependency") return { status: "external", packageName: specifier };
				return { status: "unresolved", reason: found.reason, detail: found.detail };
			});
		return agreed(answers, `the file's uses of ${specifier} land differently`);
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.store.load(params.module);
		if (facts === undefined) return { status: "unbound", reason: "NotIndexed", detail: "module is not indexed" };
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && contains(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.binder(params.module, facts).bind(params.module, reference);
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				contains(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return { status: "unbound", reason: "NotIndexed", detail: "no declaration or reference matched the range" };
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) {
			const parsed = parseSymbolId(params.symbolId);
			if (parsed === null || parsed.language !== LANGUAGE)
				return unknown("ParseError", "the symbol id is not a C++ workspace id");
			const facts = this.store.load(parsed.module);
			if (facts === undefined) return unknown("NotIndexed", "module is not indexed");
			return (
				facts.typeAnswers.get(params.symbolId) ??
				unknown("NotImplemented", "no declared or inferred type is available")
			);
		}
		const facts = this.store.load(params.module);
		if (facts === undefined) return unknown("NotIndexed", "module is not indexed");
		const selected = facts.declarations.filter((declaration) =>
			contains(declaration.selectionRange ?? declaration.range, params.range.start),
		);
		if (selected.length > 1) return unknown("Ambiguous", "the range matches several declaration names");
		const candidates = (
			selected.length === 0
				? facts.declarations.filter((declaration) => contains(declaration.range, params.range.start))
				: selected
		).sort((left, right) => {
			const leftLines = left.range.end.line - left.range.start.line;
			const rightLines = right.range.end.line - right.range.start.line;
			return leftLines - rightLines || left.range.end.character - left.range.start.character;
		});
		const declaration = candidates[0];
		if (declaration === undefined) return unknown("NotImplemented", "no declaration type matches the range");
		return (
			facts.typeAnswers.get(declaration.symbolId) ??
			unknown("NotImplemented", "no declared or inferred type is available")
		);
	}

	renameEdits(_params: RenameEditsRequest) {
		return {
			status: "refused" as const,
			reason: "NotImplemented" as const,
			detail: "C++ rename rendering is not implemented",
		};
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("C++ move rendering is not implemented");
	}

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("C++ arrange rendering is not implemented");
	}

	/**
	 * An include written in `includer`, searched on disk under the lists of `context`, so held for
	 * the store generation. A kind unknown is searched as quoted. Where every unit's lists apply and
	 * they find different files, none is chosen.
	 */
	private resolveInclude(
		context: SearchContext,
		includer: string,
		name: string,
		kind: IncludeKind | undefined,
	): ImportResolution {
		// Only a quoted include searches its includer's directory.
		const from = kind === "angle" ? "" : path.posix.dirname(includer);
		return this.store.memo(`\u0000include\u0000${context}\u0000${from}\u0000${kind ?? ""}\u0000${name}`, () => {
			const project = this.store.project;
			const written = name.replace(/\\/gu, "/");
			const answers = searchOrders(project, context, includer, kind ?? "quoted").map((directories) =>
				resolutionOf(findInclude(project, this.store.policy, directories, written), name, kind),
			);
			return agreed(answers, `the entries find different headers for ${name}`);
		});
	}

	/** A binder for one request, reading other files and their includes through the store. */
	private binder(module: string, facts: CppFacts): CppBinder {
		return new CppBinder(
			{
				load: (other) => this.store.load(other),
				reached: (from, held) => this.reached(from, held),
			},
			module,
			facts,
			this.meter,
		);
	}

	/** What `unit`'s includes reach; one walk per unit and store generation. */
	private reached(unit: string, facts: CppFacts): Reaches {
		const held = this.store.memo(`\u0000reach\u0000${unit}`, (): { facts: CppFacts; reaches?: Reaches } => ({
			facts,
		}));
		// A probe's text is not the held one.
		if (held.facts !== facts) return this.walkIncludes(unit, facts);
		if (held.reaches !== undefined) return held.reaches;
		const reaches = this.walkIncludes(unit, facts);
		// A header that could not be read is tried again on the next request.
		if (reaches.complete) held.reaches = reaches;
		return reaches;
	}

	/** From the unit's forced includes, then its own, each include searched under the unit's lists. */
	private walkIncludes(unit: string, facts: CppFacts): Reaches {
		const project = this.store.project;
		const context = contextOf(project, unit);
		// Each entry's, looked for in its working directory, then along its quoted search.
		const [first = [], ...others] = (project.units.get(unit) ?? []).map((entry) =>
			entry.forced.map((name) =>
				resolutionOf(
					findInclude(project, this.store.policy, forcedDirectories(project, entry), name),
					name,
					"quoted",
				),
			),
		);
		// What every entry forces is read; what only some do, is not.
		const agreed = first.filter((resolution) =>
			others.every((other) => other.some((candidate) => isDeepStrictEqual(candidate, resolution))),
		);
		const forced: ImportResolution[] = [first, ...others].every((list) => list.length === agreed.length)
			? agreed
			: [
					...agreed,
					{ status: "unresolved", reason: "Ambiguous", detail: "the entries force different includes" },
				];
		return reachesOf(unit, forced, facts, {
			resolve: (includer, include) =>
				this.resolveInclude(context, includer, include.specifier, include.quoted ? "quoted" : "angle"),
			load: (module) => this.store.load(module),
		});
	}
}

////////////////////////////////
//  Functions & Helpers

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new CppProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new CppProvider()));
