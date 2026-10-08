import path from "node:path";
import {
	type ArrangeEditsRequest,
	type Binding,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	defined,
	type Import,
	type ImportEditsRequest,
	type ImportEditsResponse,
	type ImportKind,
	type MoveEditsRequest,
	type MoveEditsResponse,
	parseSymbolId,
	type Reference,
	type ReferenceOrigin,
	type RenameEditsRequest,
	type RenameEditsResponse,
	type TypeInfo,
	type UnknownReason,
	withOccurrences,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { makeArrangeEdits } from "./arrange.js";
import { isLikelyBundle } from "./bundle.js";
import { commonJsMemberValue, isCommonJsTarget, isModuleName, meaningOf } from "./edges.js";
import { type Extracted, extractFile, extractFileWithNodes, LANGUAGE } from "./extract.js";
import { claimsExtension, scriptKindOf } from "./file-types.js";
import { exportedAs, makeImportEdits } from "./import-edits.js";
import { aliasEdgeSpan } from "./imports.js";
import type { TypeScriptProject, TypeScriptStore, TypeScriptValue } from "./module.js";
import { makeMoveEdits } from "./move.js";
import type { ModuleResolver, SpecifierRenderer } from "./project.js";
import { overlaidSystem, runsAsEsm, toModule } from "./project.js";
import {
	contextualPropertySymbol,
	destructuredElement,
	isModuleMemberShorthand,
	meaningAt,
	memberRoute,
} from "./references.js";
import { makeRenameEdits } from "./rename.js";
import { extractSurfaceFile } from "./surface.js";

////////////////////////////////
//  Interfaces & Types

interface Position {
	line: number;
	character: number;
}

interface Range {
	start: Position;
	end: Position;
}

interface SourceContext {
	source: ts.SourceFile;
	checker: ts.TypeChecker;
	program: ts.Program;
}

interface SourceFailure {
	reason: UnknownReason;
	detail: string;
}

type SourceContextResult = SourceContext | SourceFailure;

class ProgramGenerationStats {
	private last: ts.Program | undefined;
	private generations = 0;
	private firstProgramMs: number | undefined;
	private firstProgramWorkspaceFiles = 0;

	/** A new Program object is a rebuild. */
	observe(program: ts.Program | undefined, elapsedMs: number, workspaceFiles: () => number): void {
		if (program === undefined || program === this.last) return;
		this.last = program;
		this.generations += 1;
		if (this.firstProgramMs === undefined) {
			this.firstProgramMs = elapsedMs;
			this.firstProgramWorkspaceFiles = workspaceFiles();
		}
	}

	snapshot(rootFiles: number): {
		rootFiles: number;
		workspaceFiles: number;
		firstProgramMs: number | undefined;
		programGenerations: number;
	} {
		return {
			rootFiles,
			workspaceFiles: this.firstProgramWorkspaceFiles,
			firstProgramMs: this.firstProgramMs,
			programGenerations: this.generations,
		};
	}
}

/** Withheld, unlike external, cannot name workspace symbols. */
interface MappedDeclaration {
	id: string | undefined;
	external: boolean;
	withheld: boolean;
	node: ts.Declaration;
}

/** Proposed texts read in place of what the store holds, for one batch probe. */
export interface Overlay {
	readonly files: ReadonlyMap<string, { readonly text: string; readonly contentHash: string }>;
	/** Versions this view's program apart from the store's. */
	readonly tag: string;
	/** This view's memos, which die with the probe. */
	readonly memos: Map<string, unknown>;
}

////////////////////////////////
//  Class

export class TypeScriptAnalyzer {
	private readonly service: ts.LanguageService;
	private readonly programCounters = new ProgramGenerationStats();

	/** Store text gates symbols; disk serves type reads. An overlay's texts stand in for the store's. */
	constructor(
		private readonly store: TypeScriptStore,
		private readonly project: TypeScriptProject,
		private readonly overlay?: Overlay,
		private readonly registry: ts.DocumentRegistry = ts.createDocumentRegistry(),
	) {
		const root = project.root;
		const compiler = project.loaded;
		const directories =
			overlay === undefined ? compiler.system : overlaidSystem(root, overlay.files, compiler.system);

		const host: ts.LanguageServiceHost = {
			getCompilationSettings: () => compiler.options,
			getCurrentDirectory: () => root,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			getProjectVersion: () => `${store.generation}${overlay === undefined ? "" : `:${overlay.tag}`}`,
			getScriptFileNames: () => [
				...new Set([
					...project.roots,
					...store.get("root").map((module) => this.fileName(module)),
					...this.overlaidRoots(),
				]),
			],
			getScriptKind: (fileName) => scriptKindOf(fileName),
			getScriptSnapshot: (fileName) => {
				const text = this.hostText(fileName);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
			getScriptVersion: (fileName) => this.scriptVersion(fileName),
			fileExists: (fileName) => this.hostText(fileName) !== undefined || compiler.system.fileExists(fileName),
			readFile: (fileName) => this.hostText(fileName) ?? compiler.system.readFile(fileName),
			readDirectory: compiler.system.readDirectory,
			directoryExists: directories.directoryExists,
			getDirectories: compiler.system.getDirectories,
			...(compiler.system.realpath ? { realpath: compiler.system.realpath } : {}),
			useCaseSensitiveFileNames: () => compiler.system.useCaseSensitiveFileNames,
		};
		host.resolveModuleNames = (names, containingFile) =>
			names.map((name) => ts.resolveModuleName(name, containingFile, compiler.options, host).resolvedModule);
		this.service = ts.createLanguageService(host, registry);
	}

	/** A view of `overlay` over this one's store, sharing its parsed documents. */
	overlaid(overlay: Overlay): TypeScriptAnalyzer {
		return new TypeScriptAnalyzer(this.store, this.project, overlay, this.registry);
	}

	/** What the store holds for `module`, or what the overlay proposes. */
	held(module: string): Pick<TypeScriptValue, "surface"> | undefined {
		const proposed = this.overlay?.files.get(module);
		if (proposed === undefined) return this.store.peek(module);
		return { surface: isSurfaceText(module, proposed.text) };
	}

	/** Each reference's binding, and the import edge or declaration it resolves through. */
	bindReferences(module: string, references: readonly Reference[], imports: readonly Import[]): Reference[] {
		const context = this.sourceContext(module);
		if (isSourceFailure(context)) {
			return references.map((reference) => ({
				...reference,
				binding: unknownBinding(context.reason, context.detail),
			}));
		}
		const edges = edgeKinds(imports);
		const coordinates = coordinatesOf(context.source.text);
		return references.map((reference) => {
			const position = coordinates.offsetAt(reference.range.start);
			const token = position === undefined ? undefined : tokenAt(context.source, position, reference.name);
			if (token === undefined) {
				return {
					...reference,
					binding: unknownBinding("RuntimeConstructed", "the name is not a source token"),
				};
			}
			const { binding, origin } = this.use(context, token, edges);
			return { ...reference, binding, ...defined({ origin }) };
		});
	}

	sourceFile(module: string): ts.SourceFile | undefined {
		const context = this.sourceContext(module);
		return isSourceFailure(context) ? undefined : context.source;
	}

	/** Keyed by the script version the Program parsed, so every reader of one parse shares it. */
	extract(module: string, source: ts.SourceFile): Extracted {
		const context = this.sourceContext(module);
		if (isSourceFailure(context)) return extractFile(module, source);
		const version = this.scriptVersion(context.source.fileName);
		return this.memo(`extract:${module}:${version}`, () => extractFile(module, context.source, context.checker));
	}

	bind(module: string, name: string, range: Range): Binding {
		const context = this.sourceContext(module);
		if (isSourceFailure(context)) return unknownBinding(context.reason, context.detail);
		const position = coordinatesOf(context.source.text).offsetAt(range.start);
		if (position === undefined) return unknownBinding("RuntimeConstructed", "the range is not a source token");
		const token = tokenAt(context.source, position, name);
		if (token === undefined) return unknownBinding("RuntimeConstructed", "the name is not a source token");
		const edges = edgeKinds(this.extract(module, context.source).imports);
		return this.use(context, token, edges).binding;
	}

	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) return this.typeOfSymbolId(params.symbolId);

		const context = this.sourceContext(params.module);
		if (isSourceFailure(context)) return unknownType(context.reason, context.detail);
		const position = coordinatesOf(context.source.text).offsetAt(params.range.start);
		if (position === undefined) return unknownType("RuntimeConstructed", "the range is not a source token");
		const token = tokenAt(context.source, position);
		if (token === undefined) return unknownType("RuntimeConstructed", "the range is not a source token");
		const symbol = context.checker.getSymbolAtLocation(token);
		if (symbol === undefined) {
			const failure = this.symbolFailure(context.checker, token);
			return unknownType(failure.reason, failure.detail);
		}
		return this.typeOfSymbol(context.checker, symbol, token);
	}

	diagnostics(module: string): Diagnostic[] {
		const context = this.sourceContext(module);
		if (isSourceFailure(context)) return [diagnosticOf(module, context)];
		const coordinates = coordinatesOf(context.source.text);
		return context.program.getSyntacticDiagnostics(context.source).map((diagnostic) => {
			const range =
				diagnostic.start === undefined || diagnostic.length === undefined
					? undefined
					: coordinates.rangeAt(diagnostic.start, diagnostic.start + diagnostic.length);
			return {
				severity: "error" as const,
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
				...defined({ range }),
				path: module,
			};
		});
	}

	renameEdits(params: RenameEditsRequest): RenameEditsResponse {
		const context = this.sourceContext(params.module);
		if (isSourceFailure(context)) {
			return { status: "refused", reason: "ParseError", detail: context.detail };
		}
		if (context.program.getSyntacticDiagnostics(context.source).length > 0) {
			return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
		}
		return makeRenameEdits(params, context.source, context.checker);
	}

	moveEdits(
		params: MoveEditsRequest,
		renderSpecifier: SpecifierRenderer,
		resolveModule: ModuleResolver,
	): MoveEditsResponse {
		const read = this.moveSource(params);
		if ("refused" in read) return read.refused;
		return makeMoveEdits(params, read.source, read.checker, renderSpecifier, resolveModule, read.esm);
	}

	arrangeEdits(
		params: ArrangeEditsRequest,
		renderSpecifier: SpecifierRenderer,
		resolveModule: ModuleResolver,
	): MoveEditsResponse {
		const read = this.moveSource(params);
		if ("refused" in read) return read.refused;
		return makeArrangeEdits(params, read.source, read.checker, renderSpecifier, resolveModule, read.esm);
	}

	/** Planned against the request's text, in the form the declaring module's program exports the name. */
	importEdits(
		params: ImportEditsRequest,
		renderSpecifier: SpecifierRenderer,
		resolveModule: ModuleResolver,
	): ImportEditsResponse {
		const read = this.moveSource({ module: params.module, text: params.text, exists: true });
		if ("refused" in read)
			return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
		const home = this.sourceContext(params.fromModule);
		if (isSourceFailure(home)) return { status: "refused", reason: "UnknownExport", detail: home.detail };
		const exported = exportedAs(home.checker, home.source, params.name, (symbol) =>
			resolveAlias(home.checker, symbol),
		);
		if ("reason" in exported) return { status: "refused", ...exported };
		return makeImportEdits(params, read.source, read.checker, exported, renderSpecifier, resolveModule, read.esm);
	}

	/** The request's text parsed, with the program's checker when the module exists. */
	private moveSource(params: {
		module: string;
		text: string;
		exists: boolean;
	}): { source: ts.SourceFile; checker: ts.TypeChecker | undefined; esm: boolean } | { refused: MoveEditsResponse } {
		const source = ts.createSourceFile(
			this.fileName(params.module),
			params.text,
			ts.ScriptTarget.ESNext,
			true,
			scriptKindOf(params.module),
		);
		if (parseDiagnosticsOf(source).length > 0) {
			return {
				refused: { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" },
			};
		}

		let checker: ts.TypeChecker | undefined;
		if (params.exists) {
			const context = this.sourceContext(params.module);
			if (!isSourceFailure(context)) checker = context.checker;
		}

		const esm = runsAsEsm(this.fileName(params.module), this.project.loaded);
		return { source, checker, esm };
	}

	programStats(): {
		rootFiles: number;
		workspaceFiles: number;
		firstProgramMs: number | undefined;
		programGenerations: number;
	} {
		const program = this.program();
		return this.programCounters.snapshot(program?.getRootFileNames().length ?? 0);
	}

	/** No program built yet, so the next read pays the whole build. */
	cold(): boolean {
		return this.programCounters.snapshot(0).programGenerations === 0;
	}

	/** Builds the program ahead of any read. */
	warm(): void {
		this.program();
	}

	dispose(): void {
		this.service.dispose();
	}

	private typeOfSymbolId(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE) {
			return unknownType("ParseError", "the symbol id is not a TypeScript workspace id");
		}

		const context = this.sourceContext(parsed.module);
		if (isSourceFailure(context)) return unknownType(context.reason, context.detail);
		const extracted = extractFileWithNodes(parsed.module, context.source, context.checker);
		const matches = [...extracted.declarationNodes.entries()].filter(([, id]) => id === symbolId);
		if (matches.length === 0) return unknownType("NotIndexed", "the symbol id has no declaration");
		if (matches.length > 1) return unknownType("Ambiguous", "the symbol id maps to several declarations");

		const [node] = matches[0] as [ts.Node, string];
		const declaration = asDeclaration(node);
		if (declaration === undefined) return unknownType("NotIndexed", "the symbol id is not a declaration");
		if (ts.isConstructorDeclaration(declaration)) {
			return typeOfConstructor(context.checker, declaration);
		}
		const symbol = symbolAtDeclaration(context.checker, declaration);
		if (symbol === undefined) return typeOfUnnamed(context.checker, declaration);
		return this.typeOfSymbol(context.checker, symbol, declaration);
	}

	private typeOfSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, location: ts.Node): TypeInfo {
		const target = resolveAlias(checker, symbol);
		const declarations = declarationsOf(target);
		const mapped = this.mapDeclarations(declarations);
		if (mapped.length > 0 && mapped.every((item) => item.external)) {
			return unknownType("ExternalDependency", "the declaration is outside the workspace");
		}
		const declaration = mapped.find((item) => !item.external)?.node ?? declarations[0];
		if (declaration === undefined) {
			const failure = this.symbolDeclarationFailure(checker, symbol, location);
			return unknownType(failure.reason, failure.detail);
		}
		if (ts.isConstructorDeclaration(declaration)) {
			return typeOfConstructor(checker, declaration);
		}

		let type: ts.Type;
		let display: string;
		try {
			type = isTypeDeclaration(declaration)
				? checker.getDeclaredTypeOfSymbol(target)
				: checker.getTypeOfSymbolAtLocation(target, location);
			display = checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation);
		} catch {
			return unknownType("RecursionLimit", "the checker could not finish this type");
		}

		if (display === "") return unknownType("RecursionLimit", "the checker produced no display type");
		if (!hasExplicitType(declaration) && (type.flags & ts.TypeFlags.Any) !== 0) {
			return unknownType("DynamicallyTyped", "the inferred type is any");
		}
		const symbolId = this.symbolIdOfType(checker, type, declaration);
		if (hasExplicitType(declaration)) {
			return {
				status: "known",
				display,
				provenance: "declared",
				...defined({ symbolId }),
			};
		}
		return {
			status: "inferred",
			display,
			basis: inferenceBasis(declaration),
			...defined({ symbolId }),
		};
	}

	private symbolIdOfType(checker: ts.TypeChecker, type: ts.Type, declaration: ts.Declaration): string | undefined {
		if (isNamedTypeDeclaration(declaration)) return this.symbolIdOfDeclaration(declaration);
		const annotation = directTypeNodeOf(declaration);
		if (annotation !== undefined) {
			if (!ts.isTypeReferenceNode(annotation)) return undefined;
			return this.symbolIdOfSymbol(checker, checker.getSymbolAtLocation(annotation.typeName));
		}
		return this.symbolIdOfSymbol(checker, type.aliasSymbol ?? type.symbol);
	}

	private symbolIdOfSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | undefined {
		if (symbol === undefined) return undefined;
		const target = resolveAlias(checker, symbol);
		const declarations = declarationsOf(target);
		if (declarations.length !== 1) return undefined;
		const declaration = declarations[0];
		if (declaration === undefined) return undefined;
		const mapped = this.mapDeclarations([declaration])[0];
		if (mapped === undefined) return undefined;
		return mapped.external ? undefined : mapped.id;
	}

	private symbolIdOfDeclaration(declaration: ts.Declaration): string | undefined {
		const mapped = this.mapDeclarations([declaration])[0];
		if (mapped === undefined) return undefined;
		return mapped.external ? undefined : mapped.id;
	}

	/** A use's binding, and the import edge or declaration it resolves through. */
	private use(
		context: SourceContext,
		token: ts.Node,
		edges: ReadonlyMap<string, ImportKind>,
	): { binding: Binding; origin?: ReferenceOrigin | undefined } {
		const symbol = symbolOf(context.checker, token);
		if (symbol === undefined) {
			const failure = this.symbolFailure(context.checker, token);
			return { binding: unknownBinding(failure.reason, failure.detail) };
		}
		const origin = originOf(context.checker, context.source, token, symbol, edges);
		return { binding: this.bindSymbol(context.checker, token, symbol, origin?.kind === "import"), origin };
	}

	/** Through an import, a CommonJS export object's member binds as the local its value names. */
	private bindSymbol(checker: ts.TypeChecker, symbolNode: ts.Node, symbol: ts.Symbol, imported: boolean): Binding {
		const aliased = resolveAlias(checker, symbol);
		const target = imported ? exportedLocal(checker, aliased) : aliased;
		const declarations = declarationsOf(target);
		if (declarations.length === 0) {
			const failure = this.symbolDeclarationFailure(checker, symbol, symbolNode);
			return unknownBinding(failure.reason, failure.detail);
		}
		const mapped = this.mapDeclarations(declarations);
		const ids = mapped.flatMap((item) => (item.id === undefined ? [] : [item.id]));
		// A union's property stands for each constituent's; a merge or an accessor pair is one symbol.
		const synthetic = (target.flags & ts.SymbolFlags.Transient) !== 0;
		const resolved = (synthetic ? [...new Set(ids)] : byMeaning(checker, symbolNode, mapped)).sort();
		const candidates = resolved.length > 0 ? resolved : this.exportAliasIds(checker, symbol);
		if (candidates.length > 1) return { status: "ambiguous", candidates, provenance: "bound" };
		if (candidates.length === 1) return { status: "bound", symbolId: candidates[0] as string, provenance: "bound" };
		if (mapped.some((item) => item.external)) {
			return unknownBinding("ExternalDependency", "the declaration is outside the workspace");
		}
		if (mapped.some((item) => item.withheld)) {
			return unknownBinding("NotIndexed", "the declaring module is not in the symbol index");
		}
		return unknownBinding("NotIndexed", "the declaration is not in the symbol index");
	}

	/**
	 * The ids of the export specifiers an alias passes through. A surface admits `export { Local as
	 * Alias }` as Alias, while the checker resolves through it to Local, which the surface omits.
	 */
	private exportAliasIds(checker: ts.TypeChecker, symbol: ts.Symbol): string[] {
		const specifiers: ts.Declaration[] = [];
		const seen = new Set<ts.Symbol>();
		let current: ts.Symbol | undefined = symbol;
		while (current !== undefined && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
			seen.add(current);
			specifiers.push(...declarationsOf(current).filter((declaration) => ts.isExportSpecifier(declaration)));
			current = checker.getImmediateAliasedSymbol(current);
		}
		const ids = this.mapDeclarations(specifiers).flatMap((item) => (item.id === undefined ? [] : [item.id]));
		return firstOfOnePath(ids).sort();
	}

	private symbolFailure(checker: ts.TypeChecker, node: ts.Node): SourceFailure {
		if (isCommonJsTarget(node, checker)) {
			return sourceFailure("NotIndexed", "the CommonJS export object has no workspace declaration");
		}
		if (this.isExternalProperty(checker, node)) {
			return sourceFailure("ExternalDependency", "the property belongs to an external dependency");
		}
		if (this.isNotIndexedProperty(checker, node)) {
			return sourceFailure("NotIndexed", "the imported declaration is not in the symbol index");
		}

		const parent = node.parent;
		if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
			const type = checker.getTypeAtLocation(parent.expression);
			if ((type.flags & ts.TypeFlags.Any) !== 0) {
				return sourceFailure("DynamicallyTyped", "the property receiver has type any");
			}
			if ((type.flags & ts.TypeFlags.Unknown) !== 0) {
				return sourceFailure("DynamicallyTyped", "the property receiver has type unknown");
			}
		}
		const type = checker.getTypeAtLocation(node);
		if ((type.flags & ts.TypeFlags.Any) !== 0) {
			return sourceFailure("DynamicallyTyped", "the checker could not determine the symbol type");
		}
		if ((type.flags & ts.TypeFlags.Unknown) !== 0) {
			return sourceFailure("DynamicallyTyped", "the checker could not determine the symbol type");
		}

		return sourceFailure("RuntimeConstructed", "the checker found no symbol");
	}

	private symbolDeclarationFailure(checker: ts.TypeChecker, symbol: ts.Symbol, node: ts.Node): SourceFailure {
		if (this.isExternalSymbol(checker, symbol)) {
			return sourceFailure("ExternalDependency", "the declaration is outside the workspace");
		}
		if (this.isNotIndexedSymbol(checker, symbol)) {
			return sourceFailure("NotIndexed", "the imported declaration is not in the symbol index");
		}
		const broken = brokenImportOf(checker, symbol);
		if (broken !== undefined) return sourceFailure("BrokenImport", broken);
		if (ts.isMetaProperty(node.parent)) {
			return sourceFailure("RuntimeConstructed", "import.meta is runtime metadata");
		}
		const type = checker.getTypeAtLocation(node);
		if ((type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Unknown) !== 0) {
			return sourceFailure("DynamicallyTyped", "the checker could not determine the symbol type");
		}
		if ((type.flags & ts.TypeFlags.Undefined) !== 0) {
			return sourceFailure("NotIndexed", "the built-in value has no workspace declaration");
		}
		return sourceFailure("RuntimeConstructed", "the checker symbol has no declaration");
	}

	private isExternalProperty(checker: ts.TypeChecker, node: ts.Node): boolean {
		const parent = node.parent;
		if (!ts.isPropertyAccessExpression(parent) || parent.name !== node) return false;
		const receiver = checker.getSymbolAtLocation(parent.expression);
		return receiver !== undefined && this.isExternalSymbol(checker, receiver);
	}

	private isNotIndexedProperty(checker: ts.TypeChecker, node: ts.Node): boolean {
		const parent = node.parent;
		if (!ts.isPropertyAccessExpression(parent) || parent.name !== node) return false;
		const receiver = checker.getSymbolAtLocation(parent.expression);
		return receiver !== undefined && this.isNotIndexedSymbol(checker, receiver);
	}

	private isExternalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
		const target = resolveAlias(checker, symbol);
		if (declarationsOf(target).some((node) => this.isExternal(node.getSourceFile().fileName))) return true;
		return declarationsOf(symbol).some((node) => externalImportOf(node));
	}

	private isNotIndexedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
		const target = resolveAlias(checker, symbol);
		return (
			declarationsOf(target).length === 0 && declarationsOf(symbol).some((node) => unclaimedLocalImportOf(node))
		);
	}

	private sourceContext(module: string): SourceContextResult {
		const fileName = this.fileName(module);
		if (this.isExternal(fileName)) {
			return sourceFailure("ExternalDependency", "the module is outside the indexed workspace");
		}
		if (!claimsExtension(module)) {
			return sourceFailure(
				"NotImplemented",
				`the provider does not claim extension ${path.extname(module) || "(none)"}`,
			);
		}
		if (this.hostText(fileName) === undefined) return sourceFailure("ParseError", "the file does not exist");

		const program = this.program();
		if (program === undefined) return sourceFailure("ParseError", "the Program could not be created");
		const source = program.getSourceFile(fileName);
		if (source !== undefined) return { source, checker: program.getTypeChecker(), program };

		const fallback = this.fallbackProgram(fileName);
		if (fallback === undefined) return sourceFailure("ParseError", "the file could not be loaded into the Program");
		const fallbackSource = fallback.getSourceFile(fileName);
		if (fallbackSource === undefined)
			return sourceFailure("ParseError", "the file could not be loaded into the Program");
		return { source: fallbackSource, checker: fallback.getTypeChecker(), program: fallback };
	}

	private fallbackProgram(fileName: string): ts.Program | undefined {
		const options: ts.CompilerOptions = { ...this.project.loaded.options, allowJs: true, noResolve: true };
		const host = ts.createCompilerHost(options, true);
		const { system } = this.project.loaded;
		host.readFile = (name) => this.hostText(name);
		host.fileExists = (name) => this.hostText(name) !== undefined || system.fileExists(name);
		// No default read: it would bypass the policy.
		host.getSourceFile = (name, languageVersion) => {
			const text = this.hostText(name);
			return text === undefined
				? undefined
				: ts.createSourceFile(name, text, languageVersion, true, scriptKindOf(name));
		};
		return ts.createProgram([fileName], options, host);
	}

	private program(): ts.Program | undefined {
		this.store.get("root");
		const started = Date.now();
		const program = this.service.getProgram();
		this.programCounters.observe(
			program,
			Date.now() - started,
			() =>
				program
					?.getSourceFiles()
					.filter((source) => this.toModule(source.fileName) !== null && !this.isExternal(source.fileName))
					.length ?? 0,
		);
		return program;
	}

	private mapDeclarations(nodes: readonly ts.Declaration[]): MappedDeclaration[] {
		const idsByFile = new Map<string, Map<string, string[]>>();
		return nodes.map((node) => {
			const source = node.getSourceFile();
			if (this.isExternal(source.fileName)) return { id: undefined, external: true, withheld: false, node };
			const module = this.toModule(source.fileName);
			if (module === null) return { id: undefined, external: true, withheld: false, node };
			const held = this.held(module);
			if (held === undefined) return { id: undefined, external: false, withheld: true, node };
			let ids = idsByFile.get(source.fileName);
			if (ids === undefined) {
				ids = new Map<string, string[]>();
				const declarations = held.surface
					? this.surfaceDeclarations(module, source)
					: this.extract(module, source).declarations;
				for (const declaration of declarations) {
					// Extracted names occur in source.
					const key = positionKey(declaration.selectionRange ?? declaration.range);
					const same = ids.get(key);
					if (same === undefined) ids.set(key, [declaration.symbolId]);
					else same.push(declaration.symbolId);
				}
				idsByFile.set(source.fileName, ids);
			}
			const matches = ids.get(selectionKeyOf(node, source));
			return { id: matches?.length === 1 ? matches[0] : undefined, external: false, withheld: false, node };
		});
	}

	/** A surface module binds only to the ids its surface facts admit, settled as the wire settles them. */
	private surfaceDeclarations(module: string, source: ts.SourceFile): Declaration[] {
		const version = this.scriptVersion(source.fileName);
		return this.memo(`surface:${module}:${version}`, () => {
			const facts = extractSurfaceFile(module, source.text);
			return withOccurrences({ module, contentHash: version, ...facts }).declarations;
		});
	}

	/** The store's memo, or the overlay's own, so a probe's reads never outlive it. */
	private memo<R>(key: string, compute: () => R): R {
		if (this.overlay === undefined) return this.store.memo(key, compute);
		const { memos } = this.overlay;
		if (!memos.has(key)) memos.set(key, compute());
		return memos.get(key) as R;
	}

	private fileName(module: string): string {
		return path.resolve(this.project.root, module.replace(/\\/g, "/"));
	}

	/** Proposed modules this provider reads in full, which root the overlay's program as parses do. */
	private overlaidRoots(): string[] {
		return [...(this.overlay?.files ?? [])]
			.filter(([module, { text }]) => claimsExtension(module) && !isSurfaceText(module, text))
			.map(([module]) => this.fileName(module));
	}

	private hostText(fileName: string): string | undefined {
		const module = this.toModule(fileName);
		const { system } = this.project.loaded;
		const proposed = module === null ? undefined : this.overlay?.files.get(module);
		if (proposed !== undefined) return proposed.text;
		if (module === null || this.isExternal(fileName) || !claimsExtension(module)) return system.readFile(fileName);
		return this.store.text(module)?.text ?? system.readFile(fileName);
	}

	private scriptVersion(fileName: string): string {
		const module = this.toModule(fileName);
		const proposed = module === null ? undefined : this.overlay?.files.get(module);
		if (proposed !== undefined) return proposed.contentHash;
		if (module === null || this.isExternal(fileName) || !claimsExtension(module)) return "0";
		const held = this.store.text(module);
		if (held !== undefined) return held.contentHash;
		// Disk timestamps version type reads.
		const modified = ts.sys.getModifiedTime?.(fileName)?.getTime() ?? 0;
		return `${this.store.withheld(module) ? "withheld" : "absent"}:${modified}`;
	}

	private toModule(fileName: string): string | null {
		return toModule(this.project.root, fileName);
	}

	private isExternal(fileName: string): boolean {
		const absolute = path.resolve(fileName);
		const relative = path.relative(this.project.root, absolute);
		return (
			relative.startsWith(`..${path.sep}`) ||
			relative === ".." ||
			path.isAbsolute(relative) ||
			relative.split(path.sep).includes("node_modules")
		);
	}
}

////////////////////////////////
//  Functions & Helpers

/** Read as a surface, as the store reads a module from its text. */
function isSurfaceText(module: string, text: string): boolean {
	return module.split("/").includes("node_modules") || isLikelyBundle(module, text);
}

/**
 * The symbol a use names: none for the CommonJS export object, a local `module` or `exports` by
 * scope, a module member's own property, an object literal key's contextual property, a shorthand's
 * value, else the checker's.
 */
function symbolOf(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
	if (isCommonJsTarget(node, checker)) return undefined;
	if (isModuleName(node)) return checker.resolveName(node.text, node, ts.SymbolFlags.Value, false);
	const element = isModuleMemberShorthand(node, checker) ? destructuredElement(node) : undefined;
	if (element !== undefined) {
		return checker.getPropertyOfType(checker.getTypeAtLocation(element.parent), (node as ts.Identifier).text);
	}
	const contextual =
		ts.isPropertyAssignment(node.parent) && node.parent.name === node
			? contextualPropertySymbol(checker, node.parent)
			: undefined;
	const shorthand = ts.isShorthandPropertyAssignment(node.parent)
		? checker.getShorthandAssignmentValueSymbol(node.parent)
		: undefined;
	return contextual ?? shorthand ?? checker.getSymbolAtLocation(node);
}

/** The edge an alias declaration writes in this file, when one does, with its kind. */
function edgeOf(
	symbol: ts.Symbol,
	source: ts.SourceFile,
	edges: ReadonlyMap<string, ImportKind>,
): { span: Range; kind: ImportKind } | undefined {
	for (const declaration of declarationsOf(symbol)) {
		const span = aliasEdgeSpan(declaration, source);
		const kind = span === undefined ? undefined : edges.get(positionKey(span));
		if (span !== undefined && kind !== undefined) return { span, kind };
	}
	return undefined;
}

/** `ns.a.N` or `const { a: { N } } = ns` through a namespace or require edge: that edge, and the names after `ns`. */
function receiverRoute(
	checker: ts.TypeChecker,
	source: ts.SourceFile,
	token: ts.Node,
	edges: ReadonlyMap<string, ImportKind>,
): ReferenceOrigin | undefined {
	const route = memberRoute(token);
	if (route === undefined) return undefined;
	const symbol = checker.getSymbolAtLocation(route.root);
	if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return undefined;
	const edge = edgeOf(symbol, source, edges);
	if (edge === undefined || (edge.kind !== "namespace" && edge.kind !== "require")) return undefined;
	return { kind: "import", span: edge.span, path: route.path };
}

/** Each import edge's kind, by where it is written. */
function edgeKinds(imports: readonly Import[]): Map<string, ImportKind> {
	const edges = new Map<string, ImportKind>();
	for (const statement of imports) {
		for (const edge of statement.edges) edges.set(positionKey(edge.span), edge.kind);
	}
	return edges;
}

/** A CommonJS export object's member as the local its value names, as the member's export row does. */
function exportedLocal(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
	const [declaration, ...rest] = declarationsOf(symbol);
	const value = declaration === undefined || rest.length > 0 ? undefined : commonJsMemberValue(declaration);
	const local = value === undefined ? undefined : checker.getSymbolAtLocation(value);
	return local === undefined ? symbol : resolveAlias(checker, local);
}

/** One symbol's ids; where a value and a type share a name, those the use's position reads. */
function byMeaning(checker: ts.TypeChecker, node: ts.Node, mapped: readonly MappedDeclaration[]): string[] {
	const idsOf = (items: readonly MappedDeclaration[]) =>
		firstOfOnePath(items.flatMap((item) => (item.id === undefined ? [] : [item.id])));
	const all = idsOf(mapped);
	const meaning = all.length > 1 ? meaningAt(node) : undefined;
	if (meaning === undefined) return all;
	const read = idsOf(mapped.filter((item) => meaningOf(item.node, checker)?.includes(meaning) !== false));
	return read.length > 0 ? read : all;
}

/**
 * The binding a use resolves through, read from the checker's alias before it resolves to a
 * target. A use through an import names that edge; a use of anything else names its declaration.
 */
function originOf(
	checker: ts.TypeChecker,
	source: ts.SourceFile,
	token: ts.Node,
	symbol: ts.Symbol,
	edges: ReadonlyMap<string, ImportKind>,
): ReferenceOrigin | undefined {
	const route = receiverRoute(checker, source, token, edges);
	if (route !== undefined) return route;
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return declarationsOf(symbol).length > 0 ? { kind: "declaration" } : undefined;
	}
	const edge = edgeOf(symbol, source, edges);
	return edge === undefined ? undefined : { kind: "import", span: edge.span };
}

function tokenAt(source: ts.SourceFile, position: number, name?: string): ts.Node | undefined {
	if (source.end === 0) return undefined;
	const wanted = name;
	let found: ts.Node | undefined;
	function walk(node: ts.Node): void {
		const start = node.getStart(source);
		if (position < start || position >= node.getEnd()) return;
		if (
			(wanted === undefined && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node))) ||
			(wanted !== undefined && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === wanted)
		) {
			found = node;
		}
		ts.forEachChild(node, walk);
	}
	walk(source);
	return found;
}

function parseDiagnosticsOf(source: ts.SourceFile): readonly ts.Diagnostic[] {
	return (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

function declarationsOf(symbol: ts.Symbol): ts.Declaration[] {
	if (symbol.declarations !== undefined) return [...symbol.declarations];
	return symbol.valueDeclaration === undefined ? [] : [symbol.valueDeclaration];
}

function externalImportOf(node: ts.Node): boolean {
	const specifier = importSpecifierOf(node);
	return specifier !== undefined && isExternalModuleSpecifier(specifier);
}

function unclaimedLocalImportOf(node: ts.Node): boolean {
	const specifier = importSpecifierOf(node);
	return specifier?.startsWith(".") === true && path.extname(specifier) !== "" && !claimsExtension(specifier);
}

/** Why a local import binds nothing, when it does. */
function brokenImportOf(checker: ts.TypeChecker, symbol: ts.Symbol): string | undefined {
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return undefined;
	if (!checker.isUnknownSymbol(checker.getAliasedSymbol(symbol))) return undefined;
	for (const declaration of declarationsOf(symbol)) {
		const specifier = moduleSpecifierOf(declaration);
		if (specifier === undefined || isExternalModuleSpecifier(specifier.text)) continue;
		return checker.getSymbolAtLocation(specifier) === undefined
			? "the imported module is missing or is not a module"
			: "the imported module does not export it";
	}
	return undefined;
}

function importSpecifierOf(node: ts.Node): string | undefined {
	return moduleSpecifierOf(node)?.text;
}

function moduleSpecifierOf(node: ts.Node): ts.StringLiteral | undefined {
	let current: ts.Node | undefined = node;
	while (current !== undefined) {
		if (ts.isImportDeclaration(current)) {
			return ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier : undefined;
		}
		if (ts.isImportEqualsDeclaration(current)) {
			const reference = current.moduleReference;
			return ts.isExternalModuleReference(reference) &&
				reference.expression !== undefined &&
				ts.isStringLiteral(reference.expression)
				? reference.expression
				: undefined;
		}
		current = current.parent;
	}
	return undefined;
}

function isExternalModuleSpecifier(specifier: string): boolean {
	return !specifier.startsWith(".") && !path.isAbsolute(specifier);
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
	const seen = new Set<ts.Symbol>();
	let current = symbol;
	while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
		seen.add(current);
		current = checker.getAliasedSymbol(current);
	}
	return current;
}

function asDeclaration(node: ts.Node): ts.Declaration | undefined {
	return node as ts.Declaration;
}

/** An accessor pair or a merge is one symbol declared on one name path; its first occurrence names it. */
function firstOfOnePath(ids: readonly string[]): string[] {
	const unique = [...new Set(ids)];
	const ranked = unique.map((id) => {
		const parsed = parseSymbolId(id);
		const last = parsed?.descriptors.at(-1);
		if (parsed === null || parsed === undefined || last === undefined) return { id, path: id, occurrence: 1 };
		const bare: Descriptor = {
			kind: last.kind,
			name: last.name,
			...defined({ disambiguator: last.disambiguator }),
		};
		const path = composeSymbolId({ ...parsed, descriptors: [...parsed.descriptors.slice(0, -1), bare] });
		return { id, path, occurrence: last.occurrence ?? 1 };
	});
	if (new Set(ranked.map((entry) => entry.path)).size !== 1) return unique;
	return [ranked.reduce((best, entry) => (entry.occurrence < best.occurrence ? entry : best)).id];
}

function positionKey(range: { start: Position; end: Position }): string {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function selectionKeyOf(node: ts.Declaration, source: ts.SourceFile): string {
	const selection = selectionNodeOf(node, source);
	return positionKey({
		start: source.getLineAndCharacterOfPosition(selection.getStart(source)),
		end: source.getLineAndCharacterOfPosition(selection.getEnd()),
	});
}

function selectionNodeOf(node: ts.Declaration, source: ts.SourceFile): ts.Node {
	const name = (node as { name?: ts.Node }).name;
	if (name !== undefined && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))) {
		return name;
	}
	if (ts.isConstructorDeclaration(node)) {
		return node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.ConstructorKeyword) ?? node;
	}
	const modifier = ts.canHaveModifiers(node)
		? (ts.getModifiers(node) ?? []).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword)
		: undefined;
	return modifier ?? node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword) ?? node;
}

function symbolAtDeclaration(checker: ts.TypeChecker, declaration: ts.Declaration): ts.Symbol | undefined {
	const name = (declaration as { name?: ts.Node }).name;
	return checker.getSymbolAtLocation(name ?? declaration);
}

/** An anonymous default class or function types from its node; a static block has no type. */
function typeOfUnnamed(checker: ts.TypeChecker, declaration: ts.Declaration): TypeInfo {
	if (!ts.isClassLike(declaration) && !ts.isFunctionLike(declaration)) {
		return unknownType("DynamicallyTyped", "the declaration has no type");
	}
	const display = checker.typeToString(
		checker.getTypeAtLocation(declaration),
		declaration,
		ts.TypeFormatFlags.NoTruncation,
	);
	if (display === "") return unknownType("RecursionLimit", "the checker produced no display type");
	return { status: "known", display, provenance: "declared" };
}

function typeOfConstructor(checker: ts.TypeChecker, declaration: ts.ConstructorDeclaration): TypeInfo {
	const parent = declaration.parent;
	if (!ts.isClassLike(parent) || parent.name === undefined) {
		return unknownType("NotIndexed", "the constructor has no checker signature");
	}
	const symbol = checker.getSymbolAtLocation(parent.name);
	if (symbol === undefined) return unknownType("NotIndexed", "the constructor has no checker signature");
	const type = checker.getTypeOfSymbolAtLocation(symbol, parent.name);
	const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
	if (signatures.length > 1) return unknownType("Ambiguous", "the class has several constructor signatures");
	if (signatures.length === 0) return unknownType("NotIndexed", "the constructor has no checker signature");
	return {
		status: "known",
		display: checker.signatureToString(signatures[0] as ts.Signature),
		provenance: "declared",
	};
}

function isTypeDeclaration(node: ts.Declaration): boolean {
	return ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
}

function isNamedTypeDeclaration(node: ts.Declaration): boolean {
	return isTypeDeclaration(node) || ts.isEnumDeclaration(node);
}

function directTypeNodeOf(node: ts.Declaration): ts.TypeNode | undefined {
	if (ts.isVariableDeclaration(node) || ts.isParameter(node)) return node.type;
	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return node.type;
	return undefined;
}

function hasExplicitType(node: ts.Declaration): boolean {
	if (ts.isVariableDeclaration(node) || ts.isParameter(node)) return node.type !== undefined;
	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return node.type !== undefined;
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isMethodSignature(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node)
	) {
		return node.type !== undefined;
	}
	return isTypeDeclaration(node) || ts.isEnumDeclaration(node);
}

function inferenceBasis(node: ts.Declaration): string {
	if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
		return node.initializer === undefined ? "declaration" : "initializer";
	}
	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
		return hasReturnStatement(node) ? "return statements" : "function body";
	}
	return "declaration";
}

function hasReturnStatement(node: ts.Node): boolean {
	let found = false;
	function walk(current: ts.Node): void {
		if (found || (current !== node && ts.isFunctionLike(current))) return;
		if (ts.isReturnStatement(current)) {
			found = true;
			return;
		}
		ts.forEachChild(current, walk);
	}
	walk(node);
	return found;
}

function unknownBinding(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function unknownType(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

function isSourceFailure(context: SourceContextResult): context is SourceFailure {
	return "reason" in context;
}

function sourceFailure(reason: UnknownReason, detail: string): SourceFailure {
	return { reason, detail };
}

function diagnosticOf(module: string, failure: SourceFailure): Diagnostic {
	return { severity: "error", message: `${failure.reason}: ${failure.detail}`, path: module };
}
