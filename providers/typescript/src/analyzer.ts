import path from "node:path";
import {
	type Binding,
	type Diagnostic,
	parseSymbolId,
	type RenameEditsRequest,
	type RenameEditsResponse,
	type TypeInfo,
	type UnknownReason,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { contextualPropertySymbol, type ExtractedWithNodes, extractFileWithNodes, LANGUAGE } from "./extract.js";
import { claimsExtension, scriptKindOf } from "./file-types.js";
import { type LoadedProject, toModule } from "./project.js";
import { makeRenameEdits } from "./rename.js";

////////////////////////////////
//  Interfaces & Types

interface Overlay {
	text: string;
	version: number;
}

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

interface MappedDeclaration {
	id: string | undefined;
	external: boolean;
	node: ts.Declaration;
}

interface FallbackProgram {
	key: string;
	version: number;
	program: ts.Program;
}

////////////////////////////////
//  Class

export class TypeScriptAnalyzer {
	private readonly root: string;
	private readonly projectOptions: ts.CompilerOptions;
	private readonly scripts = new Set<string>();
	private readonly overlays = new Map<string, Overlay>();
	private readonly extracted = new Map<string, { version: number; value: ExtractedWithNodes }>();
	private extractedProgram: ts.Program | undefined;
	private cachedFallbackProgram: FallbackProgram | undefined;
	private readonly service: ts.LanguageService;
	private projectVersion = 0;
	private observedProgram: ts.Program | undefined;
	private programGenerations = 0;
	private firstProgramReadyAt: number | undefined;
	private firstProgramWorkspaceFiles = 0;

	constructor(root: string, project: LoadedProject) {
		this.root = path.resolve(root);
		this.projectOptions = project.options;
		for (const file of project.files) this.scripts.add(path.resolve(file));

		const host: ts.LanguageServiceHost = {
			getCompilationSettings: () => project.options,
			getCurrentDirectory: () => this.root,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			getProjectVersion: () => String(this.projectVersion),
			getScriptFileNames: () => [...this.scripts],
			getScriptKind: (fileName) => scriptKindOf(fileName),
			getScriptSnapshot: (fileName) => {
				const text = this.readFile(fileName);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
			getScriptVersion: (fileName) => String(this.overlays.get(this.key(fileName))?.version ?? 0),
			fileExists: (fileName) => this.readFile(fileName) !== undefined,
			readFile: (fileName) => this.readFile(fileName),
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
			useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
		};
		host.resolveModuleNames = (names, containingFile) =>
			names.map((name) => ts.resolveModuleName(name, containingFile, project.options, host).resolvedModule);
		this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
	}

	updateFile(module: string, text: string): ts.SourceFile | undefined {
		const fileName = this.fileName(module);
		const key = this.key(fileName);
		const previous = this.overlays.get(key);
		if (previous === undefined) {
			const diskText = ts.sys.readFile(fileName);
			this.overlays.set(key, { text, version: diskText === text ? 0 : 1 });
			if (diskText !== text) this.invalidateProgram();
		} else if (previous.text !== text) {
			this.overlays.set(key, { text, version: previous.version + 1 });
			this.invalidateProgram();
		}
		const context = this.sourceContext(module);
		return isSourceFailure(context) ? undefined : context.source;
	}

	extract(module: string, source: ts.SourceFile): ExtractedWithNodes {
		const key = this.key(source.fileName);
		const version = this.overlays.get(key)?.version ?? 0;
		const context = this.sourceContext(module);
		const program = isSourceFailure(context) ? undefined : context.program;
		this.syncExtractionProgram(program);
		const cached = this.extracted.get(key);
		if (cached?.version === version) return cached.value;

		const value = extractFileWithNodes(module, source, isSourceFailure(context) ? undefined : context.checker);
		this.extracted.set(key, { version, value });
		return value;
	}

	bind(module: string, name: string, range: Range): Binding {
		const context = this.sourceContext(module);
		if (isSourceFailure(context)) return unknownBinding(context.reason, context.detail);
		const position = positionOf(context.source, range.start);
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
		const token = tokenAt(context.source, positionOf(context.source, params.range.start));
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
		return context.program.getSyntacticDiagnostics(context.source).map((diagnostic) => ({
			severity: "error" as const,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
			...(diagnostic.start === undefined || diagnostic.length === undefined
				? {}
				: { range: rangeOfSpan(context.source, diagnostic.start, diagnostic.length) }),
			path: module,
		}));
	}

	renameEdits(params: RenameEditsRequest): RenameEditsResponse {
		const source = this.updateFile(params.module, params.text);
		if (source === undefined) {
			return { status: "refused", reason: "ParseError", detail: "the module could not be loaded" };
		}
		const context = this.sourceContext(params.module);
		if (isSourceFailure(context)) {
			return { status: "refused", reason: "ParseError", detail: context.detail };
		}
		if (context.program.getSyntacticDiagnostics(context.source).length > 0) {
			return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
		}
		return makeRenameEdits(params, context.source, context.checker);
	}

	programStats(): {
		rootFiles: number;
		workspaceFiles: number;
		firstProgramMs: number | undefined;
		programGenerations: number;
	} {
		const program = this.program();
		return {
			rootFiles: program?.getRootFileNames().length ?? 0,
			workspaceFiles: this.firstProgramWorkspaceFiles,
			firstProgramMs: this.firstProgramReadyAt,
			programGenerations: this.programGenerations,
		};
	}

	dispose(): void {
		this.service.dispose();
		this.extracted.clear();
		this.overlays.clear();
		this.extractedProgram = undefined;
		this.cachedFallbackProgram = undefined;
		this.observedProgram = undefined;
	}

	private typeOfSymbolId(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE) {
			return unknownType("ParseError", "the symbol id is not a TypeScript workspace id");
		}

		const context = this.sourceContext(parsed.module);
		if (isSourceFailure(context)) return unknownType(context.reason, context.detail);
		const extracted = this.extract(parsed.module, context.source);
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
		const mapped = declarations.map((node) => this.mapDeclaration(node));
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
				...(symbolId === undefined ? {} : { symbolId }),
			};
		}
		return {
			status: "inferred",
			display,
			basis: inferenceBasis(declaration),
			...(symbolId === undefined ? {} : { symbolId }),
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
		const mapped = this.mapDeclaration(declaration);
		return mapped.external ? undefined : mapped.id;
	}

	private symbolIdOfDeclaration(declaration: ts.Declaration): string | undefined {
		const mapped = this.mapDeclaration(declaration);
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
		const mapped = declarations.map((node) => this.mapDeclaration(node));
		const candidates = mapped.flatMap((item) => (item.id === undefined ? [] : [item.id])).sort();
		if (candidates.length > 1) return { status: "ambiguous", candidates, provenance: "bound" };
		if (candidates.length === 1) return { status: "bound", symbolId: candidates[0] as string, provenance: "bound" };
		if (mapped.some((item) => item.external)) {
			return unknownBinding("ExternalDependency", "the declaration is outside the workspace");
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
		const admission = this.admit(module, fileName);
		if (admission !== undefined) return admission;

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
		const key = this.key(fileName);
		const version = this.overlays.get(key)?.version ?? 0;
		const cached = this.cachedFallbackProgram;
		if (cached?.key === key && cached.version === version) return cached.program;

		const options: ts.CompilerOptions = { ...this.projectOptions, allowJs: true, noResolve: true };
		const host = ts.createCompilerHost(options, true);
		const defaultGetSourceFile = host.getSourceFile.bind(host);
		host.readFile = (name) => this.readFile(name);
		host.fileExists = (name) => this.readFile(name) !== undefined;
		host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
			const text = this.readFile(name);
			if (text !== undefined) {
				return ts.createSourceFile(name, text, languageVersion, true, scriptKindOf(name));
			}
			return defaultGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
		};
		const program = ts.createProgram([fileName], options, host);
		this.cachedFallbackProgram = { key, version, program };
		return program;
	}

	private admit(module: string, fileName: string): SourceFailure | undefined {
		if (this.isExternal(fileName)) {
			return sourceFailure("ExternalDependency", "the module is outside the indexed workspace");
		}
		if (!claimsExtension(module)) {
			return sourceFailure(
				"NotImplemented",
				`the provider does not claim extension ${path.extname(module) || "(none)"}`,
			);
		}
		if (this.readFile(fileName) === undefined) return sourceFailure("ParseError", "the file does not exist");
		if (!this.scripts.has(fileName)) {
			this.scripts.add(fileName);
			this.invalidateProgram();
		}
		return undefined;
	}

	private invalidateProgram(): void {
		this.projectVersion += 1;
		this.extracted.clear();
		this.extractedProgram = undefined;
		this.cachedFallbackProgram = undefined;
	}

	private syncExtractionProgram(program: ts.Program | undefined): void {
		if (this.extractedProgram === program) return;
		this.extracted.clear();
		this.extractedProgram = program;
	}

	private program(): ts.Program | undefined {
		const started = Date.now();
		const program = this.service.getProgram();
		if (program !== undefined && program !== this.observedProgram) {
			this.observedProgram = program;
			this.programGenerations += 1;
		}
		if (this.firstProgramReadyAt === undefined && program !== undefined) {
			this.firstProgramReadyAt = Date.now() - started;
			this.firstProgramWorkspaceFiles = program
				.getSourceFiles()
				.filter(
					(source) => this.toModule(source.fileName) !== null && !this.isExternal(source.fileName),
				).length;
		}
		return program;
	}

	private mapDeclaration(node: ts.Declaration): MappedDeclaration {
		const source = node.getSourceFile();
		if (this.isExternal(source.fileName)) return { id: undefined, external: true, node };
		const module = this.toModule(source.fileName);
		if (module === null) return { id: undefined, external: true, node };
		const extracted = this.extract(module, source);
		const id = extracted.declarationNodes.get(node);
		return { id, external: false, node };
	}

	private fileName(module: string): string {
		return path.resolve(this.root, module.replace(/\\/g, "/"));
	}

	private key(fileName: string): string {
		const normalized = path.normalize(fileName);
		return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
	}

	private readFile(fileName: string): string | undefined {
		return this.overlays.get(this.key(fileName))?.text ?? ts.sys.readFile(fileName);
	}

	private toModule(fileName: string): string | null {
		return toModule(this.root, fileName);
	}

	private isExternal(fileName: string): boolean {
		const absolute = path.resolve(fileName);
		const relative = path.relative(this.root, absolute);
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

function positionOf(source: ts.SourceFile, position: Position): number {
	return source.getPositionOfLineAndCharacter(position.line, position.character);
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

function rangeOfSpan(source: ts.SourceFile, start: number, length: number) {
	const end = start + length;
	return {
		start: source.getLineAndCharacterOfPosition(start),
		end: source.getLineAndCharacterOfPosition(end),
	};
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
