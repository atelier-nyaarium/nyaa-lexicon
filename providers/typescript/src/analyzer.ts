import path from "node:path";
import {
	type Binding,
	coordinatesOf,
	type Diagnostic,
	defined,
	type MoveEditsRequest,
	type MoveEditsResponse,
	parseSymbolId,
	type RenameEditsRequest,
	type RenameEditsResponse,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { contextualPropertySymbol, type Extracted, extractFile, extractFileWithNodes, LANGUAGE } from "./extract.js";
import { claimsExtension, scriptKindOf } from "./file-types.js";
import type { TypeScriptProject, TypeScriptStore } from "./module.js";
import { makeMoveEdits } from "./move.js";
import type { SpecifierRenderer } from "./project.js";
import { toModule } from "./project.js";
import { makeRenameEdits } from "./rename.js";

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

////////////////////////////////
//  Class

export class TypeScriptAnalyzer {
	private readonly service: ts.LanguageService;
	private readonly programCounters = new ProgramGenerationStats();

	/** Store text gates symbols; disk serves type reads. */
	constructor(
		private readonly store: TypeScriptStore,
		private readonly project: TypeScriptProject,
	) {
		const root = project.root;
		const compiler = project.loaded;

		const host: ts.LanguageServiceHost = {
			getCompilationSettings: () => compiler.options,
			getCurrentDirectory: () => root,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			getProjectVersion: () => String(store.generation),
			getScriptFileNames: () => [...project.roots, ...store.get("root").map((module) => this.fileName(module))],
			getScriptKind: (fileName) => scriptKindOf(fileName),
			getScriptSnapshot: (fileName) => {
				const text = this.hostText(fileName);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
			getScriptVersion: (fileName) => this.scriptVersion(fileName),
			fileExists: (fileName) => this.hostText(fileName) !== undefined || ts.sys.fileExists(fileName),
			readFile: (fileName) => this.hostText(fileName) ?? ts.sys.readFile(fileName),
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
			useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
		};
		host.resolveModuleNames = (names, containingFile) =>
			names.map((name) => ts.resolveModuleName(name, containingFile, compiler.options, host).resolvedModule);
		this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
	}

	sourceFile(module: string): ts.SourceFile | undefined {
		const context = this.sourceContext(module);
		return isSourceFailure(context) ? undefined : context.source;
	}

	extract(module: string, source: ts.SourceFile, contentHash?: string): Extracted {
		const key = `extract:${module}:${contentHash ?? hashText(source.text)}`;
		const context = this.sourceContext(module);
		const activeSource = isSourceFailure(context) ? source : context.source;
		return this.store.memo(key, () =>
			extractFile(module, activeSource, isSourceFailure(context) ? undefined : context.checker),
		);
	}

	bind(module: string, name: string, range: Range): Binding {
		const context = this.sourceContext(module);
		if (isSourceFailure(context)) return unknownBinding(context.reason, context.detail);
		const position = coordinatesOf(context.source.text).offsetAt(range.start);
		if (position === undefined) return unknownBinding("RuntimeConstructed", "the range is not a source token");
		const token = tokenAt(context.source, position, name);
		if (token === undefined) return unknownBinding("RuntimeConstructed", "the name is not a source token");
		return this.bindSymbol(context.checker, token);
	}

	bindReference(module: string, name: string, range: Range): Binding {
		return this.bind(module, name, range);
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

	moveEdits(params: MoveEditsRequest, renderSpecifier: SpecifierRenderer): MoveEditsResponse {
		const source = ts.createSourceFile(
			this.fileName(params.module),
			params.text,
			ts.ScriptTarget.ESNext,
			true,
			scriptKindOf(params.module),
		);
		if (parseDiagnosticsOf(source).length > 0) {
			return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
		}

		let checker: ts.TypeChecker | undefined;
		if (params.exists) {
			const context = this.sourceContext(params.module);
			if (!isSourceFailure(context)) checker = context.checker;
		}

		return makeMoveEdits(params, source, checker, renderSpecifier);
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
		if (matches.length === 0) return unknownType("ParseError", "the symbol id has no declaration");
		if (matches.length > 1) return unknownType("Ambiguous", "the symbol id maps to several declarations");

		const [node] = matches[0] as [ts.Node, string];
		const declaration = asDeclaration(node);
		if (declaration === undefined) return unknownType("ParseError", "the symbol id is not a declaration");
		if (ts.isConstructorDeclaration(declaration)) {
			return typeOfConstructor(context.checker, declaration);
		}
		const symbol = symbolAtDeclaration(context.checker, declaration);
		if (symbol === undefined) return unknownType("ParseError", "the checker found no declaration symbol");
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

	private bindSymbol(checker: ts.TypeChecker, symbolNode: ts.Node): Binding {
		const contextual =
			ts.isPropertyAssignment(symbolNode.parent) && symbolNode.parent.name === symbolNode
				? contextualPropertySymbol(checker, symbolNode.parent)
				: undefined;
		const shorthand = ts.isShorthandPropertyAssignment(symbolNode.parent)
			? checker.getShorthandAssignmentValueSymbol(symbolNode.parent)
			: undefined;
		const symbol = contextual ?? shorthand ?? checker.getSymbolAtLocation(symbolNode);
		if (symbol === undefined) {
			const failure = this.symbolFailure(checker, symbolNode);
			return unknownBinding(failure.reason, failure.detail);
		}

		const target = resolveAlias(checker, symbol);
		const declarations = declarationsOf(target);
		if (declarations.length === 0) {
			const failure = this.symbolDeclarationFailure(checker, symbol, symbolNode);
			return unknownBinding(failure.reason, failure.detail);
		}
		const mapped = this.mapDeclarations(declarations);
		const candidates = mapped.flatMap((item) => (item.id === undefined ? [] : [item.id])).sort();
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

	private symbolFailure(checker: ts.TypeChecker, node: ts.Node): SourceFailure {
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
		const defaultGetSourceFile = host.getSourceFile.bind(host);
		host.readFile = (name) => this.hostText(name) ?? ts.sys.readFile(name);
		host.fileExists = (name) => this.hostText(name) !== undefined || ts.sys.fileExists(name);
		host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
			const text = this.hostText(name) ?? ts.sys.readFile(name);
			if (text !== undefined) {
				return ts.createSourceFile(name, text, languageVersion, true, scriptKindOf(name));
			}
			return defaultGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
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
			if (this.store.peek(module) === undefined) return { id: undefined, external: false, withheld: true, node };
			let ids = idsByFile.get(source.fileName);
			if (ids === undefined) {
				ids = new Map<string, string[]>();
				for (const declaration of this.extract(module, source).declarations) {
					// Extracted names occur in source.
					const key = positionKey(declaration.selectionRange ?? declaration.range);
					ids.set(key, [...(ids.get(key) ?? []), declaration.symbolId]);
				}
				idsByFile.set(source.fileName, ids);
			}
			const matches = ids.get(selectionKeyOf(node, source));
			return { id: matches?.length === 1 ? matches[0] : undefined, external: false, withheld: false, node };
		});
	}

	private fileName(module: string): string {
		return path.resolve(this.project.root, module.replace(/\\/g, "/"));
	}

	private hostText(fileName: string): string | undefined {
		const module = this.toModule(fileName);
		if (module === null || this.isExternal(fileName) || !claimsExtension(module)) return ts.sys.readFile(fileName);
		return this.store.text(module)?.text ?? ts.sys.readFile(fileName);
	}

	private scriptVersion(fileName: string): string {
		const module = this.toModule(fileName);
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

function importSpecifierOf(node: ts.Node): string | undefined {
	let current: ts.Node | undefined = node;
	while (current !== undefined) {
		if (ts.isImportDeclaration(current)) {
			return ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : undefined;
		}
		if (ts.isImportEqualsDeclaration(current)) {
			const reference = current.moduleReference;
			return ts.isExternalModuleReference(reference) &&
				reference.expression !== undefined &&
				ts.isStringLiteral(reference.expression)
				? reference.expression.text
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

function positionKey(range: { start: Position; end: Position }): string {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function hashText(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return String(hash >>> 0);
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
