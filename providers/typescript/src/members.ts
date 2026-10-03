// The object types and member braces a declaration owns.

import ts from "typescript";

////////////////////////////////
//  Functions & Helpers

type Wrapper =
	| ts.ParenthesizedExpression
	| ts.AsExpression
	| ts.TypeAssertion
	| ts.SatisfiesExpression
	| ts.NonNullExpression;

export function isWrapper(node: ts.Node): node is Wrapper {
	return (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node)
	);
}

/** Through parentheses and type-only wrappers. */
export function unwrapped(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (isWrapper(current)) current = current.expression;
	return current;
}

/** Any type but `unknown` and `any`. */
function isStatedType(type: ts.TypeNode): boolean {
	let inner = type;
	while (ts.isParenthesizedTypeNode(inner)) inner = inner.type;
	return inner.kind !== ts.SyntaxKind.UnknownKeyword && inner.kind !== ts.SyntaxKind.AnyKeyword;
}

/** Whether `satisfies T`, `as T` or `<T>` states a type; undefined for `as const` and the other wrappers. */
function statesType(wrapper: Wrapper): boolean | undefined {
	if (ts.isSatisfiesExpression(wrapper)) return true;
	if (!ts.isAsExpression(wrapper) && !ts.isTypeAssertionExpression(wrapper)) return undefined;
	return ts.isConstTypeReference(wrapper.type) ? undefined : isStatedType(wrapper.type);
}

/** The type an alias, property, variable or named parameter declares, if any. */
function declaredTypeOf(node: ts.Node): ts.TypeNode | undefined {
	if (
		ts.isTypeAliasDeclaration(node) ||
		ts.isPropertySignature(node) ||
		ts.isPropertyDeclaration(node) ||
		ts.isVariableDeclaration(node)
	) {
		return node.type;
	}
	return ts.isParameter(node) && ts.isIdentifier(node.name) ? node.type : undefined;
}

/** A declaration's own object type, when its declared type is one. */
export function ownTypeLiteral(node: ts.Node): ts.TypeLiteralNode | undefined {
	let type = declaredTypeOf(node);
	while (type !== undefined && ts.isParenthesizedTypeNode(type)) type = type.type;
	return type !== undefined && ts.isTypeLiteralNode(type) ? type : undefined;
}

/** The types a declared type is made of: a union's, an intersection's, an array's element. */
export function partsOf(type: ts.Node): readonly ts.TypeNode[] | undefined {
	if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types;
	if (ts.isParenthesizedTypeNode(type)) return [type.type];
	if (ts.isArrayTypeNode(type)) return [type.elementType];
	if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) return [type.type];
	return undefined;
}

/**
 * The object types a declaration's own type is made of, through unions, intersections and arrays.
 * A type literal anywhere else, a return type's or a type argument's, belongs to nothing.
 */
export function ownedTypeLiterals(node: ts.Node): ts.TypeLiteralNode[] {
	const literals: ts.TypeLiteralNode[] = [];
	const visit = (type: ts.TypeNode): void => {
		if (ts.isTypeLiteralNode(type)) literals.push(type);
		else partsOf(type)?.forEach(visit);
	};
	const declared = declaredTypeOf(node);
	if (declared !== undefined) visit(declared);
	return literals;
}

/** The node's member braces, if any. */
export function memberBodyOf(node: ts.Node): ts.Node | undefined {
	if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) return node;
	if (ts.isModuleDeclaration(node)) {
		return node.body !== undefined && ts.isModuleBlock(node.body) ? node.body : undefined;
	}
	if (ts.isTypeAliasDeclaration(node)) return ownTypeLiteral(node);
	const value =
		ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)
			? node.initializer
			: ts.isExportAssignment(node)
				? node.expression
				: undefined;
	const inner = value === undefined ? undefined : unwrapped(value);
	return inner !== undefined && (ts.isClassExpression(inner) || ts.isObjectLiteralExpression(inner))
		? inner
		: undefined;
}

/** The node's object literal value, when its annotation, else its outermost type-stating wrapper, states a type. */
export function statedObjectOf(node: ts.Node): ts.ObjectLiteralExpression | undefined {
	const body = memberBodyOf(node);
	if (body === undefined || !ts.isObjectLiteralExpression(body)) return undefined;
	let stated = false;
	for (let current = body.parent; isWrapper(current); current = current.parent) {
		stated = statesType(current) ?? stated;
	}
	const annotation = ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) ? node.type : undefined;
	if (annotation !== undefined) stated = isStatedType(annotation);
	return stated ? body : undefined;
}

/** The closing brace's line when only indentation precedes it; otherwise undefined. */
export function memberInsertLineOf(node: ts.Node, source: ts.SourceFile): number | undefined {
	const closer = memberBodyOf(node)?.getChildren(source).at(-1);
	if (closer === undefined || closer.kind !== ts.SyntaxKind.CloseBraceToken || closer.pos === closer.end) {
		return undefined;
	}
	const lineOf = (offset: number) => source.getLineAndCharacterOfPosition(offset).line;
	// Its `pos` is the previous token's end, and its trivia holds any comment before it.
	const comments = [
		...(ts.getTrailingCommentRanges(source.text, closer.pos) ?? []),
		...(ts.getLeadingCommentRanges(source.text, closer.pos) ?? []),
	];
	const before = Math.max(closer.pos, ...comments.map((comment) => comment.end));
	const line = lineOf(closer.getStart(source));
	return lineOf(before - 1) < line ? line : undefined;
}

/** The nodes between a declaration and the members it owns: object types, an object value and its wrappers. */
export function passesReach(node: ts.Node): boolean {
	return (
		ts.isTypeLiteralNode(node) ||
		partsOf(node) !== undefined ||
		ts.isObjectLiteralExpression(node) ||
		isWrapper(node)
	);
}
