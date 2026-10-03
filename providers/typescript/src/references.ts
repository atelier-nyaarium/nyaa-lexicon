// Which names are references, and the role each plays.

import type { Reference } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { bindsModule } from "./imports.js";

////////////////////////////////
//  Interfaces & Types

export type ReferenceRole = Reference["role"];
export type ReferenceNode = ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral | ts.NumericLiteral;

////////////////////////////////
//  Functions & Helpers

export function isDeclarationName(node: ts.Node): boolean {
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

export function isReferenceNode(node: ts.Node): node is ReferenceNode {
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

export function isContextualPropertyReference(node: ts.Node, checker: ts.TypeChecker): node is ReferenceNode {
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

export function isConstAssertionType(node: ts.Node): boolean {
	return (
		ts.isIdentifier(node) &&
		node.text === "const" &&
		ts.isTypeReferenceNode(node.parent) &&
		ts.isAsExpression(node.parent.parent) &&
		node.parent.parent.type === node.parent
	);
}

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
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

export function rolesForIdentifier(node: ts.Identifier | ts.PrivateIdentifier): ReferenceRole[] {
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

export function referenceTarget(expression: ts.Expression): ts.Identifier | ts.PrivateIdentifier | undefined {
	if (ts.isIdentifier(expression) || ts.isPrivateIdentifier(expression)) return expression;
	if (ts.isPropertyAccessExpression(expression)) return expression.name;
	return undefined;
}

/** The object binding element whose key `node` is: `a` in `{ a: x }` or `{ a }`. */
export function destructuredElement(node: ts.Node): ts.BindingElement | undefined {
	if (!ts.isIdentifier(node)) return undefined;
	const parent = node.parent;
	if (!ts.isBindingElement(parent) || !ts.isObjectBindingPattern(parent.parent)) return undefined;
	if (parent.dotDotDotToken !== undefined) return undefined;
	return (parent.propertyName ?? parent.name) === node ? parent : undefined;
}

/** The expression a destructured key is read from, with the keys leading to it: `{ a: { N } } = ns` is `ns` and [a, N]. */
function destructuredFrom(element: ts.BindingElement, key: string): { receiver: ts.Node; path: string[] } | undefined {
	const path = [key];
	let current = element;
	while (true) {
		const holder = current.parent.parent;
		if (ts.isVariableDeclaration(holder)) {
			return holder.initializer === undefined ? undefined : { receiver: holder.initializer, path };
		}
		if (!ts.isBindingElement(holder) || !ts.isObjectBindingPattern(holder.parent)) return undefined;
		const outer = holder.propertyName;
		if (outer === undefined || !ts.isIdentifier(outer) || holder.dotDotDotToken !== undefined) return undefined;
		path.unshift(outer.text);
		current = holder;
	}
}

/** A member's root name and the names after it: `ns.a.N`, `ns.a.N` as a type, and `const { a: { N } } = ns`. */
export function memberRoute(node: ts.Node): { root: ts.Identifier; path: string[] } | undefined {
	if (!ts.isIdentifier(node)) return undefined;
	const parent = node.parent;
	const element = destructuredElement(node);
	let from: { receiver: ts.Node; path: string[] } | undefined;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node)
		from = { receiver: parent.expression, path: [node.text] };
	else if (ts.isQualifiedName(parent) && parent.right === node) from = { receiver: parent.left, path: [node.text] };
	else if (element !== undefined) from = destructuredFrom(element, node.text);
	if (from === undefined) return undefined;
	let receiver = from.receiver;
	const path = from.path;
	while (!ts.isIdentifier(receiver)) {
		if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.name)) {
			path.unshift(receiver.name.text);
			receiver = receiver.expression;
		} else if (ts.isQualifiedName(receiver)) {
			path.unshift(receiver.right.text);
			receiver = receiver.left;
		} else return undefined;
	}
	return { root: receiver, path };
}

/** `N` in `const { N } = ns`, where the checker binds `ns` to a whole module. */
export function isModuleMemberShorthand(node: ts.Node, checker: ts.TypeChecker): boolean {
	const element = destructuredElement(node);
	if (element === undefined || element.propertyName !== undefined) return false;
	const root = memberRoute(node)?.root;
	const symbol = root === undefined ? undefined : checker.getSymbolAtLocation(root);
	return (
		symbol !== undefined &&
		(symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
		(symbol.declarations ?? []).some(bindsModule)
	);
}

/** The one meaning a use reads by its position; undefined where it reads every meaning or a namespace. */
export function meaningAt(node: ts.Node): "value" | "type" | undefined {
	const parent = node.parent;
	if (
		ts.isImportSpecifier(parent) ||
		ts.isExportSpecifier(parent) ||
		ts.isImportClause(parent) ||
		ts.isNamespaceImport(parent) ||
		ts.isNamespaceExport(parent) ||
		ts.isImportEqualsDeclaration(parent) ||
		ts.isExportAssignment(parent)
	) {
		return undefined;
	}
	if (ts.isPartOfTypeNode(node)) return "type";
	// The head of a path in a type names a namespace, except under `typeof`.
	let entity = node;
	while (ts.isQualifiedName(entity.parent) && entity.parent.left === entity) entity = entity.parent;
	if (entity !== node) return ts.isTypeQueryNode(entity.parent) ? "value" : undefined;
	while (ts.isPropertyAccessExpression(entity.parent) && entity.parent.expression === entity) entity = entity.parent;
	if (ts.isExpressionWithTypeArguments(entity.parent) && ts.isPartOfTypeNode(entity.parent)) return undefined;
	return "value";
}

/** Reached through a receiver or path. */
export function isQualifiedReference(node: ReferenceNode): boolean {
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) || ts.isMetaProperty(parent) || ts.isJsxNamespacedName(parent)) {
		return parent.name === node;
	}
	if (ts.isQualifiedName(parent) && parent.right === node) return true;
	if (destructuredElement(node) !== undefined) return true;
	return isImportTypeQualifier(node);
}

/** Every segment of `import("m").a.B`. */
function isImportTypeQualifier(node: ts.Node): boolean {
	let path = node;
	while (ts.isQualifiedName(path.parent)) path = path.parent;
	return ts.isImportTypeNode(path.parent) && path.parent.qualifier === path;
}
