import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type Binding,
	comparePositions,
	type Declaration,
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
	type Reference,
	type RenameEditsRequest,
	type RenameEditsResponse,
	runProviderOnStdio,
	type StoreProvider,
	type TypeInfo,
	type UnknownReason,
	walkWorkspace,
	serveProvider as wireProvider,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { ReferenceBinder } from "./binding.js";
import { type KotlinFile, LANGUAGE, REFERENCE_ROLES, type TypeFact } from "./facts.js";
import { cleanSpecifier, fileSite, PackageIndex, type PackageIndexEntry } from "./packageIndex.js";
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
	fileRoles: true,
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

function packageEntries(module: string, facts: KotlinFile): Iterable<readonly [string, PackageIndexEntry]> {
	const packageName = facts.packageName ?? "";
	const entries: [string, PackageIndexEntry][] = [[`pkg:${packageName}`, module]];
	const segments = packageName.split(".");
	for (let length = 1; length <= segments.length; length++)
		entries.push([`prefix:${segments.slice(0, length).join(".")}`, module]);
	for (const declaration of facts.declarations) {
		if (declaration.kind === "package") continue;
		const indexed = { declaration, module };
		entries.push([`id:${declaration.symbolId}`, indexed]);
		entries.push([
			declaration.containerId === undefined
				? `top:${packageName}\0${declaration.name}`
				: `child:${declaration.containerId}`,
			indexed,
		]);
	}
	return entries;
}

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

export class KotlinProvider implements StoreProvider<KotlinFile, null, PackageIndexEntry> {
	readonly store = moduleStore<KotlinFile, null, PackageIndexEntry>({
		read: (module, text, depth) => parseKotlin(module, text, depth === "outline"),
		entries: packageEntries,
	});
	private readonly index = new PackageIndex(this.store);

	initialize(_workspaceRoot: string) {
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

	discoverProject(workspaceRoot: string, _previous: null | undefined): { model: ProjectModel; project: null } {
		const root = path.resolve(workspaceRoot);
		try {
			if (!existsSync(root))
				return { model: projectDiagnostic(root, `workspace root does not exist: ${root}`), project: null };
			if (!statSync(root).isDirectory())
				return {
					model: projectDiagnostic(root, `workspace root is not a directory: ${root}`),
					project: null,
				};
			return {
				model: {
					files: walkWorkspace(root, {
						extensions: EXTENSIONS,
						excludedDirectories: EXCLUDED_DIRECTORIES,
					}).files,
					externalRoots: [],
					configFiles: [],
					diagnostics: [],
				},
				project: null,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { model: projectDiagnostic(root, `unable to inspect workspace root: ${detail}`), project: null };
		}
	}

	parseFile(
		params: { module: string; contentHash: string; text: string; depth?: IndexDepth | undefined },
		facts: KotlinFile,
	) {
		const outline = params.depth === "outline";
		return {
			module: params.module,
			contentHash: params.contentHash,
			declarations: facts.declarations,
			references: outline ? [] : this.wireReferences(facts),
			imports: facts.imports.map(({ specifier, imported, reExport }) => ({ specifier, imported, reExport })),
			literals: outline ? [] : facts.literals,
			comments: outline ? [] : facts.comments,
			diagnostics: facts.diagnostics,
			role: facts.role,
			...(outline ? { depth: "outline" as const } : {}),
		};
	}

	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const specifier = cleanSpecifier(params.specifier);
		if (specifier === "")
			return { status: "unresolved", reason: "ParseError", detail: "the import specifier is empty" };
		const index = this.index;
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

	renameEdits(_params: RenameEditsRequest): RenameEditsResponse {
		return { status: "refused", reason: "NotImplemented", detail: "Kotlin rename edits are not implemented" };
	}

	moveEdits(_params: MoveEditsRequest): MoveEditsResponse {
		return notImplementedMove("Kotlin move edits are not implemented");
	}

	private factsForModule(module: string): KotlinFile | null {
		return this.store.load(module, "full") ?? null;
	}

	private binder(facts: KotlinFile): ReferenceBinder {
		return new ReferenceBinder(this.index, facts);
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
