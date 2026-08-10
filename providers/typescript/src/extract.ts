// Turning a TypeScript AST into protocol facts.
//
// No parser here: the TypeScript compiler owns that, which is the whole reason the provider seam
// is a process boundary. This file only maps its tree onto our vocabulary.

import {
	composeSymbolId,
	type Declaration,
	type Descriptor,
	type ImportedName,
	type Literal,
	type Metrics,
	type Reference,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";

////////////////////////////////
//  Constants

export const LANGUAGE = "typescript";

////////////////////////////////
//  Interfaces & Types

export interface Extracted {
	declarations: Declaration[];
	references: Reference[];
	imports: { specifier: string; imported: ImportedName[]; reExport: boolean }[];
	literals: Literal[];
}

export interface ExtractedWithNodes extends Extracted {
	declarationNodes: Map<ts.Node, string>;
}

type ReferenceRole = Reference["role"];
type ReferenceNode = ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral | ts.NumericLiteral;

/** A declaration's own descriptor plus the chain it sits under, so ids nest correctly. */
interface Scope {
	descriptors: Descriptor[];
	containerId: string | undefined;
}

interface MetricsFunctionLike {
	parameters: readonly ts.ParameterDeclaration[];
	body: ts.ConciseBody | undefined;
}

interface ParameterBinding {
	name: ts.Identifier;
	rangeNode: ts.ParameterDeclaration | ts.BindingElement;
}

////////////////////////////////
//  Functions & Helpers

function rangeOf(node: ts.Node, source: ts.SourceFile) {
	const start = source.getLineAndCharacterOfPosition(node.getStart(source));
	const end = source.getLineAndCharacterOfPosition(node.getEnd());
	return { start, end };
}

function parameterRangeOf(node: ts.ParameterDeclaration | ts.BindingElement, source: ts.SourceFile) {
	let end = node.getEnd();
	if (node.initializer !== undefined) {
		const endNode = ts.isParameter(node) ? (node.type ?? node.questionToken ?? node.name) : node.name;
		end = endNode.getEnd();
	}
	return {
		start: source.getLineAndCharacterOfPosition(node.getStart(source)),
		end: source.getLineAndCharacterOfPosition(end),
	};
}

function declarationRangeOf(node: ts.Node, source: ts.SourceFile) {
	const comments = ts.getLeadingCommentRanges(source.text, node.pos) ?? [];
	const declarationStart = comments[0]?.pos ?? node.getStart(source);
	const start = source.getLineAndCharacterOfPosition(declarationStart);
	const end = source.getLineAndCharacterOfPosition(node.getEnd());
	return { start, end };
}

function nameRange(node: ts.Node, source: ts.SourceFile, name: ts.Node | undefined) {
	if (name) return rangeOf(name, source);
	if (ts.isConstructorDeclaration(node)) {
		const keyword = node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.ConstructorKeyword);
		if (keyword) return rangeOf(keyword, source);
	}
	return rangeOf(node, source);
}

function functionLikeForMetrics(node: ts.Node): MetricsFunctionLike | undefined {
	if (ts.isMethodSignature(node)) return { parameters: node.parameters, body: undefined };
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	) {
		return { parameters: node.parameters, body: node.body };
	}
	if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
		const initializer = node.initializer;
		if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
			return { parameters: initializer.parameters, body: initializer.body };
		}
	}
	return undefined;
}

function isControlNestingNode(node: ts.Node): boolean {
	return (
		ts.isIfStatement(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isSwitchStatement(node) ||
		ts.isTryStatement(node) ||
		ts.isCatchClause(node) ||
		ts.isWithStatement(node) ||
		ts.isConditionalExpression(node)
	);
}

function isDecisionNode(node: ts.Node): boolean {
	if (
		ts.isIfStatement(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isConditionalExpression(node) ||
		ts.isCatchClause(node)
	) {
		return true;
	}
	if (ts.isCaseClause(node)) return true;
	return (
		ts.isBinaryExpression(node) &&
		(node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
			node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
			node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
	);
}

function isNestedFunction(node: ts.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	);
}

function bodyMetrics(body: ts.Node): Pick<Metrics, "nesting" | "branches"> {
	let nesting = 0;
	let branches = 0;

	function walk(node: ts.Node, depth: number): void {
		if (isNestedFunction(node)) return;
		const nextDepth = isControlNestingNode(node) ? depth + 1 : depth;
		nesting = Math.max(nesting, nextDepth);
		if (isDecisionNode(node)) branches += 1;
		ts.forEachChild(node, (child) => walk(child, nextDepth));
	}

	walk(body, 0);
	return { nesting, branches: branches + 1 };
}

function metricsOf(node: ts.Node, range: ReturnType<typeof declarationRangeOf>): Metrics {
	const metrics: Metrics = { lines: range.end.line - range.start.line + 1 };
	const functionLike = functionLikeForMetrics(node);
	if (functionLike === undefined) return metrics;
	metrics.parameters = functionLike.parameters.length;
	if (functionLike.body === undefined) return metrics;
	Object.assign(metrics, bodyMetrics(functionLike.body));
	return metrics;
}

function containerIdOf(node: ts.Node, declarationNodes: Map<ts.Node, string>): string | undefined {
	let current: ts.Node | undefined = node;
	while (current !== undefined) {
		const id = declarationNodes.get(current);
		if (id !== undefined) return id;
		current = current.parent;
	}
	return undefined;
}

function isDynamicImport(node: ts.CallExpression): boolean {
	return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function isImportSpecifier(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
	const parent = node.parent;
	if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) {
		return true;
	}
	return ts.isCallExpression(parent) && isDynamicImport(parent) && parent.arguments[0] === node;
}

function literalOf(node: ts.Node, source: ts.SourceFile, declarationNodes: Map<ts.Node, string>): Literal | undefined {
	let literal: Literal | undefined;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		if (isImportSpecifier(node)) return undefined;
		literal = { kind: "string", value: node.text, range: rangeOf(node, source) };
	} else if (ts.isNumericLiteral(node)) {
		const value = node.getText(source);
		literal = { kind: "number", value, number: Number(value.replaceAll("_", "")), range: rangeOf(node, source) };
	} else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
		literal = {
			kind: "boolean",
			value: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false",
			range: rangeOf(node, source),
		};
	}
	if (literal === undefined) return undefined;
	const containerId = containerIdOf(node, declarationNodes);
	return containerId === undefined ? literal : { ...literal, containerId };
}

/** Reach, mapped onto the protocol's vocabulary rather than TypeScript's keywords. */
function visibilityOf(node: ts.Node, exported: boolean): Declaration["visibility"] {
	const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
	for (const modifier of modifiers) {
		if (modifier.kind === ts.SyntaxKind.PrivateKeyword) return "private";
		if (modifier.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
	}
	// A `#field` is private by syntax rather than by modifier.
	const name = (node as { name?: ts.Node }).name;
	if (name && ts.isPrivateIdentifier(name)) return "private";
	return exported ? "public" : "fileLocal";
}

function isExported(node: ts.Node): boolean {
	const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
	return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The signature line without the body, which is the compression the describe tool ships. */
function signatureOf(node: ts.Node, source: ts.SourceFile): string | undefined {
	const text = node.getText(source);
	const brace = text.indexOf("{");
	const line = (brace === -1 ? text : text.slice(0, brace)).split("\n")[0]?.trim();
	return line === undefined || line === "" ? undefined : line;
}

function docOf(node: ts.Node): string | undefined {
	const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
	const comment = jsDoc?.[0]?.comment;
	if (typeof comment === "string") return comment;
	return undefined;
}

function isDeclarationName(node: ts.Node): boolean {
	const parent = node.parent;
	if (
		ts.isBindingElement(parent) ||
		ts.isVariableDeclaration(parent) ||
		ts.isParameter(parent) ||
		ts.isTypeParameterDeclaration(parent) ||
		ts.isNamedTupleMember(parent)
	) {
		return parent.name === node;
	}
	if (
		ts.isClassDeclaration(parent) ||
		ts.isClassExpression(parent) ||
		ts.isInterfaceDeclaration(parent) ||
		ts.isTypeAliasDeclaration(parent) ||
		ts.isEnumDeclaration(parent) ||
		ts.isModuleDeclaration(parent) ||
		ts.isFunctionDeclaration(parent) ||
		ts.isFunctionExpression(parent) ||
		ts.isMethodDeclaration(parent) ||
		ts.isMethodSignature(parent) ||
		ts.isPropertyDeclaration(parent) ||
		ts.isPropertySignature(parent) ||
		ts.isEnumMember(parent) ||
		ts.isGetAccessorDeclaration(parent) ||
		ts.isSetAccessorDeclaration(parent) ||
		ts.isImportEqualsDeclaration(parent)
	) {
		return (parent as { name?: ts.Node }).name === node;
	}
	return false;
}

function isReferenceNode(node: ts.Node): node is ReferenceNode {
	return (
		ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
	);
}

function staticPropertyName(node: ts.PropertyName): string | undefined {
	if (
		ts.isIdentifier(node) ||
		ts.isPrivateIdentifier(node) ||
		ts.isStringLiteral(node) ||
		ts.isNumericLiteral(node)
	) {
		return node.text;
	}
	return undefined;
}

export function contextualPropertySymbol(checker: ts.TypeChecker, node: ts.PropertyAssignment): ts.Symbol | undefined {
	const name = staticPropertyName(node.name);
	if (name === undefined) return undefined;
	const contextualType = checker.getContextualType(node.parent);
	return contextualType === undefined ? undefined : checker.getPropertyOfType(contextualType, name);
}

function isContextualPropertyReference(node: ts.Node, checker: ts.TypeChecker): node is ReferenceNode {
	const parent = node.parent;
	return (
		isReferenceNode(node) &&
		ts.isPropertyAssignment(parent) &&
		parent.name === node &&
		contextualPropertySymbol(checker, parent) !== undefined
	);
}

function isNonReferenceName(node: ts.Node): boolean {
	const parent = node.parent;
	return (
		(ts.isPropertyAssignment(parent) && parent.name === node) ||
		(ts.isLabeledStatement(parent) && parent.label === node) ||
		((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) ||
		(ts.isJsxAttribute(parent) && parent.name === node)
	);
}

function isConstAssertionType(node: ts.Node): boolean {
	return (
		ts.isIdentifier(node) &&
		node.text === "const" &&
		ts.isTypeReferenceNode(node.parent) &&
		ts.isAsExpression(node.parent.parent) &&
		node.parent.parent.type === node.parent
	);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
	return (
		kind === ts.SyntaxKind.EqualsToken ||
		kind === ts.SyntaxKind.PlusEqualsToken ||
		kind === ts.SyntaxKind.MinusEqualsToken ||
		kind === ts.SyntaxKind.AsteriskEqualsToken ||
		kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
		kind === ts.SyntaxKind.SlashEqualsToken ||
		kind === ts.SyntaxKind.PercentEqualsToken ||
		kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
		kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
		kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
		kind === ts.SyntaxKind.AmpersandEqualsToken ||
		kind === ts.SyntaxKind.BarEqualsToken ||
		kind === ts.SyntaxKind.BarBarEqualsToken ||
		kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
		kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
		kind === ts.SyntaxKind.CaretEqualsToken
	);
}

function isAssignmentTarget(node: ts.Node): boolean {
	let current = node;
	while (ts.isParenthesizedExpression(current)) current = current.parent;
	const parent = current.parent;
	return ts.isBinaryExpression(parent) && parent.left === current && isAssignmentOperator(parent.operatorToken.kind);
}

function rolesForValue(node: ts.Node): ReferenceRole[] {
	const parent = node.parent;
	if (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) {
		return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? ["write"] : ["read", "write"];
	}
	if (
		(ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
		(parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
	) {
		return ["read", "write"];
	}
	if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node) {
		return ["write"];
	}
	if (ts.isShorthandPropertyAssignment(parent) && parent.name === node && isAssignmentTarget(parent.parent)) {
		return rolesForValue(parent.parent);
	}
	if (ts.isPropertyAssignment(parent) && parent.initializer === node && isAssignmentTarget(parent.parent)) {
		return rolesForValue(parent.parent);
	}
	if ((ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)) && isAssignmentTarget(parent)) {
		return rolesForValue(parent);
	}
	return ["read"];
}

function rolesForIdentifier(node: ts.Identifier | ts.PrivateIdentifier): ReferenceRole[] {
	if (isDeclarationName(node) || isNonReferenceName(node)) return [];
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent)) {
		if (parent.expression === node) return ["read"];
		if (parent.name === node) {
			const container = parent.parent;
			if (ts.isCallExpression(container) && container.expression === parent) return ["call"];
			if (ts.isNewExpression(container) && container.expression === parent) return ["instantiate"];
			return rolesForValue(parent);
		}
	}
	if (ts.isCallExpression(parent) && parent.expression === node) return ["call"];
	if (ts.isNewExpression(parent) && parent.expression === node) return ["instantiate"];
	return rolesForValue(node);
}

function referenceTarget(expression: ts.Expression): ts.Identifier | ts.PrivateIdentifier | undefined {
	if (ts.isIdentifier(expression) || ts.isPrivateIdentifier(expression)) return expression;
	if (ts.isPropertyAccessExpression(expression)) return expression.name;
	return undefined;
}

////////////////////////////////
//  Declarations

/** What kind a node is, and which descriptor its id carries. Null means we do not report it. */
function classify(node: ts.Node): { kind: Declaration["kind"]; descriptor: Descriptor["kind"] } | null {
	if (ts.isClassDeclaration(node)) return { kind: "class", descriptor: "type" };
	if (ts.isInterfaceDeclaration(node)) return { kind: "interface", descriptor: "type" };
	if (ts.isTypeAliasDeclaration(node)) return { kind: "interface", descriptor: "type" };
	if (ts.isEnumDeclaration(node)) return { kind: "enum", descriptor: "type" };
	if (ts.isModuleDeclaration(node)) {
		return { kind: ts.isStringLiteral(node.name) ? "module" : "namespace", descriptor: "namespace" };
	}
	if (ts.isFunctionDeclaration(node)) return { kind: "function", descriptor: "method" };
	if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return { kind: "method", descriptor: "method" };
	if (ts.isConstructorDeclaration(node)) return { kind: "constructor", descriptor: "method" };
	if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
		return { kind: "property", descriptor: "term" };
	}
	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return { kind: "property", descriptor: "term" };
	if (ts.isEnumMember(node)) return { kind: "constant", descriptor: "term" };
	return null;
}

function anonymousDefaultExportOf(
	node: ts.Node,
): { kind: Declaration["kind"]; descriptor: Descriptor["kind"] } | undefined {
	if (ts.isClassDeclaration(node) && node.name === undefined && hasDefaultModifier(node)) {
		return { kind: "class", descriptor: "type" };
	}
	if (ts.isFunctionDeclaration(node) && node.name === undefined && hasDefaultModifier(node)) {
		return { kind: "function", descriptor: "method" };
	}
	if (ts.isExportAssignment(node) && !node.isExportEquals) {
		if (ts.isClassExpression(node.expression)) return { kind: "class", descriptor: "type" };
		if (ts.isFunctionExpression(node.expression)) return { kind: "function", descriptor: "method" };
		return { kind: "variable", descriptor: "term" };
	}
	return undefined;
}

function hasDefaultModifier(node: ts.Node): boolean {
	return ts.canHaveModifiers(node)
		? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
		: false;
}

function defaultSelectionRange(node: ts.Node, source: ts.SourceFile) {
	const modifier = ts.canHaveModifiers(node)
		? (ts.getModifiers(node) ?? []).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword)
		: undefined;
	const defaultKeyword =
		modifier ?? node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword);
	return rangeOf(defaultKeyword ?? node, source);
}

function nameOf(node: ts.Node): string | null {
	const name = (node as { name?: ts.Node }).name;
	if (name === undefined) return ts.isConstructorDeclaration(node) ? "constructor" : null;
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text;
	return null;
}

function parameterBindings(parameter: ts.ParameterDeclaration): ParameterBinding[] {
	const bindings: ParameterBinding[] = [];
	function visit(name: ts.BindingName, rangeNode: ts.ParameterDeclaration | ts.BindingElement): void {
		if (ts.isIdentifier(name)) {
			bindings.push({ name, rangeNode });
			return;
		}
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) visit(element.name, element);
		}
	}
	visit(parameter.name, parameter);
	return bindings;
}

/**
 * Walk a file into declarations and references.
 *
 * Exported-ness is taken from the modifier only. A re-export through a barrel is not syntactic,
 * and claiming otherwise here would be exactly the confident-wrong-answer the design refuses.
 */
export function extractFile(module: string, source: ts.SourceFile, checker?: ts.TypeChecker): Extracted {
	const extracted = extractFileWithNodes(module, source, checker);
	return {
		declarations: extracted.declarations,
		references: extracted.references,
		imports: extracted.imports,
		literals: extracted.literals,
	};
}

export function extractFileWithNodes(
	module: string,
	source: ts.SourceFile,
	checker?: ts.TypeChecker,
): ExtractedWithNodes {
	const declarations: Declaration[] = [];
	const references: Reference[] = [];
	const imports: Extracted["imports"] = [];
	const literals: Literal[] = [];
	const declarationNodes = new Map<ts.Node, string>();
	const declarationScopes = new Map<ts.Node, Scope>();
	const occurrences = new Map<string, number>();
	const referenceRoles = new Map<ts.Node, ReferenceRole[]>();

	function markReference(node: ts.Node, role: ReferenceRole): void {
		if (!isReferenceNode(node)) return;
		const roles = referenceRoles.get(node) ?? [];
		if (!roles.includes(role)) roles.push(role);
		referenceRoles.set(node, roles);
	}

	function classifyReferenceTree(node: ts.Node, inType: boolean): void {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
		if (ts.isHeritageClause(node)) {
			const role = node.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
			for (const type of node.types) {
				const target = referenceTarget(type.expression);
				if (target === undefined) classifyReferenceTree(type.expression, false);
				else markReference(target, role);
				for (const argument of type.typeArguments ?? []) classifyReferenceTree(argument, true);
			}
			return;
		}
		if (checker !== undefined && isContextualPropertyReference(node, checker)) {
			markReference(node, "read");
			return;
		}
		if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
			if (isConstAssertionType(node)) return;
			const roles: ReferenceRole[] = inType ? ["typeUse"] : rolesForIdentifier(node);
			for (const role of roles) markReference(node, role);
			return;
		}
		const childInType = inType || ts.isTypeNode(node);
		ts.forEachChild(node, (child) => classifyReferenceTree(child, childInType));
	}

	function descriptorFor(scope: Scope, descriptor: Descriptor): Descriptor {
		const prefix = scope.descriptors.map((item) => `${item.kind}:${item.name}`).join("/");
		const key = `${prefix}/${descriptor.kind}:${descriptor.name}`;
		const ordinal = occurrences.get(key) ?? 0;
		occurrences.set(key, ordinal + 1);
		return ordinal === 0 ? descriptor : { ...descriptor, disambiguator: String(ordinal) };
	}

	function ownerScopeOfParameter(parameter: ts.ParameterDeclaration): Scope | undefined {
		const parent = parameter.parent;
		const direct = declarationScopes.get(parent);
		if (direct !== undefined) return direct;
		if (!ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent)) return undefined;

		let expression: ts.Expression = parent;
		let current: ts.Node = parent;
		while (true) {
			const enclosing = current.parent;
			if (
				(ts.isParenthesizedExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isAsExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isTypeAssertionExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isSatisfiesExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isNonNullExpression(enclosing) && enclosing.expression === expression)
			) {
				expression = enclosing;
				current = enclosing;
				continue;
			}
			if (
				(ts.isVariableDeclaration(enclosing) || ts.isPropertyDeclaration(enclosing)) &&
				(enclosing.initializer === expression || enclosing.initializer === current)
			) {
				return declarationScopes.get(enclosing);
			}
			return undefined;
		}
	}

	function recordParameters(parameter: ts.ParameterDeclaration, owner: Scope): void {
		for (const binding of parameterBindings(parameter)) {
			const descriptors = [
				...owner.descriptors,
				descriptorFor(owner, { kind: "parameter", name: binding.name.text }),
			];
			const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
			declarationNodes.set(binding.rangeNode, symbolId);
			declarations.push({
				symbolId,
				kind: "variable",
				name: binding.name.text,
				range: parameterRangeOf(binding.rangeNode, source),
				selectionRange: rangeOf(binding.name, source),
				visibility: "local",
				exported: false,
				...(owner.containerId === undefined ? {} : { containerId: owner.containerId }),
			});
		}
	}

	function record(node: ts.Node, scope: Scope, exportedByParent: boolean): Scope {
		if (ts.isParameter(node)) {
			const owner = ownerScopeOfParameter(node);
			if (owner === undefined) return scope;
			recordParameters(node, owner);
			return owner;
		}
		const anonymousDefault = anonymousDefaultExportOf(node);
		if (anonymousDefault !== undefined) {
			const descriptors: Descriptor[] = [
				...scope.descriptors,
				descriptorFor(scope, { kind: anonymousDefault.descriptor, name: "default" }),
			];
			const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
			declarationNodes.set(node, symbolId);
			const range = declarationRangeOf(node, source);
			const signature = signatureOf(node, source);

			declarations.push({
				symbolId,
				kind: anonymousDefault.kind,
				name: "default",
				range,
				selectionRange: defaultSelectionRange(node, source),
				visibility: "public",
				exported: true,
				metrics: metricsOf(node, range),
				...(signature === undefined ? {} : { signature }),
				...(docOf(node) === undefined ? {} : { docComment: docOf(node) as string }),
				...(scope.containerId === undefined ? {} : { containerId: scope.containerId }),
			});

			const inner = { descriptors, containerId: symbolId };
			declarationScopes.set(node, inner);
			return inner;
		}
		const classified = classify(node);
		const name = classified ? nameOf(node) : null;
		if (!classified || name === null) return scope;

		const exported = exportedByParent || isExported(node);
		const descriptors: Descriptor[] = [
			...scope.descriptors,
			descriptorFor(scope, { kind: classified.descriptor, name }),
		];
		const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
		declarationNodes.set(node, symbolId);
		const range = declarationRangeOf(node, source);

		declarations.push({
			symbolId,
			kind: classified.kind,
			name,
			range,
			selectionRange: nameRange(node, source, (node as { name?: ts.Node }).name),
			visibility: visibilityOf(node, exported),
			exported,
			metrics: metricsOf(node, range),
			...(signatureOf(node, source) === undefined ? {} : { signature: signatureOf(node, source) as string }),
			...(docOf(node) === undefined ? {} : { docComment: docOf(node) as string }),
			...(scope.containerId === undefined ? {} : { containerId: scope.containerId }),
		});

		const inner = { descriptors, containerId: symbolId };
		declarationScopes.set(node, inner);
		return inner;
	}

	function recordVariables(statement: ts.VariableStatement, scope: Scope): void {
		const exported = isExported(statement);
		// `const` is a different kind from `let`, and a consumer deciding whether something can be
		// reassigned reads the kind rather than re-parsing the declaration.
		const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) continue;
			const name = declaration.name.text;
			const descriptors: Descriptor[] = [...scope.descriptors, descriptorFor(scope, { kind: "term", name })];
			const symbolId = composeSymbolId({ language: LANGUAGE, module, descriptors });
			declarationNodes.set(declaration, symbolId);
			declarationScopes.set(declaration, { descriptors, containerId: symbolId });
			const range = declarationRangeOf(statement, source);
			const signature = signatureOf(declaration, source);

			declarations.push({
				symbolId,
				kind: isConst ? "constant" : "variable",
				name,
				range,
				selectionRange: rangeOf(declaration.name, source),
				visibility: exported ? "public" : "fileLocal",
				exported,
				metrics: metricsOf(declaration, range),
				...(signature === undefined ? {} : { signature }),
				...(scope.containerId === undefined ? {} : { containerId: scope.containerId }),
			});
		}
	}

	function importedNameOf(
		name: ts.Identifier | ts.StringLiteral | undefined,
		local: ts.Identifier | ts.StringLiteral | undefined = undefined,
	): ImportedName {
		const imported: ImportedName = {};
		if (name !== undefined) {
			imported.name = name.text;
			imported.range = rangeOf(name, source);
		}
		if (local !== undefined && (name === undefined || local.text !== name.text)) {
			imported.local = local.text;
			imported.localRange = rangeOf(local, source);
		}
		return imported;
	}

	function recordImport(node: ts.ImportDeclaration | ts.ExportDeclaration): void {
		const specifier = node.moduleSpecifier;
		if (specifier === undefined || !ts.isStringLiteral(specifier)) return;

		const named: ImportedName[] = [];
		if (ts.isImportDeclaration(node)) {
			const bindings = node.importClause?.namedBindings;
			if (node.importClause?.name) named.push(importedNameOf(undefined, node.importClause.name));
			if (bindings && ts.isNamedImports(bindings))
				for (const element of bindings.elements) {
					const name = element.propertyName ?? element.name;
					named.push(importedNameOf(name, element.propertyName === undefined ? undefined : element.name));
				}
			if (bindings && ts.isNamespaceImport(bindings)) named.push(importedNameOf(undefined, bindings.name));
		} else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
			for (const element of node.exportClause.elements) {
				const name = element.propertyName ?? element.name;
				const local =
					element.name.text === "default"
						? undefined
						: element.propertyName === undefined
							? undefined
							: element.name;
				named.push(importedNameOf(name, local));
			}
		} else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
			named.push(importedNameOf(undefined, node.exportClause.name));
		}

		imports.push({ specifier: specifier.text, imported: named, reExport: ts.isExportDeclaration(node) });
	}

	function recordDynamicImport(node: ts.CallExpression): void {
		const argument = node.arguments[0];
		if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)))
			return;
		imports.push({ specifier: argument.text, imported: [], reExport: false });
	}

	function recordReference(node: ReferenceNode, role: ReferenceRole, scope: Scope): void {
		references.push({
			name: node.text,
			range: rangeOf(node, source),
			role,
			binding: { status: "unbound", reason: "NotImplemented", detail: "binding runs in the bind tier" },
			...(scope.containerId === undefined ? {} : { fromId: scope.containerId }),
		});
	}

	function walk(node: ts.Node, scope: Scope, exportedByParent: boolean): void {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) recordImport(node);
		if (ts.isCallExpression(node) && isDynamicImport(node)) recordDynamicImport(node);
		if (ts.isVariableStatement(node)) recordVariables(node, scope);
		const literal = literalOf(node, source, declarationNodes);
		if (literal !== undefined) literals.push(literal);
		if (isReferenceNode(node)) {
			for (const role of referenceRoles.get(node) ?? []) recordReference(node, role, scope);
		}

		const recorded = record(node, scope, exportedByParent);
		const inner = declarationScopes.get(node) ?? recorded;
		// A member of an exported container is reachable, so its own lack of `export` is not privacy.
		const childrenExported = inner !== scope && (exportedByParent || isExported(node));
		ts.forEachChild(node, (child) => walk(child, inner, childrenExported));
	}

	classifyReferenceTree(source, false);
	walk(source, { descriptors: [], containerId: undefined }, false);
	return { declarations, references, imports, literals, declarationNodes };
}
