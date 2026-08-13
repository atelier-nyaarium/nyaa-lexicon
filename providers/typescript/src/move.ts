import path from "node:path";
import {
	type MoveBlockedReason,
	type MoveBlockedSite,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	type Range,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { claimsExtension } from "./file-types.js";
import type { SpecifierRenderer } from "./project.js";

////////////////////////////////
//  Interfaces & Types

interface ExistingImport {
	specifier: string;
	localNames: Set<string>;
}

interface ImportSiteNode {
	node: ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration;
	literal: ts.StringLiteral;
}

interface OffsetRange {
	start: number;
	end: number;
}

////////////////////////////////
//  Constants

const BUILTIN_NAMES = new Set([
	"any",
	"Array",
	"ArrayBuffer",
	"ArrayBufferView",
	"ArrayLike",
	"AsyncIterable",
	"AsyncIterableIterator",
	"Awaited",
	"bigint",
	"BigInt",
	"BigInt64Array",
	"BigUint64Array",
	"boolean",
	"Boolean",
	"CallableFunction",
	"Capitalize",
	"console",
	"ConstructorParameters",
	"DataView",
	"Date",
	"document",
	"Element",
	"Error",
	"Event",
	"Exclude",
	"Extract",
	"false",
	"Float32Array",
	"Float64Array",
	"FormData",
	"Function",
	"Generator",
	"GeneratorFunction",
	"Headers",
	"HTMLElement",
	"HTMLInputElement",
	"HTMLTextAreaElement",
	"Infinity",
	"InstanceType",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"Iterable",
	"IterableIterator",
	"Iterator",
	"JSON",
	"Map",
	"Math",
	"MessageEvent",
	"MouseEvent",
	"never",
	"NonNullable",
	"NoInfer",
	"Node",
	"Number",
	"Object",
	"Omit",
	"OmitThisParameter",
	"Partial",
	"Parameters",
	"Pick",
	"Promise",
	"PromiseLike",
	"PropertyKey",
	"Record",
	"Readonly",
	"ReadonlyArray",
	"ReadonlyMap",
	"ReadonlySet",
	"RegExp",
	"Required",
	"ReturnType",
	"Set",
	"SharedArrayBuffer",
	"String",
	"Symbol",
	"SymbolConstructor",
	"ThisParameterType",
	"ThisType",
	"true",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"undefined",
	"Uncapitalize",
	"UnicodeNormalizationForm",
	"unknown",
	"URL",
	"URLSearchParams",
	"Uppercase",
	"WeakMap",
	"WeakSet",
	"Window",
	"XMLHttpRequest",
	"void",
]);

////////////////////////////////
//  Main

export function makeMoveEdits(
	request: MoveEditsRequest,
	source: ts.SourceFile,
	checker: ts.TypeChecker | undefined,
	renderSpecifier: SpecifierRenderer,
): MoveEditsResponse {
	const syntaxErrors = parseDiagnostics(source);
	if (syntaxErrors.length > 0) {
		return { status: "refused", reason: "ParseError", detail: "the module contains syntax errors" };
	}

	if (sameModule(request.module, request.toModule) && request.exists && declaresName(source, request.name)) {
		return {
			status: "refused",
			reason: "TargetCollision",
			detail: `the target already declares ${request.name}`,
		};
	}

	const blocked: MoveBlockedSite[] = [];
	const edits: TextEdit[] = [];
	const imports = existingImports(source);
	const importSites = source.statements
		.map(importSiteNode)
		.filter((site): site is ImportSiteNode => site !== undefined);

	if (request.role.removal !== undefined) {
		const offsets = offsetsForRange(source, request.role.removal);
		if (offsets === undefined) {
			blocked.push(blockedSite(request.role.removal, "ParseError", "the removal range is outside the module"));
		} else {
			edits.push({ range: request.role.removal, newText: "" });
		}
	}

	for (const site of request.importSites) {
		const result = rewriteImportSite(source, site, importSites, request.module, request.toModule, renderSpecifier);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		if (result.edit !== undefined) edits.push(result.edit);
	}

	for (const site of request.sites) {
		blocked.push(blockedSite(site, "NotImplemented", "the moved symbol occurs outside an import statement"));
	}

	const pendingImports = new Set<string>();
	for (const dependency of request.dependencies) {
		const plan = importForDependency(request, dependency, source, checker, imports, renderSpecifier);
		if (plan.blocked !== undefined) blocked.push(plan.blocked);
		if (plan.statement !== undefined) pendingImports.add(plan.statement);
	}

	if (pendingImports.size > 0) {
		const position = importInsertionPosition(source);
		const insertion = positionAt(source, position);
		if (insertion === undefined) {
			blocked.push({ reason: "ParseError", detail: "the import insertion point is outside the module" });
		} else {
			const prefix = position > 0 && source.text[position - 1] !== "\n" ? "\n" : "";
			edits.push({
				range: { start: insertion, end: insertion },
				newText: `${prefix}${[...pendingImports].join("\n")}\n`,
			});
		}
	}

	if (request.role.insertion !== undefined) {
		const position =
			request.role.insertion.position === undefined
				? source.text.length
				: offsetForPosition(source, request.role.insertion.position);
		if (position === undefined) {
			blocked.push(
				blockedSite(
					request.role.insertion.position === undefined
						? undefined
						: { start: request.role.insertion.position, end: request.role.insertion.position },
					"ParseError",
					"the insertion position is outside the module",
				),
			);
		} else {
			const point = positionAt(source, position);
			if (point === undefined) {
				blocked.push({ reason: "ParseError", detail: "the insertion position is outside the module" });
			} else {
				edits.push({ range: { start: point, end: point }, newText: request.role.insertion.text });
			}
		}
	}

	return validateEdits(source, edits, blocked);
}

////////////////////////////////
//  Site Rewriting

function rewriteImportSite(
	source: ts.SourceFile,
	site: MoveImportSite,
	statements: ImportSiteNode[],
	fromModule: string,
	toModule: string,
	renderSpecifier: SpecifierRenderer,
): { edit?: TextEdit; blocked?: MoveBlockedSite } {
	const offsets = offsetsForRange(source, site.range);
	if (offsets === undefined)
		return { blocked: blockedSite(site.range, "ParseError", "the import range is outside the module") };

	const statement = statements.find(
		(candidate) => candidate.node.getStart(source) <= offsets.start && offsets.start < candidate.node.getEnd(),
	);
	if (statement === undefined || statement.literal.text !== site.specifier) {
		return {
			blocked: blockedSite(site.range, "ParseError", "the range does not name the requested import"),
		};
	}

	const rendered = renderSpecifier(fromModule, toModule, site.specifier);
	if ("reason" in rendered) return { blocked: blockedSite(site.range, rendered.reason, rendered.detail) };
	if (rendered.specifier === site.specifier) return {};

	const literalStart = statement.literal.getStart(source);
	const literalEnd = statement.literal.getEnd();
	const statementStart = statement.node.getStart(source);
	const statementEnd = statement.node.getEnd();
	const statementRange = rangeOfOffsets(source, statementStart, statementEnd);
	if (statementRange === undefined || literalStart < statementStart || literalEnd > statementEnd) {
		return { blocked: blockedSite(site.range, "ParseError", "the import range does not contain its specifier") };
	}

	const raw = source.text.slice(statementStart, statementEnd);
	const relativeStart = literalStart - statementStart;
	const relativeEnd = literalEnd - statementStart;
	const quote = source.text[literalStart] === "'" ? "'" : '"';
	const replacement = quoteSpecifier(rendered.specifier, quote);
	return {
		edit: {
			range: statementRange,
			newText: `${raw.slice(0, relativeStart)}${replacement}${raw.slice(relativeEnd)}`,
		},
	};
}

function importSiteNode(statement: ts.Statement): ImportSiteNode | undefined {
	if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
		return { node: statement, literal: statement.moduleSpecifier };
	}
	const moduleSpecifier = ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
	if (ts.isExportDeclaration(statement) && moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
		return { node: statement, literal: moduleSpecifier };
	}
	if (ts.isImportEqualsDeclaration(statement)) {
		const reference = statement.moduleReference;
		if (
			ts.isExternalModuleReference(reference) &&
			reference.expression !== undefined &&
			ts.isStringLiteral(reference.expression)
		) {
			return { node: statement, literal: reference.expression };
		}
	}
	return undefined;
}

////////////////////////////////
//  Dependency Imports

function importForDependency(
	request: MoveEditsRequest,
	dependency: MoveDependency,
	source: ts.SourceFile,
	checker: ts.TypeChecker | undefined,
	imports: ExistingImport[],
	renderSpecifier: SpecifierRenderer,
): { statement?: string; blocked?: MoveBlockedSite } {
	if (isBuiltinName(dependency.name, checker, source)) return {};

	const origin = dependency.origin;
	if (origin.kind === "insideClosure") return {};
	if (origin.kind === "unresolved") {
		return {
			blocked: blockedSite(dependency.range, "DynamicDependency", origin.reason),
		};
	}
	if (origin.kind === "sourceModule" && origin.exported === false) {
		return {
			blocked: blockedSite(dependency.range, "PrivateSibling", `${origin.name} is not exported`),
		};
	}

	let specifier: string;
	let preferred: string | undefined;
	if (origin.kind === "sourceModule") {
		const rendered = renderSpecifier(request.module, request.fromModule);
		if ("reason" in rendered) return { blocked: blockedSite(dependency.range, rendered.reason, rendered.detail) };
		specifier = rendered.specifier;
	} else if (origin.kind === "workspaceModule") {
		preferred = origin.via?.specifier;
		const rendered = renderSpecifier(request.module, origin.module, preferred);
		if ("reason" in rendered) return { blocked: blockedSite(dependency.range, rendered.reason, rendered.detail) };
		specifier = rendered.specifier;
	} else {
		specifier = origin.via.specifier;
	}

	if (hasExistingBinding(imports, dependency.name, specifier)) return {};

	const statement = importStatement(dependency, specifier);
	if (statement === undefined) {
		return {
			blocked: blockedSite(dependency.range, "NotImplemented", "the import form cannot bind a moved dependency"),
		};
	}
	return { statement };
}

function importStatement(dependency: MoveDependency, specifier: string): string | undefined {
	const origin = dependency.origin;
	const via = origin.kind === "workspaceModule" || origin.kind === "external" ? origin.via : undefined;
	const importedName = via?.importedName ?? dependency.name;
	const localName = dependency.name;

	if (via?.importKind === "wildcard" || via?.importKind === "sideEffect") return undefined;
	if (via?.importKind === "default") {
		if (localName === "default") return undefined;
		return `import ${localName} from ${quoteSpecifier(specifier, '"')};`;
	}
	if (via?.importKind === "namespace") {
		if (localName === "default") return undefined;
		return `import * as ${localName} from ${quoteSpecifier(specifier, '"')};`;
	}
	if (via?.importKind === "typeOnly" && via.importedName === undefined && via.localName !== undefined) {
		return `import type ${localName} from ${quoteSpecifier(specifier, '"')};`;
	}

	const named = importedName === localName ? importedName : `${importedName} as ${localName}`;
	const prefix = via?.importKind === "typeOnly" ? "import type" : "import";
	return `${prefix} { ${named} } from ${quoteSpecifier(specifier, '"')};`;
}

function existingImports(source: ts.SourceFile): ExistingImport[] {
	const imports: ExistingImport[] = [];
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			const localNames = new Set<string>();
			const clause = statement.importClause;
			if (clause?.name !== undefined) localNames.add(clause.name.text);
			const bindings = clause?.namedBindings;
			if (bindings !== undefined && ts.isNamespaceImport(bindings)) localNames.add(bindings.name.text);
			if (bindings !== undefined && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) localNames.add(element.name.text);
			}
			imports.push({ specifier: statement.moduleSpecifier.text, localNames });
			continue;
		}
		if (ts.isImportEqualsDeclaration(statement)) {
			const reference = statement.moduleReference;
			if (
				ts.isExternalModuleReference(reference) &&
				reference.expression !== undefined &&
				ts.isStringLiteral(reference.expression)
			) {
				imports.push({ specifier: reference.expression.text, localNames: new Set([statement.name.text]) });
			}
		}
	}
	return imports;
}

function hasExistingBinding(imports: ExistingImport[], name: string, specifier: string): boolean {
	return imports.some((entry) => entry.specifier === specifier && entry.localNames.has(name));
}

////////////////////////////////
//  Target Checks

export function isValidTargetModule(workspaceRoot: string, module: string): boolean {
	if (!claimsExtension(module)) return false;
	try {
		const normalized = normalizeModulePath(module);
		if (normalized !== module) return false;
		const absolute = path.resolve(workspaceRoot, normalized);
		return normalized === module && path.relative(path.resolve(workspaceRoot), absolute) === normalized;
	} catch {
		return false;
	}
}

function declaresName(source: ts.SourceFile, name: string): boolean {
	return source.statements.some((statement) => {
		if (ts.isVariableStatement(statement)) {
			return statement.declarationList.declarations.some((declaration) => bindingNameHas(declaration.name, name));
		}
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement) ||
				ts.isModuleDeclaration(statement)) &&
			statement.name !== undefined
		) {
			return declarationName(statement.name) === name;
		}
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (clause?.name?.text === name) return true;
			const bindings = clause?.namedBindings;
			if (bindings !== undefined && ts.isNamespaceImport(bindings)) return bindings.name.text === name;
			return bindings !== undefined && ts.isNamedImports(bindings)
				? bindings.elements.some((element) => element.name.text === name)
				: false;
		}
		if (ts.isImportEqualsDeclaration(statement)) return statement.name.text === name;
		if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
			if (ts.isNamespaceExport(statement.exportClause)) return statement.exportClause.name.text === name;
			if (ts.isNamedExports(statement.exportClause)) {
				return statement.exportClause.elements.some((element) => element.name.text === name);
			}
		}
		return (
			name === "default" &&
			(ts.isExportAssignment(statement) ||
				((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
					hasDefaultModifier(statement)))
		);
	});
}

function bindingNameHas(binding: ts.BindingName, wanted: string): boolean {
	if (ts.isIdentifier(binding)) return binding.text === wanted;
	return binding.elements.some((element) => {
		if (ts.isOmittedExpression(element)) return false;
		return bindingNameHas(element.name, wanted);
	});
}

function declarationName(name: ts.Node): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function hasDefaultModifier(node: ts.ClassDeclaration | ts.FunctionDeclaration): boolean {
	return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

////////////////////////////////
//  Builtins

function isBuiltinName(name: string, checker: ts.TypeChecker | undefined, source: ts.SourceFile): boolean {
	if (BUILTIN_NAMES.has(name)) return true;
	if (checker === undefined) return false;
	try {
		const symbol = checker.resolveName(
			name,
			source,
			ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
			false,
		);
		if (symbol === undefined || symbol.declarations === undefined || symbol.declarations.length === 0) return false;
		return symbol.declarations.every((declaration) =>
			/(?:^|[\\/])lib\.[^\\/]+\.d\.ts$/.test(declaration.getSourceFile().fileName),
		);
	} catch {
		return false;
	}
}

////////////////////////////////
//  Ranges & Validation

function offsetsForRange(source: ts.SourceFile, range: Range): OffsetRange | undefined {
	const start = offsetForPosition(source, range.start);
	const end = offsetForPosition(source, range.end);
	return start === undefined || end === undefined || end < start ? undefined : { start, end };
}

function offsetForPosition(source: ts.SourceFile, position: { line: number; character: number }): number | undefined {
	if (position.line < 0 || position.character < 0) return undefined;
	try {
		const offset = source.getPositionOfLineAndCharacter(position.line, position.character);
		const actual = source.getLineAndCharacterOfPosition(offset);
		return actual.line === position.line && actual.character === position.character ? offset : undefined;
	} catch {
		return undefined;
	}
}

function positionAt(source: ts.SourceFile, offset: number): { line: number; character: number } | undefined {
	if (offset < 0 || offset > source.text.length) return undefined;
	return source.getLineAndCharacterOfPosition(offset);
}

function rangeOfOffsets(source: ts.SourceFile, start: number, end: number): Range | undefined {
	const startPosition = positionAt(source, start);
	const endPosition = positionAt(source, end);
	return startPosition === undefined || endPosition === undefined
		? undefined
		: { start: startPosition, end: endPosition };
}

function importInsertionPosition(source: ts.SourceFile): number {
	let lastImportEnd: number | undefined;
	for (const statement of source.statements) {
		if (isImportLike(statement)) {
			lastImportEnd = statement.getEnd();
			continue;
		}
		return statement.getStart(source);
	}
	return lastImportEnd ?? source.text.length;
}

function isImportLike(statement: ts.Statement): boolean {
	return (
		ts.isImportDeclaration(statement) ||
		ts.isExportDeclaration(statement) ||
		ts.isImportEqualsDeclaration(statement)
	);
}

function validateEdits(source: ts.SourceFile, edits: TextEdit[], blocked: MoveBlockedSite[]): MoveEditsResponse {
	const unique = new Map<string, TextEdit>();
	for (const edit of edits) {
		const offsets = offsetsForRange(source, edit.range);
		if (offsets === undefined) {
			blocked.push(blockedSite(edit.range, "ParseError", "an edit range is outside the module"));
			continue;
		}
		const key = `${offsets.start}:${offsets.end}`;
		const previous = unique.get(key);
		if (previous === undefined) {
			unique.set(key, edit);
		} else if (previous.newText !== edit.newText && offsets.start === offsets.end) {
			unique.set(key, { range: edit.range, newText: `${previous.newText}${edit.newText}` });
		} else if (previous.newText !== edit.newText) {
			blocked.push(blockedSite(edit.range, "NotImplemented", "the move produces duplicate edits"));
		}
	}

	const sorted = [...unique.values()]
		.map((edit) => {
			const offsets = offsetsForRange(source, edit.range) as OffsetRange;
			return { edit, ...offsets };
		})
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const safe: TextEdit[] = [];
	let previousEnd = -1;
	for (const item of sorted) {
		if (item.start < previousEnd) {
			blocked.push(blockedSite(item.edit.range, "NotImplemented", "the move produces overlapping edits"));
			continue;
		}
		safe.push(item.edit);
		previousEnd = Math.max(previousEnd, item.end);
	}
	return { status: "ready", edits: safe, blocked };
}

function blockedSite(range: Range | undefined, reason: MoveBlockedReason, detail: string): MoveBlockedSite {
	return range === undefined ? { reason, detail } : { range, reason, detail };
}

function quoteSpecifier(specifier: string, quote: "'" | '"'): string {
	const escaped = specifier.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
	return `${quote}${escaped}${quote}`;
}

function sameModule(left: string, right: string): boolean {
	return path.posix.normalize(left.replace(/\\/g, "/")) === path.posix.normalize(right.replace(/\\/g, "/"));
}

function parseDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
	return (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}
