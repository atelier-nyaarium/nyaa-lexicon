import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	AdmissionLedger,
	type Binding,
	comparePositions,
	type Declaration,
	handlersFor,
	type ImportResolution,
	type IndexDepth,
	type ModuleAdmission,
	type MoveEditsRequest,
	type MoveEditsResponse,
	notImplementedMove,
	PROTOCOL_VERSION,
	type ProjectModel,
	parseSymbolId,
	projectDiagnostic,
	type Range,
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	readSourceFile,
	runProviderOnStdio,
	type SourceFileRead,
	type TypeInfo,
	type UnknownReason,
	walkWorkspace,
	serveProvider as wireProvider,
	workspaceFile,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { ReferenceBinder } from "./binding.js";
import { type KotlinFile, LANGUAGE, REFERENCE_ROLES, type TypeFact } from "./facts.js";
import { cleanSpecifier, fileSite, type ModuleHeaders, PackageIndex } from "./packageIndex.js";
import { parseKotlin } from "./parse.js";

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

/** Kotlin's hard, soft and modifier keywords, merged. Builtins are the standard library's core types. */
export const WORDS = {
	keywords: [
		"abstract",
		"actual",
		"annotation",
		"as",
		"break",
		"by",
		"catch",
		"class",
		"companion",
		"const",
		"constructor",
		"context",
		"continue",
		"crossinline",
		"data",
		"delegate",
		"do",
		"dynamic",
		"else",
		"enum",
		"expect",
		"external",
		"field",
		"file",
		"final",
		"finally",
		"for",
		"fun",
		"get",
		"if",
		"import",
		"in",
		"infix",
		"init",
		"inline",
		"inner",
		"interface",
		"internal",
		"is",
		"lateinit",
		"noinline",
		"object",
		"open",
		"operator",
		"out",
		"override",
		"package",
		"param",
		"private",
		"property",
		"protected",
		"public",
		"receiver",
		"reified",
		"return",
		"sealed",
		"set",
		"setparam",
		"super",
		"suspend",
		"tailrec",
		"this",
		"throw",
		"try",
		"typealias",
		"val",
		"value",
		"var",
		"vararg",
		"when",
		"where",
		"while",
	],
	builtins: [
		"Any",
		"Array",
		"Boolean",
		"Byte",
		"Char",
		"Double",
		"Float",
		"Int",
		"List",
		"Long",
		"Map",
		"MutableList",
		"MutableMap",
		"MutableSet",
		"Nothing",
		"Set",
		"Short",
		"String",
		"UByte",
		"UInt",
		"ULong",
		"UShort",
		"Unit",
	],
	literals: ["false", "null", "true"],
};

const EXTENSIONS = [".kt"];
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".gradle",
	".idea",
	".kotlin",
	".mvn",
	"build",
	"dist",
	"generated",
	"node_modules",
	"out",
	"target",
]);

export { LANGUAGE, REFERENCE_ROLES };

type RangeLike = Declaration["range"];

function contains(range: RangeLike, position: RangeLike["start"]): boolean {
	return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function unknown(reason: UnknownReason, detail: string): { status: "unbound"; reason: UnknownReason; detail: string } {
	return { status: "unbound", reason, detail };
}

function unknownType(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

function bound(symbolId: string): Binding {
	return { status: "bound", symbolId, provenance: "bound" };
}

function simpleTypeName(display: string): string | undefined {
	const match = /(?:^|[<,( .])([A-Za-z_][A-Za-z0-9_]*)(?:\?|$)/u.exec(display.trim());
	return match?.[1];
}

function admitted(facts: KotlinFile): boolean {
	return !facts.diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export class KotlinProvider {
	private workspaceRoot = process.cwd();
	/** Full parses, for `bind` and `typeOf`. */
	private readonly parsedFacts = new Map<string, KotlinFile>();
	private workspaceFiles: string[] | null = null;
	/** Each module's last facts the core would admit. */
	private index = new PackageIndex();
	/** The index before a rediscovery, until the next fill has read past it. */
	private previous: PackageIndex | undefined;
	/** Whether discovered files the index lacks have been read. */
	private filled = false;
	/** Present but unreadable at the last read; retried on a lookup. */
	private readonly unread = new Set<string>();
	/** The core's word on each parse, and what the index must hold when one is refused. */
	private readonly admission = new AdmissionLedger<ModuleHeaders>();

	initialize(workspaceRoot: string) {
		this.reset(workspaceRoot);
		return {
			providerId: "kotlin-provider",
			language: LANGUAGE,
			extensions: EXTENSIONS,
			protocolVersion: PROTOCOL_VERSION,
			tiers: TIERS,
			referenceRoles: [...REFERENCE_ROLES],
			words: WORDS,
		};
	}

	discoverProject(workspaceRoot = this.workspaceRoot): ProjectModel {
		if (path.resolve(workspaceRoot) !== this.workspaceRoot) this.reset(workspaceRoot);
		else this.rewalk();
		try {
			if (!existsSync(this.workspaceRoot))
				return projectDiagnostic(this.workspaceRoot, `workspace root does not exist: ${this.workspaceRoot}`);
			if (!statSync(this.workspaceRoot).isDirectory())
				return projectDiagnostic(
					this.workspaceRoot,
					`workspace root is not a directory: ${this.workspaceRoot}`,
				);
			return { files: this.filesInWorkspace(), externalRoots: [], configFiles: [], diagnostics: [] };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return projectDiagnostic(this.workspaceRoot, `unable to inspect workspace root: ${detail}`);
		}
	}

	parseFile(params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined }) {
		const outline = params.depth === "outline";
		const facts = parseKotlin(params.module, params.text, outline);
		if (outline) this.parsedFacts.delete(params.module);
		else this.parsedFacts.set(params.module, facts);
		this.unread.delete(params.module);
		// The core decides; `moduleAdmission` puts back what a refusal displaced.
		this.admission.staged(params.module, params.contentHash, this.index.headersOf(params.module));
		this.index.add(facts);
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: outline ? [] : this.wireReferences(facts),
			imports: facts.imports.map(({ specifier, imported, reExport }) => ({ specifier, imported, reExport })),
			literals: outline ? [] : facts.literals,
			comments: outline ? [] : facts.comments,
			diagnostics: facts.diagnostics,
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = cleanSpecifier(params.specifier);
		if (specifier === "")
			return { status: "unresolved", reason: "ParseError", detail: "the import specifier is empty" };
		const index = this.packageIndex();
		if (params.specifier.endsWith(".*") && index.hasPackage(specifier)) {
			const modules = index.modulesIn(specifier);
			return modules.length === 1
				? { status: "resolved", module: modules[0] as string }
				: {
						status: "unresolved",
						reason: "Ambiguous",
						detail: `package ${specifier} spans ${modules.length} workspace files`,
					};
		}
		const resolution = index.resolvePath(fileSite(params.fromModule), specifier);
		if (resolution.status === "external") return { status: "external", packageName: specifier };
		if (resolution.status === "unresolved") return resolution;
		const modules = [...new Set(resolution.entries.map((entry) => entry.module))];
		return modules.length === 1
			? { status: "resolved", module: modules[0] as string }
			: {
					status: "unresolved",
					reason: "Ambiguous",
					detail: `several workspace files declare ${specifier}`,
				};
	}

	bind(params: { module: string; name: string; range: Range }) {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknown("NotIndexed", "module is not indexed");
		const reference = facts.references.find(
			(candidate) =>
				candidate.reference.name === params.name && contains(candidate.reference.range, params.range.start),
		);
		if (reference !== undefined) return this.binder(facts).resolve(reference).binding;
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				contains(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return bound(declaration.symbolId);
		return unknown("NotIndexed", "no indexed reference or declaration matched the requested range");
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) return this.typeOfSymbol(params.symbolId);
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");
		if (facts.diagnostics.some((item) => item.severity === "error"))
			return unknownType("ParseError", "the module has syntax errors");
		const annotation = facts.typeFacts.find(
			(fact) => fact.annotationRange !== undefined && contains(fact.annotationRange, params.range.start),
		);
		if (annotation !== undefined) return this.withTypeSymbol(facts, annotation);
		const declaration = facts.declarations.find((candidate) =>
			contains(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return this.typeForDeclaration(facts, declaration);
		const reference = facts.references.find((candidate) => contains(candidate.reference.range, params.range.start));
		if (reference !== undefined) {
			const binding = this.binder(facts).resolve(reference).binding;
			if (binding.status === "bound") return this.typeOfSymbol(binding.symbolId);
		}
		return unknownType("NotIndexed", "no indexed type target matched the requested range");
	}

	forgetModule(params: { module: string }): void {
		this.parsedFacts.delete(params.module);
		this.index.remove(params.module);
		this.previous?.remove(params.module);
		this.unread.delete(params.module);
		this.admission.forgotten(params.module);
	}

	/** A refusal puts back what the parse displaced, so the index holds what the core holds. */
	moduleAdmission(params: ModuleAdmission): void {
		const restore = this.admission.settle(params);
		if (restore === null) return;
		// Drop the refused full parse.
		this.parsedFacts.delete(restore.module);
		this.index.remove(restore.module);
		if (restore.facts !== undefined) this.index.add(restore.facts);
	}

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "Kotlin rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("Kotlin move edits are not implemented");
	}

	private reset(workspaceRoot: string): void {
		this.workspaceRoot = path.resolve(workspaceRoot);
		this.parsedFacts.clear();
		this.workspaceFiles = null;
		this.index = new PackageIndex();
		this.previous = undefined;
		this.filled = false;
		this.unread.clear();
		this.admission.reset();
	}

	/** Every module is read again, and the old index answers only for text that cannot be admitted. */
	private rewalk(): void {
		this.parsedFacts.clear();
		this.workspaceFiles = null;
		this.filled = false;
		this.unread.clear();
		if (this.previous === undefined) this.previous = this.index;
		else
			for (const module of this.index.heldModules())
				this.previous.add(this.index.headersOf(module) as ModuleHeaders);
		this.index = new PackageIndex();
	}

	private filesInWorkspace(): string[] {
		if (this.workspaceFiles !== null) return this.workspaceFiles;
		if (!existsSync(this.workspaceRoot) || !statSync(this.workspaceRoot).isDirectory()) return [];
		this.workspaceFiles = walkWorkspace(this.workspaceRoot, {
			extensions: EXTENSIONS,
			excludedDirectories: EXCLUDED_DIRECTORIES,
		}).files;
		return this.workspaceFiles;
	}

	private read(module: string): SourceFileRead {
		const absolute = workspaceFile(this.workspaceRoot, module);
		return absolute === null ? { kind: "missing" } : readSourceFile(absolute);
	}

	private factsForModule(module: string): KotlinFile | null {
		const cached = this.parsedFacts.get(module);
		if (cached !== undefined) return cached;
		if (!this.admission.fillable(module)) return null;
		const read = this.read(module);
		if (read.kind !== "text") return null;
		const facts = parseKotlin(module, read.text);
		this.parsedFacts.set(module, facts);
		return facts;
	}

	/** Outline facts of every discovered file on first use, so the first file parsed binds into the rest. */
	private packageIndex(): PackageIndex {
		if (this.filled) {
			for (const module of [...this.unread]) this.indexFromDisk(module);
			return this.index;
		}
		this.filled = true;
		const previous = this.previous;
		this.previous = undefined;
		const modules = new Set([...this.filesInWorkspace(), ...(previous?.heldModules() ?? [])]);
		for (const module of [...modules].sort())
			if (!this.index.holds(module) && this.admission.fillable(module)) this.indexFromDisk(module, previous);
		return this.index;
	}

	/** Refused or unreadable text keeps what was admitted; a file the core would not read leaves. */
	private indexFromDisk(module: string, previous?: PackageIndex): void {
		this.unread.delete(module);
		const read = this.read(module);
		const facts = read.kind === "text" ? parseKotlin(module, read.text, true) : undefined;
		// A disk read gets no core verdict, so the provider judges.
		if (facts !== undefined && admitted(facts)) {
			this.index.add(facts);
			return;
		}
		if (read.kind === "unreadable") this.unread.add(module);
		else if (read.kind !== "text") {
			this.index.remove(module);
			return;
		}
		const held = previous?.headersOf(module);
		if (held !== undefined) this.index.add(held);
	}

	private binder(facts: KotlinFile): ReferenceBinder {
		return new ReferenceBinder(this.packageIndex(), facts);
	}

	private wireReferences(facts: KotlinFile): Reference[] {
		const binder = this.binder(facts);
		return facts.references.map((info) => ({ ...info.reference, binding: binder.resolve(info).binding }));
	}

	private typeOfSymbol(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE)
			return unknownType("ParseError", "the symbol id is not a Kotlin workspace id");
		const facts = this.factsForModule(parsed.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");
		const declaration = facts.declarations.find((candidate) => candidate.symbolId === symbolId);
		if (declaration === undefined) return unknownType("ParseError", "the symbol id has no Kotlin declaration");
		return this.typeForDeclaration(facts, declaration);
	}

	private typeForDeclaration(facts: KotlinFile, declaration: Declaration): TypeInfo {
		const fact = facts.typeFacts.find((candidate) => candidate.symbolId === declaration.symbolId);
		if (fact === undefined)
			return unknownType(
				"NotImplemented",
				"Kotlin type inference is limited to declared types and literal properties",
			);
		return this.withTypeSymbol(facts, fact);
	}

	/** The written type's own reference, bound as any use of it is. */
	private withTypeSymbol(facts: KotlinFile, fact: TypeFact): TypeInfo {
		const { answer, annotationRange } = fact;
		if (answer.status !== "known" || annotationRange === undefined) return answer;
		const typeName = simpleTypeName(answer.display);
		const written = facts.references.find(
			(info) =>
				info.reference.role === "typeUse" &&
				info.reference.name === typeName &&
				contains(annotationRange, info.reference.range.start),
		);
		if (written === undefined) return answer;
		const binding = this.binder(facts).resolve(written).binding;
		return binding.status === "bound" ? { ...answer, symbolId: binding.symbolId } : answer;
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new KotlinProvider()): void {
	wireProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new KotlinProvider()));
