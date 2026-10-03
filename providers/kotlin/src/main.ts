import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
	type ArrangeEditsRequest,
	type Binding,
	comparePositions,
	type Declaration,
	defined,
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
	type ScopeContribution,
	type StoreProvider,
	type TypeInfo,
	type UnknownReason,
	walkWorkspace,
	serveProvider as wireProvider,
} from "@nyaa-lexicon/protocol";
import type { createMessageConnection } from "vscode-jsonrpc/node";
import { ReferenceBinder } from "./binding.js";
import { type KotlinFile, LANGUAGE, REFERENCE_ROLES, type ReferenceInfo, type TypeFact } from "./facts.js";
import {
	cleanSpecifier,
	fileSite,
	type IndexedDeclaration,
	isClassifier,
	isCompanion,
	isMember,
	isObject,
	isStatic,
	PackageIndex,
	type PackageIndexEntry,
} from "./packageIndex.js";
import { parseKotlin } from "./parse.js";

const PROVIDER_ID = "kotlin-provider";

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

/** `import p.C.*` opens the one classifier the path names. */
function classScope(specifier: string, entries: readonly IndexedDeclaration[]): ImportResolution {
	const classifiers = entries.filter((entry) => isClassifier(entry.declaration));
	const [only] = classifiers;
	if (only === undefined)
		return { status: "unresolved", reason: "NotIndexed", detail: `${specifier} names no package or class` };
	if (classifiers.length > 1)
		return { status: "unresolved", reason: "Ambiguous", detail: `several workspace files declare ${specifier}` };
	return {
		status: "resolved",
		landing: {
			kind: "symbolScope",
			providerId: PROVIDER_ID,
			scopeId: specifier,
			anchorSymbolId: only.declaration.symbolId,
		},
	};
}

/** No import can name the default package, so it has no scope. */
function packageContributions(facts: KotlinFile): ScopeContribution[] {
	if (facts.packageName === undefined) return [];
	const members = facts.declarations
		.filter(
			(declaration) =>
				declaration.containerId === undefined &&
				declaration.kind !== "package" &&
				declaration.exported !== false,
		)
		.map((declaration) => declaration.symbolId);
	return [{ kind: "packageScope", scopeId: facts.packageName, members }];
}

/** A member a use outside its class may name. */
function seenOutside(declaration: Declaration): boolean {
	return isMember(declaration) && declaration.visibility !== "private" && declaration.visibility !== "protected";
}

/** A classifier's names from its top-level one down; none inside a function or another declaration. */
function classPath(declaration: Declaration, byId: ReadonlyMap<string, Declaration>): string[] | undefined {
	const path: string[] = [];
	for (let current: Declaration | undefined = declaration; current !== undefined; ) {
		if (!isClassifier(current) || current.visibility === "local") return undefined;
		path.unshift(current.name);
		if (current.containerId === undefined) return path;
		current = byId.get(current.containerId);
	}
	return undefined;
}

/**
 * Each classifier's scope, which `import p.C.*` lands on by C's path: what `C.name` reaches with no
 * instance, as `staticMembers` reads it. A companion's member yields to a direct one of its name.
 */
function classContributions(facts: KotlinFile): ScopeContribution[] {
	const { packageName } = facts;
	if (packageName === undefined) return [];
	const byId = new Map(facts.declarations.map((declaration) => [declaration.symbolId, declaration]));
	const children = new Map<string, Declaration[]>();
	for (const declaration of facts.declarations)
		if (declaration.containerId !== undefined)
			children.set(declaration.containerId, [...(children.get(declaration.containerId) ?? []), declaration]);
	const contributions: ScopeContribution[] = [];
	for (const declaration of facts.declarations) {
		const path = classPath(declaration, byId);
		if (path === undefined) continue;
		const held = children.get(declaration.symbolId) ?? [];
		const object = isObject(declaration);
		const direct = held.filter((child) => seenOutside(child) && (object || isStatic(child)));
		const names = new Set(direct.map((child) => child.name));
		const companions = held
			.filter(isCompanion)
			.flatMap((companion) => children.get(companion.symbolId) ?? [])
			.filter((member) => seenOutside(member) && !names.has(member.name));
		contributions.push({
			kind: "symbolScope",
			scopeId: [packageName, ...path].join("."),
			members: [...direct, ...companions].map((member) => member.symbolId),
		});
	}
	return contributions;
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

export class KotlinProvider implements StoreProvider<KotlinFile, null, PackageIndexEntry> {
	readonly store = moduleStore<KotlinFile, null, PackageIndexEntry>({
		read: (module, text, depth) => parseKotlin(module, text, depth === "outline"),
		entries: packageEntries,
	});
	private readonly index = new PackageIndex(this.store);

	initialize(_workspaceRoot: string) {
		return {
			providerId: PROVIDER_ID,
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
			imports: facts.imports.map(({ specifier, edge }) => ({ specifier, edges: [edge] })),
			scopeContributions: [...packageContributions(facts), ...classContributions(facts)],
			literals: outline ? [] : facts.literals,
			comments: outline ? [] : facts.comments,
			...(outline ? {} : defined({ blankLines: facts.blankLines })),
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
		const starred = params.specifier.endsWith(".*");
		if (starred && index.hasPackage(specifier))
			return {
				status: "resolved",
				landing: { kind: "packageScope", providerId: PROVIDER_ID, scopeId: specifier },
			};
		const resolution = index.resolvePath(fileSite(params.fromModule), specifier);
		if (resolution.status === "external") return { status: "external", packageName: specifier };
		if (resolution.status === "unresolved") return resolution;
		if (starred) return classScope(specifier, resolution.entries);
		const modules = [...new Set(resolution.entries.map((entry) => entry.module))];
		return modules.length === 1
			? { status: "resolved", landing: { kind: "module", module: modules[0] as string } }
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

	arrangeEdits(_params: ArrangeEditsRequest): MoveEditsResponse {
		return notImplementedMove("Kotlin arrange edits are not implemented");
	}

	private factsForModule(module: string): KotlinFile | null {
		return this.store.load(module, "full") ?? null;
	}

	private binder(facts: KotlinFile): ReferenceBinder {
		return new ReferenceBinder(this.index, facts);
	}

	private wireReferences(facts: KotlinFile): Reference[] {
		const binder = this.binder(facts);
		return facts.references.map((info) => {
			const { binding } = binder.resolve(info);
			return { ...info.reference, binding, ...defined({ qualified: this.qualifiedBy(info, binding) }) };
		});
	}

	/**
	 * A use through a receiver that binds a class member is out of reach of every local, and a member
	 * outranks every extension, so no rename can capture it.
	 */
	private qualifiedBy(info: ReferenceInfo, binding: Binding): boolean | undefined {
		const written = info.reference.qualified;
		if (written !== undefined || info.receiver === undefined || binding.status !== "bound") return written;
		const target = this.index.declaration(binding.symbolId)?.declaration;
		const containerId = target?.containerId;
		const container = containerId === undefined ? undefined : this.index.declaration(containerId)?.declaration;
		if (target === undefined || container === undefined || !isClassifier(container)) return undefined;
		return this.index.receiverTypeOf(target.symbolId) === undefined ? true : undefined;
	}

	private typeOfSymbol(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE)
			return unknownType("ParseError", "the symbol id is not a Kotlin workspace id");
		const facts = this.factsForModule(parsed.module);
		if (facts === null) return unknownType("NotIndexed", "module is not indexed");
		const declaration = facts.declarations.find((candidate) => candidate.symbolId === symbolId);
		if (declaration === undefined) return unknownType("NotIndexed", "the symbol id has no Kotlin declaration");
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

	/** The written head type's own reference, bound as any use of it is. */
	private withTypeSymbol(facts: KotlinFile, fact: TypeFact): TypeInfo {
		const { answer, head } = fact;
		if (answer.status !== "known" || head === undefined) return answer;
		const written = facts.references.find((info) => info.reference.role === "typeUse" && info.offset === head);
		if (written === undefined) return answer;
		const binding = this.binder(facts).resolve(written).binding;
		return binding.status === "bound" ? { ...answer, symbolId: binding.symbolId } : answer;
	}
}

export function serve(connection: ReturnType<typeof createMessageConnection>, provider = new KotlinProvider()): void {
	wireProvider(connection, handlersFor(provider));
}

if (import.meta.main) runProviderOnStdio(handlersFor(new KotlinProvider()));
