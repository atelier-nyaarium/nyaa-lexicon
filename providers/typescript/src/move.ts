import path from "node:path";
import {
	comparePositions,
	coordinatesOf,
	MOVE_EDIT_CONFLICT,
	type MoveBlockedReason,
	type MoveBlockedSite,
	type MoveDependency,
	type MoveEditsRequest,
	type MoveEditsResponse,
	type MoveImportSite,
	normalizeModulePath,
	planEdits,
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

type PlannedImport =
	| { clause: "default" | "namespace"; typeOnly: boolean; specifier: string; localName: string }
	| { clause: "named"; typeOnly: boolean; specifier: string; importedName: string; localName: string };

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

	const pendingImports = new Map<string, PlannedImport>();
	for (const dependency of request.dependencies) {
		const plan = importForDependency(request, dependency, source, checker, imports, renderSpecifier);
		if (plan.blocked !== undefined) blocked.push(plan.blocked);
		if (plan.planned !== undefined) pendingImports.set(renderImport(plan.planned), plan.planned);
	}

	const standalone: string[] = [];
	for (const [statement, planned] of pendingImports) {
		const merged = mergeIntoExistingImport(source, coordinates, planned, edits);
		if (merged === undefined) standalone.push(statement);
		else edits.push(merged);
	}

	if (standalone.length > 0) {
		const { offset, lineBreak } = importInsertion(source);
		const insertion = coordinates.positionAt(offset);
		if (insertion === undefined) {
			blocked.push({ reason: "ParseError", detail: "the import insertion point is outside the module" });
		} else {
			edits.push({
				range: { start: insertion, end: insertion },
				newText: `${lineBreak ? "\n" : ""}${standalone.join("\n")}\n`,
			});
		}
	}

	if (request.role.insertion !== undefined) {
		const { text, position } = request.role.insertion;
		const offset = position === undefined ? source.text.length : coordinates.offsetAt(position);
		const point = offset === undefined ? undefined : coordinates.positionAt(offset);
		if (point === undefined) {
			blocked.push(
				blockedSite(
					position === undefined ? undefined : { start: position, end: position },
					"ParseError",
					"the insertion position is outside the module",
				),
			);
		} else {
			const separate = position === undefined && needsBlankLine(source);
			edits.push({ range: { start: point, end: point }, newText: separate ? `\n${text}` : text });
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
	const quote = statement.literal.getText(source).startsWith("'") ? "'" : '"';
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
): { planned?: PlannedImport; blocked?: MoveBlockedSite } {
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

	const planned = plannedImport(dependency, specifier);
	if (planned === undefined) {
		return {
			blocked: blockedSite(dependency.range, "NotImplemented", "the import form cannot bind a moved dependency"),
		};
	}
	return { planned };
}

function plannedImport(dependency: MoveDependency, specifier: string): PlannedImport | undefined {
	const origin = dependency.origin;
	const via = origin.kind === "workspaceModule" || origin.kind === "external" ? origin.via : undefined;
	const importedName = via?.importedName ?? dependency.name;
	const localName = dependency.name;

	if (via?.importKind === "wildcard" || via?.importKind === "sideEffect") return undefined;
	if (via?.importKind === "default" || via?.importKind === "namespace") {
		if (localName === "default") return undefined;
		return { clause: via.importKind, typeOnly: false, specifier, localName };
	}
	if (via?.importKind === "typeOnly" && via.importedName === undefined && via.localName !== undefined) {
		return { clause: "default", typeOnly: true, specifier, localName };
	}
	return { clause: "named", typeOnly: via?.importKind === "typeOnly", specifier, importedName, localName };
}

function renderImport(planned: PlannedImport): string {
	const keyword = planned.typeOnly ? "import type" : "import";
	const from = quoteSpecifier(planned.specifier, '"');
	if (planned.clause === "named") return `${keyword} { ${namedElement(planned)} } from ${from};`;
	const binding = planned.clause === "namespace" ? `* as ${planned.localName}` : planned.localName;
	return `${keyword} ${binding} from ${from};`;
}

function namedElement(planned: Extract<PlannedImport, { clause: "named" }>): string {
	return planned.importedName === planned.localName
		? planned.importedName
		: `${planned.importedName} as ${planned.localName}`;
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

/** True when the target's last token or comment has no blank line after it. */
function needsBlankLine(source: ts.SourceFile): boolean {
	const last = contentLineBefore(source.endOfFileToken, source);
	return last !== undefined && lineOf(source, source.text.length) - last < 2;
}

/** Joins an existing plain named import. */
function mergeIntoExistingImport(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	planned: PlannedImport,
	edits: TextEdit[],
): TextEdit | undefined {
	if (planned.clause !== "named" || planned.typeOnly) return undefined;

	for (const candidate of source.statements) {
		if (!ts.isImportDeclaration(candidate) || !ts.isStringLiteral(candidate.moduleSpecifier)) continue;
		if (candidate.moduleSpecifier.text !== planned.specifier) continue;
		const bindings = candidate.importClause?.namedBindings;
		if (candidate.importClause === undefined || candidate.importClause.name !== undefined) continue;
		if (candidate.importClause.isTypeOnly || bindings === undefined || !ts.isNamedImports(bindings)) continue;

		const range = coordinates.rangeAt(candidate.getStart(source), candidate.getEnd());
		if (range === undefined) return undefined;
		if (edits.some((edit) => rangesOverlap(edit.range, range))) return undefined;

		const names = bindings.elements.map((element) => element.getText(source));
		return {
			range,
			newText: `import { ${[...names, namedElement(planned)].join(", ")} } from ${quoteSpecifier(planned.specifier, '"')};`,
		};
	}
	return undefined;
}

function rangesOverlap(left: Range, right: Range): boolean {
	return comparePositions(left.start, right.end) < 0 && comparePositions(right.start, left.end) < 0;
}

/** Before the first other statement, else after the last import, else at the end. */
function importInsertion(source: ts.SourceFile): { offset: number; lineBreak: boolean } {
	let lastImport: ts.Statement | undefined;
	for (const statement of source.statements) {
		if (!isImportLike(statement)) return lineBefore(statement, source);
		lastImport = statement;
	}
	return lastImport === undefined
		? lineBefore(source.endOfFileToken, source)
		: { offset: lastImport.getEnd(), lineBreak: true };
}

/** Just before `node`, breaking the line when a token or comment ends on it first. */
function lineBefore(node: ts.Node, source: ts.SourceFile): { offset: number; lineBreak: boolean } {
	const offset = node.getStart(source);
	return { offset, lineBreak: contentLineBefore(node, source) === lineOf(source, offset) };
}

/** Line of the last token or comment before `node`, if any. */
function contentLineBefore(node: ts.Node, source: ts.SourceFile): number | undefined {
	const text = source.text;
	// Its `pos` is the previous token's end, and its trivia holds any comment before it.
	const comments = [
		...(ts.getTrailingCommentRanges(text, node.pos) ?? []),
		...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
	];
	const end = Math.max(node.pos, ts.getShebang(text)?.length ?? 0, ...comments.map((comment) => comment.end));
	return end > 0 ? lineOf(source, end - 1) : undefined;
}

function lineOf(source: ts.SourceFile, offset: number): number {
	return source.getLineAndCharacterOfPosition(offset).line;
}

function isImportLike(statement: ts.Statement): boolean {
	return (
		ts.isImportDeclaration(statement) ||
		ts.isExportDeclaration(statement) ||
		ts.isImportEqualsDeclaration(statement)
	);
}

function validateEdits(coordinates: TextCoordinates, edits: TextEdit[], blocked: MoveBlockedSite[]): MoveEditsResponse {
	const plan = planEdits(coordinates, edits);
	for (const { edit, conflict } of plan.conflicts) {
		const named = MOVE_EDIT_CONFLICT[conflict];
		blocked.push(blockedSite(edit.range, named.reason, named.detail));
	}
	// Joined insertions are deliberate here: collecting several for one point is how a move adds
	// more than one import to a file.
	return { status: "ready", edits: plan.edits, blocked };
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
