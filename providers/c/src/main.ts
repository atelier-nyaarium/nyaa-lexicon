import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { IncludeSearch } from "@nyaa-lexicon/formats/compile-commands";
import {
	type Binding,
	DEFAULT_EXCLUDED_DIRECTORIES,
	type Declaration,
	defined,
	discoverByWalk,
	type FileRole,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type MoveEditsRequest,
	type MoveEditsResponse,
	moduleStore,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Range,
	type ReadPolicy,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	serveProvider,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import type { CDeclaration, CImportFact, CReference, ParsedCFile, TypeName } from "./model.js";
import { bindingCandidates, parseC, rangeContains, typeInfoFor } from "./parser.js";
import {
	bareProject,
	type CProject,
	type CUnit,
	contextOf,
	discoverCProject,
	type Found,
	findInclude,
	forcedDirectories,
	type IncludeKind,
	type SearchContext,
	searchDirectories,
} from "./project.js";
import { declaredIn, lexicalScope, macrosFirst, oneType, typeCandidates, typeMacros } from "./scopes.js";

////////////////////////////////
//  Interfaces & Types

/** A declaration and the facts of the module that holds it. */
interface Declared {
	module: string;
	facts: ParsedCFile;
	declaration: CDeclaration;
}

/** Why a receiver's type has no fields to bind. */
interface NoOwner {
	reason: UnknownReason;
	detail: string;
}

/** What a module reaches through its includes, and why any include reached none. */
interface Reach {
	/** Each name's file-scope declarations, by include depth. */
	names: Map<string, CDeclaration[][]>;
	/** An include landed outside the workspace. */
	external: boolean;
	/** A header could not be read yet, so the reach is not worth keeping. */
	incomplete: boolean;
	reason?: UnknownReason;
	detail?: string;
}

////////////////////////////////
//  Constants

/** How many members and typedefs a receiver's type is followed through. */
const MAX_MEMBER_CHAIN = 16;

const TAG_KINDS: ReadonlySet<string> = new Set(["struct", "enum"]);

const LANGUAGE = "c";
const EXTENSIONS = [".c", ".h"];

const EXCLUDED_DIRECTORIES = new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ".clangd", "CMakeFiles"]);

const PROJECT_CONFIGS = ["CMakeLists.txt", "Makefile", "compile_commands.json", ".clang-format", ".clangd"];

const COMMON_HEADERS = new Set([
	"assert.h",
	"complex.h",
	"ctype.h",
	"errno.h",
	"fcntl.h",
	"inttypes.h",
	"limits.h",
	"math.h",
	"memory.h",
	"pthread.h",
	"setjmp.h",
	"signal.h",
	"stdarg.h",
	"stdbool.h",
	"stddef.h",
	"stdint.h",
	"stdio.h",
	"stdlib.h",
	"string.h",
	"sys/types.h",
	"time.h",
	"unistd.h",
	"wchar.h",
	"windows.h",
]);

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

/** C11 keywords. Builtins are the standard fixed-width and size typedefs, never real keywords. */
export const WORDS = {
	keywords: [
		"_Alignas",
		"_Alignof",
		"_Atomic",
		"_BitInt",
		"_Bool",
		"_Complex",
		"_Decimal128",
		"_Decimal32",
		"_Decimal64",
		"_Generic",
		"_Imaginary",
		"_Noreturn",
		"_Static_assert",
		"_Thread_local",
		"auto",
		"break",
		"case",
		"char",
		"const",
		"continue",
		"default",
		"do",
		"double",
		"else",
		"enum",
		"extern",
		"float",
		"for",
		"goto",
		"if",
		"inline",
		"int",
		"long",
		"nullptr",
		"register",
		"restrict",
		"return",
		"short",
		"signed",
		"sizeof",
		"static",
		"struct",
		"switch",
		"typedef",
		"typeof",
		"typeof_unqual",
		"union",
		"unsigned",
		"void",
		"volatile",
		"while",
	],
	builtins: [
		"FILE",
		"bool",
		"int16_t",
		"int32_t",
		"int64_t",
		"int8_t",
		"intptr_t",
		"ptrdiff_t",
		"size_t",
		"ssize_t",
		"uint16_t",
		"uint32_t",
		"uint64_t",
		"uint8_t",
		"uintptr_t",
		"wchar_t",
	],
	literals: ["NULL", "false", "true"],
};

export const REFERENCE_ROLES = ["call", "read", "write", "import", "typeUse"] as const;

////////////////////////////////
//  Functions & Helpers

function containsStart(range: Range, position: Range["start"]): boolean {
	return rangeContains(range, position);
}

function fileRole(parsed: ParsedCFile): FileRole {
	const main = parsed.declarations.find(
		(declaration) => declaration.name === "main" && declaration.kind === "function" && declaration.isDefinition,
	);
	return main === undefined ? { kind: "library" } : { kind: "entry", how: "main", symbolId: main.symbolId };
}

function declarationWire(declaration: CDeclaration): Declaration {
	return {
		symbolId: declaration.symbolId,
		kind: declaration.kind,
		...defined({ languageKind: declaration.languageKind }),
		name: declaration.name,
		range: declaration.range,
		selectionRange: declaration.selectionRange,
		visibility: declaration.visibility,
		...defined({ exported: declaration.exported }),
		...defined({
			signature: declaration.signature,
			containerId: declaration.containerId,
			memberInsertLine: declaration.memberInsertLine,
			metrics: declaration.metrics,
		}),
	};
}

function referenceWire(reference: CReference, binding: Binding): Reference {
	return {
		name: reference.name,
		range: reference.range,
		role: reference.role,
		binding,
		...defined({ fromId: reference.fromId }),
		qualified: reference.qualified,
	};
}

function unknownBinding(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function conditionalAmbiguity(candidates: CDeclaration[]): Binding {
	return {
		status: "ambiguous",
		candidates: candidates.map((candidate) => candidate.symbolId),
		provenance: "bound",
		...({ detail: "conditional compilation supplies both declarations" } as object),
	} as Binding;
}

function ordinaryAmbiguity(candidates: CDeclaration[]): Binding {
	return {
		status: "ambiguous",
		candidates: candidates.map((candidate) => candidate.symbolId),
		provenance: "bound",
	} as Binding;
}

/** The types among `candidates` a tag, or else an ordinary name, can mean: a typedef before a bare tag. */
function inNamespace(candidates: CDeclaration[], tag: boolean): CDeclaration[] {
	const tags = candidates.filter((candidate) => TAG_KINDS.has(candidate.kind));
	if (tag) return tags;
	const aliases = candidates.filter((candidate) => candidate.kind === "class");
	return aliases.length > 0 ? aliases : tags;
}

function headerName(specifier: string): string {
	if (
		(specifier.startsWith("<") && specifier.endsWith(">")) ||
		(specifier.startsWith('"') && specifier.endsWith('"'))
	) {
		return specifier.slice(1, -1);
	}
	return specifier;
}

/** What finding `name`, or not, means for an include of `kind`. */
function resolutionOf(found: Found | undefined, name: string, kind: IncludeKind | undefined): ImportResolution {
	if (found !== undefined && "module" in found) return { status: "resolved", module: found.module };
	if (found !== undefined || kind === "angle") return { status: "external", packageName: name };
	const common =
		COMMON_HEADERS.has(name) || name.startsWith("sys/") || name.startsWith("linux/") || name.startsWith("windows/");
	if (kind === undefined && common) return { status: "external", packageName: name };
	return { status: "unresolved", reason: "NotIndexed", detail: `no workspace header matches ${name}` };
}

/** The one answer every reading gives, or Ambiguous when they differ. */
function agreed(answers: readonly ImportResolution[], detail: string): ImportResolution {
	const first = answers[0] as ImportResolution;
	return answers.every((answer) => isDeepStrictEqual(answer, first))
		? first
		: { status: "unresolved", reason: "Ambiguous", detail };
}

function discover(root: string, policy: ReadPolicy): { model: ProjectModel; project: CProject } {
	const failed = (message: string) => ({ model: projectDiagnostic(root, message), project: bareProject(root) });
	if (!existsSync(root)) return failed(`workspace root does not exist: ${root}`);
	try {
		if (!statSync(root).isDirectory()) return failed(`workspace root is not a directory: ${root}`);
		const model = discoverByWalk(root, { extensions: EXTENSIONS, excludedDirectories: EXCLUDED_DIRECTORIES });
		if (model.diagnostics.length > 0) return { model, project: bareProject(root) };
		const project = discoverCProject(root, EXCLUDED_DIRECTORIES, policy);
		const configs = PROJECT_CONFIGS.filter((name) => existsSync(path.join(root, name)));
		return {
			model: {
				...model,
				// A forced header in an excluded directory is reached by no include, so core learns it here.
				files: [...new Set([...model.files, ...project.forcedHeaders])],
				configFiles: [...new Set([...configs, ...project.databases])],
				diagnostics: [...project.diagnostics],
				fingerprint: project.fingerprint,
			},
			project,
		};
	} catch (error) {
		return failed(`unable to inspect workspace root: ${error instanceof Error ? error.message : String(error)}`);
	}
}

////////////////////////////////
//  Classes

export class CProvider {
	/** Include lookup uses held facts. */
	readonly store = moduleStore<ParsedCFile, CProject>({ read: (module, text) => parseC(module, text) });

	initialize(_workspaceRoot: string) {
		return {
			providerId: "c-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot: string): { model: ProjectModel; project: CProject } {
		return discover(path.resolve(workspaceRoot), this.store.policy);
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		parsed: ParsedCFile,
	) {
		const bindingCache = new Map<string, Binding>();
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: parsed.declarations.map(declarationWire),
			references: parsed.references.map((reference) =>
				referenceWire(reference, this.bindingForReference(params.module, parsed, reference, bindingCache)),
			),
			imports: parsed.imports.map(({ specifier, imported, reExport }) => ({
				specifier,
				imported,
				reExport,
			})),
			literals: parsed.literals,
			comments: parsed.comments,
			blankLines: parsed.blankLines,
			diagnostics: parsed.diagnostics,
			role: fileRole(parsed),
		};
	}

	private factsForModule(module: string): ParsedCFile | null {
		return this.store.load(module) ?? null;
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const clean = headerName(params.specifier);
		const delimited = params.specifier.startsWith("<")
			? "angle"
			: params.specifier.startsWith('"')
				? "quoted"
				: undefined;
		const context = contextOf(this.store.project, params.fromModule);
		if (delimited !== undefined) return this.resolveInclude(context, params.fromModule, clean, delimited);
		// A bare path takes the kind its held include was written with; written both ways, both must agree.
		const kinds = new Set(
			(this.store.peek(params.fromModule)?.imports ?? [])
				.filter((imported) => imported.specifier === clean)
				.map((imported) => imported.kind),
		);
		const answers = (kinds.size === 0 ? [undefined] : [...kinds]).map((kind) =>
			this.resolveInclude(context, params.fromModule, clean, kind),
		);
		return agreed(answers, `the include of ${clean} is written both ways and each finds a different header`);
	}

	/**
	 * `name` included from `fromModule`, searched with each of `context`'s lists: those of the units whose
	 * reach it is part of. An answer stands only where every list agrees. Searched on disk, so held for
	 * the store generation.
	 */
	private resolveInclude(
		context: SearchContext,
		fromModule: string,
		name: string,
		kind: IncludeKind | undefined,
	): ImportResolution {
		return this.store.memo(
			`\u0000include\u0000${context}\u0000${fromModule}\u0000${kind ?? ""}\u0000${name}`,
			() => {
				const project = this.store.project;
				const written = name.replace(/\\/gu, "/");
				const searched = (search: IncludeSearch | undefined) =>
					resolutionOf(
						findInclude(
							project.root,
							this.store.policy,
							searchDirectories(project, search, fromModule, kind ?? "quoted"),
							written,
						),
						name,
						kind,
					);
				if (context === "fallback") return searched(undefined);
				const answers = context.map((search) => searched(project.searches[search]));
				return agreed(answers, `the units find different headers for ${name}`);
			},
		);
	}

	/** The forced includes every database entry for `module` names and finds alike, in the first entry's order. */
	private forcedIncludes(module: string): Array<{ written: string; resolution: ImportResolution }> {
		const entries = (this.store.project.units.get(module) ?? []).map((unit) =>
			unit.forced.map((written) => ({ written, resolution: this.forcedInclude(unit, written) })),
		);
		return (entries[0] ?? []).filter((forced) =>
			entries.every((entry) => entry.some((other) => isDeepStrictEqual(other, forced))),
		);
	}

	/** A unit's forced include, looked for in its working directory, then along its quoted search. */
	private forcedInclude(unit: CUnit, name: string): ImportResolution {
		const project = this.store.project;
		const found = findInclude(project.root, this.store.policy, forcedDirectories(project, unit), name);
		return resolutionOf(found, name, "quoted");
	}

	private bindingForReference(
		module: string,
		facts: ParsedCFile,
		reference: CReference,
		cache: Map<string, Binding>,
	): Binding {
		if (reference.member === true) return this.memberBinding(module, facts, reference, cache, 0);
		if (reference.role === "import") return this.includeBinding(module, reference);
		// Depends on where the reference is, so never cached.
		const sameFile = bindingCandidates(facts, reference);
		if (sameFile.length === 1)
			return { status: "bound", symbolId: (sameFile[0] as CDeclaration).symbolId, provenance: "bound" };
		if (sameFile.length > 1) {
			const conditional = sameFile.some((candidate) => candidate.conditionalGroup !== "");
			return conditional ? conditionalAmbiguity(sameFile) : ordinaryAmbiguity(sameFile);
		}
		const cacheKey = `${reference.name}\u0000${reference.role}\u0000${reference.tag === true}`;
		const cached = cache.get(cacheKey);
		if (cached !== undefined) return cached;
		const result = this.includedBinding(module, facts, reference);
		cache.set(cacheKey, result);
		return result;
	}

	/** A member binds to a field of its receiver's type, never to anything else of its name. */
	private memberBinding(
		module: string,
		facts: ParsedCFile,
		reference: CReference,
		cache: Map<string, Binding>,
		depth: number,
	): Binding {
		const receiver = reference.receiver === undefined ? undefined : facts.referencesByToken.get(reference.receiver);
		if (receiver === undefined)
			return unknownBinding("NotImplemented", "a member of a computed receiver is not resolved");
		if (depth > MAX_MEMBER_CHAIN) return unknownBinding("RecursionLimit", "the member chain is too long");
		const binding =
			receiver.member === true
				? this.memberBinding(module, facts, receiver, cache, depth + 1)
				: this.bindingForReference(module, facts, receiver, cache);
		if (binding.status === "unbound") return binding;
		if (binding.status === "ambiguous")
			return unknownBinding("Ambiguous", `the receiver of ${reference.name} has more than one declaration`);
		const owner = this.memberOwner(this.declared(module, facts, binding.symbolId), 0);
		if ("reason" in owner) return unknownBinding(owner.reason, owner.detail);
		const fields = declaredIn(owner.facts, reference.name, owner.declaration.symbolId).filter(
			(declaration) => declaration.kind === "field",
		);
		if (fields.length === 1)
			return { status: "bound", symbolId: (fields[0] as CDeclaration).symbolId, provenance: "bound" };
		if (fields.length > 1) {
			const conditional = fields.some((candidate) => candidate.conditionalGroup !== "");
			return conditional ? conditionalAmbiguity(fields) : ordinaryAmbiguity(fields);
		}
		return unknownBinding("NotIndexed", `the receiver's type has no field ${reference.name}`);
	}

	/** The declaration `symbolId` names, with the facts that hold it. */
	private declared(module: string, facts: ParsedCFile, symbolId: string): Declared | undefined {
		const home = parseSymbolId(symbolId)?.module ?? module;
		const held = home === module ? facts : this.factsForModule(home);
		const declaration = held?.declarationsById.get(symbolId);
		return held === null || declaration === undefined ? undefined : { module: home, facts: held, declaration };
	}

	/** The declaration whose fields a value of `typed`'s type holds, through typedefs and forward declarations. */
	private memberOwner(typed: Declared | undefined, depth: number): Declared | NoOwner {
		if (typed === undefined) return { reason: "NotIndexed", detail: "the receiver has no indexed declaration" };
		if (depth > MAX_MEMBER_CHAIN)
			return { reason: "RecursionLimit", detail: "the receiver's type chain is too long" };
		const { module, facts, declaration } = typed;
		// An anonymous body's fields sit under what it declared.
		if ((facts.childrenById.get(declaration.symbolId) ?? []).some((child) => child.kind === "field")) return typed;
		const answer = declaration.kind === "struct" ? undefined : facts.typeAnswers.get(declaration.symbolId);
		if (answer?.fieldsOf !== undefined)
			return this.memberOwner(this.declared(module, facts, answer.fieldsOf), depth + 1);
		const type: TypeName | undefined =
			declaration.kind === "struct" ? { name: declaration.name, tag: true } : answer?.typeName;
		if (type === undefined) return { reason: "NotIndexed", detail: `${declaration.name} has no named type` };
		// A forward declaration's completion may follow it; a specifier is read where it is written.
		const place =
			declaration.kind === "struct"
				? { scopeId: declaration.containerId }
				: { scopeId: declaration.containerId, at: declaration.selectionIndex };
		let found = typeCandidates(facts, type.name, type.tag, place).filter(
			(candidate) => candidate.symbolId !== declaration.symbolId,
		);
		if (found.length === 0) {
			const imported = this.crossFileCandidates(module, facts, type.name, (declared) =>
				inNamespace(declared, type.tag),
			);
			found = imported.candidates;
			if (found.length === 0 && imported.external)
				return { reason: "ExternalDependency", detail: `${type.name} is declared in an external header` };
			if (found.length === 0)
				return { reason: imported.reason ?? "NotIndexed", detail: imported.detail ?? `no C type ${type.name}` };
		}
		const next = oneType(found);
		return next === undefined
			? { reason: "Ambiguous", detail: `${type.name} has more than one declaration` }
			: this.memberOwner(this.declared(module, facts, next.symbolId), depth + 1);
	}

	private includeBinding(module: string, reference: CReference): Binding {
		const resolution = this.resolveImport({ fromModule: module, specifier: reference.name });
		if (resolution.status === "external")
			return unknownBinding("ExternalDependency", "the included header is outside the workspace");
		if (resolution.status === "unresolved")
			return unknownBinding(resolution.reason, resolution.detail ?? "the included header is unresolved");
		return unknownBinding("NotIndexed", "an include path does not name a declaration");
	}

	/** A name no declaration in this file answers, looked up in what it includes. */
	private includedBinding(module: string, facts: ParsedCFile, reference: CReference): Binding {
		const tag = reference.tag === true;
		const imported =
			reference.role === "typeUse"
				? this.crossFileCandidates(module, facts, reference.name, (found) => {
						const types = inNamespace(found, tag);
						return types.length > 0 || tag ? types : typeMacros(found);
					})
				: this.crossFileCandidates(module, facts, reference.name, macrosFirst);
		if (imported.candidates.length === 1)
			return {
				status: "bound",
				symbolId: (imported.candidates[0] as CDeclaration).symbolId,
				provenance: "bound",
			};
		if (imported.candidates.length > 1) return ordinaryAmbiguity(imported.candidates);
		if (imported.external)
			return unknownBinding(
				"ExternalDependency",
				`no indexed declaration for ${reference.name} was found in an external header`,
			);
		if (imported.reason !== undefined)
			return unknownBinding(imported.reason, imported.detail ?? "the imported declaration is unresolved");
		return unknownBinding("NotIndexed", `no C declaration matches ${reference.name}`);
	}

	/**
	 * `name` in what `module` includes: the nearest include depth holding any `accept` keeps, so a
	 * header included directly outranks a platform twin further in.
	 */
	private crossFileCandidates(
		module: string,
		facts: ParsedCFile,
		name: string,
		accept: (found: CDeclaration[]) => CDeclaration[] = (found) => found,
	): { candidates: CDeclaration[]; external: boolean; reason?: UnknownReason; detail?: string } {
		const { names, external, reason, detail } = this.reached(module, facts);
		const unfound = { candidates: [], external, ...defined({ reason, detail }) };
		const depths = names.get(name) ?? [];
		for (let depth = 0; depth < depths.length; depth++) {
			const declared = depths[depth];
			const candidates = declared === undefined ? [] : accept(declared);
			if (candidates.length > 0) return { ...unfound, candidates };
		}
		return unfound;
	}

	/** What `module` includes, through its headers' own includes; one walk per module and store generation. */
	private reached(module: string, facts: ParsedCFile): Reach {
		const held = this.store.memo(`\u0000reach\u0000${module}`, () => ({
			facts,
			reach: this.walkIncludes(module, facts),
		}));
		// A probe's text is not the held one, and a header that could not be read may read next time.
		return held.facts === facts && !held.reach.incomplete ? held.reach : this.walkIncludes(module, facts);
	}

	/**
	 * Breadth first, one depth per include level, every header searched with `module`'s own lists; a
	 * unit's forced includes come first. A header seen once is not walked again. The file-scope
	 * declarations reached are indexed by name and depth, once.
	 */
	private walkIncludes(module: string, facts: ParsedCFile): Reach {
		const project = this.store.project;
		const context = contextOf(project, module);
		const reach: Reach = { names: new Map(), external: false, incomplete: false };
		const seen = new Set([module]);
		let depth = 0;
		let frontier: Array<{ from: string; imports: readonly CImportFact[] }> = [];
		const visit = (resolution: ImportResolution, written: string) => {
			if (resolution.status === "external") reach.external = true;
			if (resolution.status === "unresolved") {
				reach.reason = resolution.reason;
				reach.detail = resolution.detail ?? `no workspace header matches ${written}`;
			}
			if (resolution.status !== "resolved" || seen.has(resolution.module)) return;
			seen.add(resolution.module);
			const header = this.factsForModule(resolution.module);
			if (header === null) {
				reach.reason = "NotIndexed";
				reach.detail = `the included module ${resolution.module} is not indexed`;
				reach.incomplete = true;
				return;
			}
			frontier.push({ from: resolution.module, imports: header.imports });
			for (const declaration of header.declarations) {
				const lexical = lexicalScope(header, declaration);
				const fileScope =
					declaration.containerId === undefined || (lexical !== undefined && lexical.scope === undefined);
				if (!fileScope || declaration.exported === false) continue;
				const depths = reach.names.get(declaration.name) ?? [];
				reach.names.set(declaration.name, depths);
				const atDepth = depths[depth] ?? [];
				depths[depth] = atDepth;
				atDepth.push(declaration);
			}
		};
		for (const { written, resolution } of this.forcedIncludes(module)) visit(resolution, written);
		let reading: typeof frontier = [{ from: module, imports: facts.imports }];
		while (reading.length > 0) {
			for (const { from, imports } of reading)
				for (const imported of imports)
					visit(this.resolveInclude(context, from, imported.specifier, imported.kind), imported.specifier);
			reading = frontier;
			frontier = [];
			depth++;
		}
		return reach;
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknownBinding("NotIndexed", "module is not indexed");
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && containsStart(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(params.module, facts, reference, new Map());
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				containsStart(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return unknownBinding("NotIndexed", "no indexed reference or declaration matched the requested range");
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) {
			const parsed = parseSymbolId(params.symbolId);
			if (parsed === null || parsed.language !== LANGUAGE)
				return { status: "unknown", reason: "ParseError", detail: "the symbol id is not a C workspace id" };
			const facts = this.factsForModule(parsed.module);
			if (facts === null) return { status: "unknown", reason: "NotIndexed", detail: "module is not indexed" };
			if (!facts.declarations.some((declaration) => declaration.symbolId === params.symbolId))
				return { status: "unknown", reason: "NotIndexed", detail: "the symbol id has no indexed declaration" };
			return typeInfoFor(facts, params.symbolId);
		}
		const facts = this.factsForModule(params.module);
		if (facts === null) return { status: "unknown", reason: "NotIndexed", detail: "module is not indexed" };
		const declaration =
			facts.declarations.find(
				(candidate) =>
					candidate.typeRange !== undefined && containsStart(candidate.typeRange, params.range.start),
			) ??
			facts.declarations.find((candidate) =>
				containsStart(candidate.selectionRange ?? candidate.range, params.range.start),
			);
		if (declaration === undefined)
			return {
				status: "unknown",
				reason: "NotIndexed",
				detail: "no indexed declaration or type range matched the requested range",
			};
		return typeInfoFor(facts, declaration.symbolId);
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "C move edits are not implemented" };
	}
}

////////////////////////////////
//  Functions & Helpers

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new CProvider()): void {
	serveProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new CProvider()));
