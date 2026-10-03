import {
	type BlockedSite,
	coordinatesOf,
	planEdits,
	type Range,
	RENAME_EDIT_CONFLICT,
	type RenameEditsRequest,
	type RenameEditsResponse,
	type RenameSite,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { destructuredElement } from "./references.js";

////////////////////////////////
//  Constants

const RESERVED_WORDS = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"let",
	"static",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"abstract",
	"as",
	"asserts",
	"any",
	"boolean",
	"constructor",
	"declare",
	"get",
	"infer",
	"is",
	"keyof",
	"module",
	"namespace",
	"never",
	"number",
	"object",
	"readonly",
	"set",
	"string",
	"symbol",
	"type",
	"undefined",
	"unknown",
	"unique",
	"using",
	"await",
]);

const VALUE_MEANING = ts.SymbolFlags.Value | ts.SymbolFlags.Namespace;
const TYPE_MEANING = ts.SymbolFlags.Type | ts.SymbolFlags.Namespace;
const ALL_NAMED_MEANINGS = VALUE_MEANING | TYPE_MEANING;
const MEANINGS = [ts.SymbolFlags.Value, ts.SymbolFlags.Type, ts.SymbolFlags.Namespace];
const AMBIENT_NODE_FLAG = (ts.NodeFlags as unknown as { Ambient?: number }).Ambient ?? 1 << 25;

////////////////////////////////
//  Interfaces & Types

interface SiteContext {
	site: RenameSite;
	/** Set only when the site covers it exactly. */
	token: ts.Node | undefined;
	name: string | undefined;
	valid: boolean;
}

interface SiteResult {
	edit?: TextEdit;
	blocked?: BlockedSite;
}

////////////////////////////////
//  Main

export function makeRenameEdits(
	request: RenameEditsRequest,
	source: ts.SourceFile,
	checker: ts.TypeChecker,
): RenameEditsResponse {
	const coordinates = coordinatesOf(source.text);
	const sites = request.sites.map((site) => siteContext(source, coordinates, site));
	const privateTarget =
		request.oldName.startsWith("#") ||
		sites.some((site) => site.token !== undefined && ts.isPrivateIdentifier(site.token));
	const candidateName = request.newName.startsWith("#") ? request.newName.slice(1) : request.newName;

	if (request.newName.startsWith("#") && !privateTarget) {
		return { status: "refused", reason: "InvalidName", detail: "the new name cannot contain #" };
	}
	if (RESERVED_WORDS.has(candidateName)) {
		return { status: "refused", reason: "ReservedWord", detail: `the new name is reserved: ${candidateName}` };
	}
	if (!isLegalIdentifier(candidateName)) {
		return { status: "refused", reason: "InvalidName", detail: "the new name is not a legal identifier" };
	}

	// A site that covers no token is reported, never skipped.
	const matchingSites = sites.filter(
		(site) => site.valid && (site.token === undefined || matchesName(site, request.oldName)),
	);
	if (request.oldName !== request.newName && hasCollision(checker, matchingSites, candidateName)) {
		return {
			status: "refused",
			reason: "Collision",
			detail: `the new name collides with an existing symbol: ${candidateName}`,
		};
	}

	const results = matchingSites.map((site) => classifySite(source, coordinates, site, request, candidateName));
	const invalidSites: BlockedSite[] = sites
		.filter((site) => !site.valid)
		.map((site) => ({
			range: site.site.range,
			reason: "ParseError",
			detail: "the site range is outside the module",
		}));
	const blocked = [
		...invalidSites,
		...results.flatMap((result) => (result.blocked === undefined ? [] : [result.blocked])),
	];
	const edits = results.flatMap((result) => (result.edit === undefined ? [] : [result.edit]));
	return validateEdits(coordinates, edits, blocked);
}

////////////////////////////////
//  Site Classification

function classifySite(
	source: ts.SourceFile,
	coordinates: TextCoordinates,
	site: SiteContext,
	request: RenameEditsRequest,
	candidateName: string,
): SiteResult {
	const token = site.token;
	if (token === undefined) return blocked(site.site.range, "ParseError", "the site does not cover a source token");

	const fixedExport = fixedExportName(token);
	if (fixedExport !== undefined && matchesName(site, request.oldName)) {
		return blocked(site.site.range, "ExternalContract", fixedExport);
	}
	if (isStringPropertySite(token) && matchesName(site, request.oldName)) {
		return blocked(site.site.range, "StringLiteral", "the property name is written as a string literal");
	}
	if (isAmbientSite(source, token) && matchesName(site, request.oldName)) {
		return blocked(site.site.range, "ExternalContract", "the declaration is ambient or augments a module");
	}
	if (isAnonymousDefaultSite(token) && matchesName(site, request.oldName)) {
		return blocked(site.site.range, "NotImplemented", "an anonymous default declaration has no renameable symbol");
	}
	if (isJsxMeaningChange(token, candidateName) && matchesName(site, request.oldName)) {
		return blocked(site.site.range, "NotImplemented", "the new JSX casing changes intrinsic or component meaning");
	}

	if (!matchesName(site, request.oldName) || request.oldName === request.newName) return {};
	const specifier = specifierOf(token);
	if (site.site.keep === true && (specifier === undefined || !ts.isIdentifier(token))) {
		return blocked(site.site.range, "NotImplemented", "only a specifier's source name keeps its old name");
	}
	if (specifier !== undefined && ts.isIdentifier(token)) {
		const kept = specifier.propertyName === undefined && site.site.keep === true;
		if (kept) return { edit: { range: site.site.range, newText: `${candidateName} as ${request.oldName}` } };
		const alias = specifier.name;
		// `N2 as N` renamed to N is `N`.
		if (specifier.propertyName === token && ts.isIdentifier(alias) && alias.text === candidateName) {
			const range = coordinates.rangeAt(token.getStart(source), alias.getEnd());
			return range === undefined
				? blocked(site.site.range, "ParseError", "the rename span is outside the module")
				: { edit: { range, newText: candidateName } };
		}
	}
	const replacement = token.kind === ts.SyntaxKind.PrivateIdentifier ? `#${candidateName}` : candidateName;
	if (isObjectShorthand(token)) {
		const range = widerRange(source, coordinates, token);
		const newText = isShorthandKey(site)
			? `${replacement}: ${request.oldName}`
			: `${request.oldName}: ${replacement}`;
		return range === undefined
			? blocked(site.site.range, "ParseError", "the rename span is outside the module")
			: { edit: { range, newText } };
	}
	if (isDestructuringShorthand(token)) {
		const side = shorthandSide(site.site.role);
		const newText =
			side === "local"
				? `${request.oldName}: ${replacement}`
				: side === "key"
					? `${replacement}: ${request.oldName}`
					: replacement;
		return { edit: { range: site.site.range, newText } };
	}
	return { edit: { range: site.site.range, newText: replacement } };
}

/**
 * What a site on `{ N }` renames: its local where it declares or exports one, both where a require
 * edge binds it, else the key a use reads.
 */
function shorthandSide(role: string | undefined): "local" | "both" | "key" {
	if (role === undefined || role === "export") return "local";
	return role === "import" ? "both" : "key";
}

/** A destructured key the site renames while its local stays. */
function isDestructuredKey(site: SiteContext): boolean {
	const token = site.token;
	const element = token === undefined ? undefined : destructuredElement(token);
	if (element === undefined) return false;
	return element.propertyName === token || shorthandSide(site.site.role) === "key";
}

/** The import or export specifier whose source name `token` is. */
function specifierOf(token: ts.Node): ts.ImportSpecifier | ts.ExportSpecifier | undefined {
	const parent = token.parent;
	if (!ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent)) return undefined;
	return (parent.propertyName ?? parent.name) === token ? parent : undefined;
}

/** Renaming the token changes no binding in this file: an aliased or kept import, or a re-export. */
function bindsNoLocal(site: SiteContext): boolean {
	const token = site.token;
	const specifier = token === undefined ? undefined : specifierOf(token);
	if (specifier === undefined) return false;
	if (ts.isImportSpecifier(specifier)) return specifier.propertyName !== undefined || site.site.keep === true;
	return specifier.parent.parent.moduleSpecifier !== undefined;
}

function isObjectShorthand(token: ts.Node): boolean {
	return ts.isIdentifier(token) && ts.isShorthandPropertyAssignment(token.parent) && token.parent.name === token;
}

/** A role-less site is the member's own declaration: `{ N }`'s key, not its value. */
function isShorthandKey(site: SiteContext): boolean {
	return site.token !== undefined && isObjectShorthand(site.token) && site.site.role === undefined;
}

/** A site renaming an object literal's key: `N` in `{ N: x }`, or the key of `{ N }`. */
function isObjectKey(site: SiteContext): boolean {
	const token = site.token;
	if (token === undefined) return false;
	return (ts.isPropertyAssignment(token.parent) && token.parent.name === token) || isShorthandKey(site);
}

/** The object literal already has a property of the new name. */
function objectKeyCollision(checker: ts.TypeChecker, token: ts.Node, newName: string): boolean {
	const object = token.parent.parent;
	return checker.getPropertyOfType(checker.getTypeAtLocation(object), newName) !== undefined;
}

function isDestructuringShorthand(token: ts.Node): boolean {
	const element = destructuredElement(token);
	return element !== undefined && element.propertyName === undefined;
}

function widerRange(source: ts.SourceFile, coordinates: TextCoordinates, token: ts.Node): Range | undefined {
	const parent = token.parent;
	const node = ts.isShorthandPropertyAssignment(parent) || ts.isBindingElement(parent) ? parent : token;
	return coordinates.rangeAt(node.getStart(source), node.getEnd());
}

////////////////////////////////
//  Collision Detection

function hasCollision(checker: ts.TypeChecker, sites: SiteContext[], newName: string): boolean {
	return sites.some((site) => {
		const token = site.token;
		if (token === undefined) return false;
		const renamed = renamedSymbol(checker, token);
		if (moduleExportCollision(checker, token, newName, renamed)) return true;
		const key = isDestructuredKey(site);
		if (propertyCollision(checker, token, newName) || (key && keyCollision(checker, token, newName))) return true;
		if (isObjectKey(site)) return objectKeyCollision(checker, token, newName);
		if (key || isPropertyName(token) || bindsNoLocal(site)) return false;
		const position = meaningOf(token);
		const meaning = sharedMeaning(position, symbolMeaning(renamed)) || position;
		return checker.resolveName(newName, token, meaning, false) !== undefined;
	});
}

/** The symbol a site names, through exports and aliases; undefined when the checker cannot resolve it. */
function renamedSymbol(checker: ts.TypeChecker, token: ts.Node): ts.Symbol | undefined {
	const symbol = checker.getSymbolAtLocation(token);
	return symbol === undefined ? undefined : resolvedSymbol(checker, checker.getExportSymbolOfSymbol(symbol));
}

function resolvedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined {
	const target = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
	// An unresolved alias answers a symbol with no declarations.
	return (target.declarations ?? []).length > 0 ? target : undefined;
}

/** Value, type and namespace, as the checker gives them to `symbol`; all three when unknown. */
function symbolMeaning(symbol: ts.Symbol | undefined): ts.SymbolFlags {
	const flags = symbol?.flags ?? 0;
	const meaning = MEANINGS.reduce<ts.SymbolFlags>((held, each) => ((flags & each) === 0 ? held : held | each), 0);
	return meaning === 0 ? ALL_NAMED_MEANINGS : meaning;
}

/** The meanings two unions of `MEANINGS` share. */
function sharedMeaning(a: ts.SymbolFlags, b: ts.SymbolFlags): ts.SymbolFlags {
	return MEANINGS.reduce<ts.SymbolFlags>(
		(shared, each) => ((a & each) === each && (b & each) === each ? shared | each : shared),
		0,
	);
}

/** The source file or namespace body whose exports hold `declaration`. */
function exportScopeOf(declaration: ts.Node): ts.Node | undefined {
	return ts.findAncestor(declaration.parent, (node) => ts.isSourceFile(node) || ts.isModuleBlock(node));
}

/** Only one scope's own declarations merge; an export from another shadows by name. */
function declaredTogether(a: ts.Symbol, b: ts.Symbol): boolean {
	const scopes = new Set((a.declarations ?? []).map(exportScopeOf));
	scopes.delete(undefined);
	return (b.declarations ?? []).some((declaration) => scopes.has(exportScopeOf(declaration)));
}

function moduleExportCollision(
	checker: ts.TypeChecker,
	token: ts.Node,
	newName: string,
	renamed: ts.Symbol | undefined,
): boolean {
	const parent = token.parent;
	let declaration: ts.ImportDeclaration | ts.ExportDeclaration | undefined;
	let sourceName: ts.Node | undefined;
	if (ts.isImportSpecifier(parent)) {
		declaration = ancestorOfKind(token, ts.SyntaxKind.ImportDeclaration) as ts.ImportDeclaration | undefined;
		sourceName = parent.propertyName ?? parent.name;
	} else if (ts.isExportSpecifier(parent)) {
		declaration = ancestorOfKind(token, ts.SyntaxKind.ExportDeclaration) as ts.ExportDeclaration | undefined;
		sourceName = parent.propertyName ?? parent.name;
	}
	if (declaration === undefined || sourceName !== token || declaration.moduleSpecifier === undefined) return false;
	const moduleSymbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
	if (moduleSymbol === undefined) return false;
	const existing = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === newName);
	if (existing === undefined) return false;
	const target = resolvedSymbol(checker, existing);
	if (target === undefined || renamed === undefined) return true;
	if (target === renamed) return false;
	const disjoint = sharedMeaning(symbolMeaning(target), symbolMeaning(renamed)) === 0;
	return !(disjoint && declaredTogether(target, renamed));
}

function ancestorOfKind(node: ts.Node, kind: ts.SyntaxKind): ts.Node | undefined {
	let current: ts.Node | undefined = node.parent;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if (current.kind === kind) return current;
		current = current.parent;
	}
	return undefined;
}

function propertyCollision(checker: ts.TypeChecker, token: ts.Node, newName: string): boolean {
	const parent = token.parent;
	if (ts.isPropertyAccessExpression(parent) && parent.name === token) {
		const type = checker.getTypeAtLocation(parent.expression);
		return (
			checker.getPropertyOfType(type, newName) !== undefined ||
			(token.kind === ts.SyntaxKind.PrivateIdentifier &&
				checker.getPrivateIdentifierPropertyOfType(type, newName, token) !== undefined)
		);
	}
	if (!isPropertyDeclarationName(token)) return false;
	const container = token.parent.parent;
	if (!ts.isClassLike(container) && !ts.isTypeLiteralNode(container) && !ts.isInterfaceDeclaration(container)) {
		return false;
	}
	const name = (container as { name?: ts.Node }).name;
	const symbol = name === undefined ? undefined : checker.getSymbolAtLocation(name);
	const type = symbol === undefined ? checker.getTypeAtLocation(container) : checker.getDeclaredTypeOfSymbol(symbol);
	return (
		checker.getPropertyOfType(type, newName) !== undefined ||
		(token.kind === ts.SyntaxKind.PrivateIdentifier &&
			checker.getPrivateIdentifierPropertyOfType(type, newName, token) !== undefined)
	);
}

/** The destructured value already has a property of the new name. */
function keyCollision(checker: ts.TypeChecker, token: ts.Node, newName: string): boolean {
	const element = destructuredElement(token);
	if (element === undefined) return false;
	return checker.getPropertyOfType(checker.getTypeAtLocation(element.parent), newName) !== undefined;
}

function isPropertyName(token: ts.Node): boolean {
	return (
		isPropertyDeclarationName(token) || (ts.isPropertyAccessExpression(token.parent) && token.parent.name === token)
	);
}

function isPropertyDeclarationName(token: ts.Node): boolean {
	const parent = token.parent;
	return (
		(ts.isPropertyDeclaration(parent) && parent.name === token) ||
		(ts.isPropertySignature(parent) && parent.name === token) ||
		(ts.isMethodDeclaration(parent) && parent.name === token) ||
		(ts.isMethodSignature(parent) && parent.name === token) ||
		(ts.isGetAccessorDeclaration(parent) && parent.name === token) ||
		(ts.isSetAccessorDeclaration(parent) && parent.name === token) ||
		(ts.isEnumMember(parent) && parent.name === token)
	);
}

function meaningOf(token: ts.Node): ts.SymbolFlags {
	const parent = token.parent;
	if (
		ts.isInterfaceDeclaration(parent) ||
		ts.isTypeAliasDeclaration(parent) ||
		ts.isTypeParameterDeclaration(parent)
	) {
		return TYPE_MEANING;
	}
	if (
		ts.isFunctionDeclaration(parent) ||
		ts.isFunctionExpression(parent) ||
		ts.isArrowFunction(parent) ||
		ts.isVariableDeclaration(parent) ||
		ts.isParameter(parent) ||
		ts.isBindingElement(parent)
	) {
		return VALUE_MEANING;
	}
	if (isTypeQueryPosition(token)) return VALUE_MEANING;
	if (isTypePosition(token)) return TYPE_MEANING;
	if (isValuePosition(token)) return VALUE_MEANING;
	return ALL_NAMED_MEANINGS;
}

function isTypePosition(token: ts.Node): boolean {
	let current: ts.Node | undefined = token.parent;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if (ts.isTypeQueryNode(current)) return false;
		if (ts.isTypeNode(current)) return true;
		current = current.parent;
	}
	return false;
}

function isTypeQueryPosition(token: ts.Node): boolean {
	let current: ts.Node | undefined = token.parent;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if (ts.isTypeQueryNode(current)) return true;
		if (ts.isTypeNode(current)) return false;
		current = current.parent;
	}
	return false;
}

function isValuePosition(token: ts.Node): boolean {
	const parent = token.parent;
	return (
		ts.isExpression(parent) ||
		ts.isPropertyAccessExpression(parent) ||
		ts.isCallExpression(parent) ||
		ts.isNewExpression(parent) ||
		ts.isShorthandPropertyAssignment(parent)
	);
}

////////////////////////////////
//  Syntax Hazards

function fixedExportName(token: ts.Node): string | undefined {
	const parent = token.parent;
	if (!ts.isExportSpecifier(parent)) return undefined;
	if (parent.name === token && token.getText() === "default") return "the export name default is a fixed slot";
	if (parent.propertyName === token && token.getText() === "default")
		return "the source export default is a fixed slot";
	return undefined;
}

function isStringPropertySite(token: ts.Node): boolean {
	if (token.kind !== ts.SyntaxKind.StringLiteral && token.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
		return false;
	}
	const parent = token.parent;
	return ts.isElementAccessExpression(parent) && parent.argumentExpression === token;
}

function isAmbientSite(source: ts.SourceFile, token: ts.Node): boolean {
	if (source.isDeclarationFile) return true;
	let current: ts.Node | undefined = token;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if ((current.flags & AMBIENT_NODE_FLAG) !== 0) return true;
		if (
			ts.canHaveModifiers(current) &&
			(ts.getModifiers(current) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
		) {
			return true;
		}
		current = current.parent;
	}
	return false;
}

function isAnonymousDefaultSite(token: ts.Node): boolean {
	let current: ts.Node | undefined = token;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) {
			const modifiers = ts.canHaveModifiers(current) ? (ts.getModifiers(current) ?? []) : [];
			return (
				current.name === undefined &&
				modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
			);
		}
		current = current.parent;
	}
	return false;
}

function isJsxMeaningChange(token: ts.Node, newName: string): boolean {
	if (!ts.isIdentifier(token)) return false;
	const tag = jsxTagOf(token);
	if (tag === undefined || token !== firstTagIdentifier(tag)) return false;
	const oldUpper = isUppercaseName(token.text);
	return oldUpper !== isUppercaseName(newName);
}

function jsxTagOf(token: ts.Identifier): ts.JsxTagNameExpression | undefined {
	let current: ts.Node | undefined = token.parent;
	while (current !== undefined && !ts.isSourceFile(current)) {
		if (ts.isJsxOpeningLikeElement(current)) return current.tagName;
		if (ts.isJsxClosingElement(current)) return current.tagName;
		current = current.parent;
	}
	return undefined;
}

function firstTagIdentifier(tag: ts.JsxTagNameExpression): ts.Identifier | undefined {
	if (ts.isIdentifier(tag)) return tag;
	if (ts.isPropertyAccessExpression(tag)) return firstTagIdentifier(tag.expression);
	return undefined;
}

function isUppercaseName(name: string): boolean {
	const first = name[0];
	return first !== undefined && first.toUpperCase() === first && first.toLowerCase() !== first;
}

////////////////////////////////
//  Ranges & Validation

function siteContext(source: ts.SourceFile, coordinates: TextCoordinates, site: RenameSite): SiteContext {
	const offsets = coordinates.offsetsForRange(site.range);
	if (offsets === undefined) return { site, token: undefined, name: undefined, valid: false };
	const token = offsets.start < source.end ? tokenAt(source, offsets.start) : undefined;
	if (token === undefined || !covers(offsets, token, source)) {
		return { site, token: undefined, name: undefined, valid: true };
	}
	return { site, token, name: nameOf(token, source), valid: true };
}

/** The whole token, or a string literal's contents between its quotes. */
function covers(offsets: { start: number; end: number }, token: ts.Node, source: ts.SourceFile): boolean {
	const start = token.getStart(source);
	const end = token.getEnd();
	if (offsets.start === start && offsets.end === end) return true;
	const quoted = ts.isStringLiteral(token) || ts.isNoSubstitutionTemplateLiteral(token);
	return quoted && offsets.start === start + 1 && offsets.end === end - 1;
}

/** An identifier's or literal's value, else the token's own text. */
function nameOf(token: ts.Node, source: ts.SourceFile): string {
	if (
		ts.isIdentifier(token) ||
		ts.isPrivateIdentifier(token) ||
		ts.isStringLiteral(token) ||
		ts.isNoSubstitutionTemplateLiteral(token)
	) {
		return token.text;
	}
	return token.getText(source);
}

function tokenAt(source: ts.SourceFile, position: number): ts.Node | undefined {
	let found: ts.Node | undefined;
	function walk(node: ts.Node): void {
		const start = node.getStart(source);
		if (position < start || position >= node.getEnd()) return;
		if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) found = node;
		ts.forEachChild(node, walk);
	}
	walk(source);
	return found;
}

function matchesName(site: SiteContext, oldName: string): boolean {
	if (site.token !== undefined && ts.isPrivateIdentifier(site.token)) {
		return site.name === (oldName.startsWith("#") ? oldName : `#${oldName}`);
	}
	return site.name === oldName;
}

function validateEdits(coordinates: TextCoordinates, edits: TextEdit[], blocked: BlockedSite[]): RenameEditsResponse {
	const plan = planEdits(coordinates, edits);

	for (const { edit, conflict } of plan.conflicts) {
		blocked.push({ range: edit.range, ...RENAME_EDIT_CONFLICT[conflict] });
	}
	// Unreachable while every rename site is a name span, which has width. Reported rather than
	// assumed away, because the day a site is zero-width the join would pick an order silently.
	for (const { offset, edit } of plan.joined) {
		blocked.push({
			range: edit.range,
			reason: "NotImplemented",
			detail: `two rename insertions share one point at offset ${offset}`,
		});
	}
	return { status: "ready", edits: plan.edits, blocked };
}

function isLegalIdentifier(value: string): boolean {
	if (value === "") return false;
	const source = ts.createSourceFile(
		"rename.ts",
		`export const ${value} = 0;`,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const statement = source.statements[0];
	if (statement === undefined || !ts.isVariableStatement(statement)) return false;
	const declaration = statement.declarationList.declarations[0];
	return (
		declaration !== undefined &&
		ts.isIdentifier(declaration.name) &&
		declaration.name.text === value &&
		((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).length ===
			0
	);
}

function blocked(range: Range, reason: BlockedSite["reason"], detail: string): SiteResult {
	return { blocked: { range, reason, detail } };
}
