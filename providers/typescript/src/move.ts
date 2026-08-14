import path from "node:path";
import {
	coordinatesOf,
	type MoveBlockedReason,
	type MoveBlockedSite,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	type OffsetRange,
	type Range,
	type TextCoordinates,
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
	const coordinates = coordinatesOf(source.text);
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
		const offsets = coordinates.offsetsForRange(request.role.removal);
		if (offsets === undefined) {
			blocked.push(blockedSite(request.role.removal, "ParseError", "the removal range is outside the module"));
		} else {
			edits.push({ range: request.role.removal, newText: "" });
		}
	}

	for (const site of request.importSites) {
		const result = rewriteImportSite(
			source,
			coordinates,
			site,
			importSites,
			request.module,
			request.toModule,
			renderSpecifier,
		);
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

	// Names that fit an import statement already in this module join it rather than starting a
	// second one for the same specifier. Merging is refused when another edit already rewrites
	// that statement, since two edits over one span cannot both apply.
	const standalone: string[] = [];
	for (const statement of pendingImports) {
		const merged = mergeIntoExistingImport(source, coordinates, statement, edits);
		if (merged === undefined) standalone.push(statement);
		else edits.push(merged);
	}

	if (standalone.length > 0) {
		const position = importInsertionPosition(source);
		const insertion = coordinates.positionAt(position);
		if (insertion === undefined) {
			blocked.push({ reason: "ParseError", detail: "the import insertion point is outside the module" });
		} else {
			const prefix = position > 0 && source.text[position - 1] !== "\n" ? "\n" : "";
			edits.push({
				range: { start: insertion, end: insertion },
				newText: `${prefix}${standalone.join("\n")}\n`,
			});
		}
	}

	if (request.role.insertion !== undefined) {
		const position =
			request.role.insertion.position === undefined
				? source.text.length
				: coordinates.offsetAt(request.role.insertion.position);
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
		} else if (request.role.insertion.position === undefined && needsBlankLine(source.text)) {
			// Appending to a file that already ends in content: separate the declarations, or the
			// moved body ends up welded to whatever was last in the target.
			const point = coordinates.positionAt(position);
			if (point === undefined) {
				blocked.push({ reason: "ParseError", detail: "the insertion position is outside the module" });
			} else {
				edits.push({ range: { start: point, end: point }, newText: `\n${request.role.insertion.text}` });
			}
		} else {
			const point = coordinates.positionAt(position);
			if (point === undefined) {
				blocked.push({ reason: "ParseError", detail: "the insertion position is outside the module" });
			} else {
				edits.push({ range: { start: point, end: point }, newText: request.role.insertion.text });
			}
		}
	}

	return validateEdits(coordinates, edits, blocked);
}

////////////////////////////////
//  Site Rewriting

function rewriteImportSite(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	site: MoveImportSite,
	statements: ImportSiteNode[],
	fromModule: string,
	toModule: string,
	renderSpecifier: SpecifierRenderer,
): { edit?: TextEdit; blocked?: MoveBlockedSite } {
	// A specifier rewrite is only sound when the statement names exactly the moved symbol. These
	// kinds bind every export of the source, so repointing them repoints symbols that did not move.
	if (site.importKind === "namespace" || site.importKind === "wildcard" || site.importKind === "sideEffect") {
		return {
			blocked: blockedSite(
				site.range,
				"NotImplemented",
				`a ${site.importKind} ${site.reExport ? "re-export" : "import"} binds the whole module, and splitting it is not implemented`,
			),
		};
	}

	const offsets = coordinates.offsetsForRange(site.range);
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
	const statementRange = coordinates.rangeAt(statementStart, statementEnd);
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

/** True when the target already ends in content, so an appended declaration needs separating. */
function needsBlankLine(text: string): boolean {
	return text.trim().length > 0 && !text.endsWith("\n\n");
}

/**
 * Folds a plain `import { name } from "spec";` into an existing statement for the same specifier.
 *
 * Only a plain named import merges into a plain named import: a default or namespace clause, a
 * type-only statement, or a span another edit already rewrites all keep their own statement,
 * because guessing at those shapes is how a rewrite silently changes what a name means.
 */
function mergeIntoExistingImport(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	statement: string,
	edits: TextEdit[],
): TextEdit | undefined {
	const parsed = /^import \{ (\w+(?: as \w+)?) \} from ("[^"]+"|'[^']+');$/.exec(statement);
	if (parsed === null) return undefined;
	const clause = parsed[1] as string;
	const specifier = (parsed[2] as string).slice(1, -1);

	for (const candidate of source.statements) {
		if (!ts.isImportDeclaration(candidate) || !ts.isStringLiteral(candidate.moduleSpecifier)) continue;
		if (candidate.moduleSpecifier.text !== specifier) continue;
		const bindings = candidate.importClause?.namedBindings;
		if (candidate.importClause === undefined || candidate.importClause.name !== undefined) continue;
		if (candidate.importClause.isTypeOnly || bindings === undefined || !ts.isNamedImports(bindings)) continue;

		const range = coordinates.rangeAt(candidate.getStart(source), candidate.getEnd());
		if (range === undefined) return undefined;
		if (edits.some((edit) => rangesOverlap(edit.range, range))) return undefined;

		const names = bindings.elements.map((element) => element.getText(source));
		return {
			range,
			newText: `import { ${[...names, clause].join(", ")} } from ${quoteSpecifier(specifier, '"')};`,
		};
	}
	return undefined;
}

function rangesOverlap(left: Range, right: Range): boolean {
	const before = (a: Range["start"], b: Range["start"]) =>
		a.line === b.line ? a.character < b.character : a.line < b.line;
	return before(left.start, right.end) && before(right.start, left.end);
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

function validateEdits(coordinates: TextCoordinates, edits: TextEdit[], blocked: MoveBlockedSite[]): MoveEditsResponse {
	const unique = new Map<string, TextEdit>();
	for (const edit of edits) {
		const offsets = coordinates.offsetsForRange(edit.range);
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
			const offsets = coordinates.offsetsForRange(edit.range) as OffsetRange;
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
