import {
	type BlockedSite,
	coordinatesOf,
	type Range,
	type RenameEditsRequest,
	type RenameEditsResponse,
	type RenameSite,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";

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
const AMBIENT_NODE_FLAG = (ts.NodeFlags as unknown as { Ambient?: number }).Ambient ?? 1 << 25;

////////////////////////////////
//  Interfaces & Types

interface SiteContext {
	site: RenameSite;
	token: ts.Node | undefined;
	text: string;
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
	const privateTarget = request.oldName.startsWith("#") || sites.some((site) => site.text.startsWith("#"));
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

	const matchingSites = sites.filter((site) => matchesName(site, request.oldName));
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
	const replacement = token.kind === ts.SyntaxKind.PrivateIdentifier ? `#${candidateName}` : candidateName;
	if (isObjectShorthand(token)) {
		const range = widerRange(source, coordinates, token);
		return range === undefined
			? blocked(site.site.range, "ParseError", "the rename span is outside the module")
			: { edit: { range, newText: `${request.oldName}: ${replacement}` } };
	}
	if (isDestructuringShorthand(token)) {
		return { edit: { range: site.site.range, newText: `${request.oldName}: ${replacement}` } };
	}
	return { edit: { range: site.site.range, newText: replacement } };
}

function isObjectShorthand(token: ts.Node): boolean {
	return ts.isIdentifier(token) && ts.isShorthandPropertyAssignment(token.parent) && token.parent.name === token;
}

function isDestructuringShorthand(token: ts.Node): boolean {
	const parent = token.parent;
	return ts.isBindingElement(parent) && parent.propertyName === undefined && parent.name === token;
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
		if (moduleExportCollision(checker, token, newName)) return true;
		const property = propertyCollision(checker, token, newName);
		if (property) return true;
		if (isPropertyName(token)) return false;
		const meaning = meaningOf(token);
		return checker.resolveName(newName, token, meaning, false) !== undefined;
	});
}

function moduleExportCollision(checker: ts.TypeChecker, token: ts.Node, newName: string): boolean {
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
	return (
		moduleSymbol !== undefined &&
		checker.getExportsOfModule(moduleSymbol).some((symbol) => symbol.getName() === newName)
	);
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
	if (offsets === undefined) return { site, token: undefined, text: "", valid: false };
	const token = offsets.start < source.end ? tokenAt(source, offsets.start) : undefined;
	return { site, token, text: source.text.slice(offsets.start, offsets.end), valid: true };
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
	if (site.text === oldName) return true;
	if (site.token?.kind === ts.SyntaxKind.PrivateIdentifier) {
		return (site.token as ts.PrivateIdentifier).text === (oldName.startsWith("#") ? oldName : `#${oldName}`);
	}
	if (
		site.token?.kind === ts.SyntaxKind.StringLiteral ||
		site.token?.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
	) {
		return (site.token as ts.StringLiteral).text === oldName;
	}
	return false;
}

function validateEdits(coordinates: TextCoordinates, edits: TextEdit[], blocked: BlockedSite[]): RenameEditsResponse {
	const unique = new Map<string, TextEdit>();
	for (const edit of edits) {
		const offsets = coordinates.offsetsForRange(edit.range);
		if (offsets === undefined) {
			blocked.push({
				range: edit.range,
				reason: "ParseError",
				detail: "an edit range is outside the module",
			});
			continue;
		}
		unique.set(`${offsets.start}:${offsets.end}`, edit);
	}
	const sorted = [...unique.entries()]
		.map(([key, edit]) => ({ start: Number(key.split(":")[0]), end: Number(key.split(":")[1]), edit }))
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const safe: TextEdit[] = [];
	let previousEnd = -1;
	for (const item of sorted) {
		if (item.start < previousEnd) {
			blocked.push({
				range: item.edit.range,
				reason: "NotImplemented",
				detail: "the rename sites produce overlapping edits",
			});
			continue;
		}
		safe.push(item.edit);
		previousEnd = item.end;
	}
	return { status: "ready", edits: safe, blocked };
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
