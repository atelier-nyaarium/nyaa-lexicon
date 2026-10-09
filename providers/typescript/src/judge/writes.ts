// What the program assigns, so a walked callee is one nothing replaces, and a value kept is one only seen code changes.

import { hashContent } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import type { PinnedProgram } from "./program.js";

////////////////////////////////
//  Interfaces & Types

export interface Writes {
	/** Declarations of bindings some code assigns beyond their own declarator. */
	readonly bindings: ReadonlySet<ts.Node>;
	/** Declarations of properties some code assigns beyond a sole declaring assignment. */
	readonly properties: ReadonlySet<ts.Node>;
	/** Declarations of properties assigned inside a function or class, or from another module: by code that may run unseen. */
	readonly nested: ReadonlySet<ts.Node>;
	/** Property names assigned where the checker names no property. */
	readonly names: ReadonlySet<string>;
	/** Names written through a receiver that may not be a tracked workspace object. */
	readonly untrackedNames: ReadonlySet<string>;
	/** An untracked receiver had a dynamic or bulk property write. */
	readonly opaqueBuiltinMissing: boolean;
	/** Every module the scan read, with its text's hash: "nothing assigns it" holds only while each is unchanged. */
	readonly sources: ReadonlyArray<{ readonly module: string; readonly contentHash: string }>;
	/** Each scanned module's import specifiers, any form, for what the index's import walk reaches. */
	readonly imports: ReadonlyMap<string, readonly ts.StringLiteralLike[]>;
}

////////////////////////////////
//  Constants

/** Calls that define or replace a named property of their first argument. */
const DEFINERS = new Set(["defineProperty", "set"]);

////////////////////////////////
//  Functions & Helpers

function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isTypeAssertionExpression(current)
	)
		current = current.expression;
	return current;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
	return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Every declaration of a symbol, or none. */
function declarations(symbol: ts.Symbol | undefined): readonly ts.Declaration[] {
	return symbol?.declarations ?? [];
}

function workspaceClass(expression: ts.Expression, pinned: PinnedProgram): boolean {
	const symbol = pinned.checker.getSymbolAtLocation(expression);
	return (
		symbol?.declarations?.some(
			(declaration) =>
				(ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
				pinned.moduleOf(declaration.getSourceFile()) !== null,
		) ?? false
	);
}

function trackedThis(expression: ts.Expression, pinned: PinnedProgram): boolean {
	for (let parent = expression.parent; parent !== undefined; parent = parent.parent) {
		if (ts.isArrowFunction(parent)) continue;
		if (
			ts.isMethodDeclaration(parent) ||
			ts.isGetAccessorDeclaration(parent) ||
			ts.isSetAccessorDeclaration(parent)
		) {
			const owner = parent.parent;
			return (
				(ts.isClassLike(owner) || ts.isObjectLiteralExpression(owner)) &&
				pinned.moduleOf(parent.getSourceFile()) !== null
			);
		}
		if (ts.isFunctionLike(parent)) return false;
	}
	return false;
}

/** Indexes every write in the program's workspace sources, one file per step. */
export function* scanWrites(pinned: PinnedProgram): Generator<undefined, Writes, undefined> {
	const { checker } = pinned;
	const bindings = new Set<ts.Node>();
	const properties = new Set<ts.Node>();
	const nested = new Set<ts.Node>();
	const names = new Set<string>();
	const untrackedNames = new Set<string>();
	let opaqueBuiltinMissing = false;
	/** Functions and classes around the node being visited. */
	let depth = 0;

	const property = (symbol: ts.Symbol | undefined, name: string, write: ts.Node) => {
		const declared = declarations(symbol);
		if (symbol === undefined || declared.length === 0) {
			names.add(name);
			return;
		}
		for (const declaration of declared)
			if (depth > 0 || declaration.getSourceFile() !== write.getSourceFile()) nested.add(declaration);
		// `exports.f = f` and `this.f = f` in JavaScript declare the property they write.
		const declaring = declared.some((declaration) => declaration === write || declaration === write.parent);
		if (declaring && declared.length === 1) return;
		for (const declaration of declared) properties.add(declaration);
	};

	const tracked = (receiver: ts.Expression): boolean => {
		const expression = unwrap(receiver);
		if (expression.kind === ts.SyntaxKind.ThisKeyword) return trackedThis(expression, pinned);
		if (ts.isIdentifier(expression)) {
			return declarations(checker.getSymbolAtLocation(expression)).some(
				(declaration) =>
					ts.isVariableDeclaration(declaration) &&
					ts.isVariableDeclarationList(declaration.parent) &&
					(declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
					declaration.initializer !== undefined &&
					(() => {
						const initializer = unwrap(declaration.initializer);
						return (
							ts.isObjectLiteralExpression(initializer) ||
							ts.isArrayLiteralExpression(initializer) ||
							(ts.isNewExpression(initializer) && workspaceClass(initializer.expression, pinned))
						);
					})(),
			);
		}
		if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
			return tracked(expression.expression);
		return false;
	};
	const untracked = (receiver: ts.Expression): boolean => !tracked(receiver);

	const target = (node: ts.Expression): void => {
		const expression = unwrap(node);
		if (ts.isIdentifier(expression)) {
			const symbol = ts.isShorthandPropertyAssignment(expression.parent)
				? checker.getShorthandAssignmentValueSymbol(expression.parent)
				: checker.getSymbolAtLocation(expression);
			for (const declaration of declarations(symbol)) bindings.add(declaration);
			return;
		}
		if (ts.isPropertyAccessExpression(expression)) {
			if (untracked(expression.expression)) untrackedNames.add(expression.name.text);
			property(checker.getSymbolAtLocation(expression.name), expression.name.text, expression);
			return;
		}
		if (ts.isElementAccessExpression(expression)) {
			const key = unwrap(expression.argumentExpression);
			if (!ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)) {
				if (untracked(expression.expression)) opaqueBuiltinMissing = true;
				return;
			}
			if (untracked(expression.expression)) untrackedNames.add(key.text);
			const type = checker.getTypeAtLocation(expression.expression);
			property(checker.getPropertyOfType(type, key.text), key.text, expression);
			return;
		}
		if (ts.isObjectLiteralExpression(expression)) {
			for (const element of expression.properties) {
				if (ts.isShorthandPropertyAssignment(element)) target(element.name);
				else if (ts.isPropertyAssignment(element)) target(element.initializer);
				else if (ts.isSpreadAssignment(element)) target(element.expression);
			}
			return;
		}
		if (ts.isArrayLiteralExpression(expression)) {
			for (const element of expression.elements) {
				if (ts.isOmittedExpression(element)) continue;
				target(ts.isSpreadElement(element) ? element.expression : element);
			}
			return;
		}
		if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)
			target(expression.left);
	};

	const call = (node: ts.CallExpression): void => {
		const callee = unwrap(node.expression);
		if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return;
		const owner = callee.expression.text;
		const method = callee.name.text;
		const [first, second] = node.arguments;
		if (first === undefined) return;
		if ((owner === "Object" || owner === "Reflect") && DEFINERS.has(method) && second !== undefined) {
			if (untracked(first)) opaqueBuiltinMissing = true;
			const key = unwrap(second);
			if (!ts.isStringLiteralLike(key)) return;
			property(checker.getPropertyOfType(checker.getTypeAtLocation(first), key.text), key.text, node);
			return;
		}
		if (owner === "Object" && (method === "assign" || method === "defineProperties")) {
			if (untracked(first)) opaqueBuiltinMissing = true;
			for (const source of node.arguments.slice(1)) {
				const held = unwrap(source);
				if (!ts.isObjectLiteralExpression(held)) continue;
				for (const element of held.properties) {
					const name = element.name;
					if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) names.add(name.text);
				}
			}
		}
	};

	let specifiers: ts.StringLiteralLike[] = [];
	const visit = (node: ts.Node): void => {
		const specifier = specifierOf(node);
		if (specifier !== undefined) specifiers.push(specifier);
		if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) target(node.left);
		else if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
		)
			target(node.operand);
		else if (
			(ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
			!ts.isVariableDeclarationList(node.initializer)
		)
			target(node.initializer);
		else if (ts.isDeleteExpression(node)) target(node.expression);
		else if (ts.isCallExpression(node)) call(node);
		const enters = ts.isFunctionLike(node) || ts.isClassLike(node);
		if (enters) depth++;
		ts.forEachChild(node, visit);
		if (enters) depth--;
	};

	const sources: Array<{ module: string; contentHash: string }> = [];
	const imports = new Map<string, ts.StringLiteralLike[]>();
	for (const source of pinned.workspaceSources()) {
		specifiers = [];
		visit(source);
		const module = pinned.moduleOf(source);
		if (module !== null) {
			sources.push({ module, contentHash: hashContent(source.text) });
			imports.set(module, specifiers);
		}
		yield;
	}
	return { bindings, properties, nested, names, untrackedNames, opaqueBuiltinMissing, sources, imports };
}

/** A module specifier any import form names: a declaration, `import =`, `require`, `import()` or an import type. */
function specifierOf(node: ts.Node): ts.StringLiteralLike | undefined {
	let held: ts.Node | undefined;
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) held = node.moduleSpecifier;
	else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
		held = node.moduleReference.expression;
	else if (ts.isCallExpression(node)) {
		const callee = node.expression;
		const loads =
			callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
		if (loads) held = node.arguments[0];
	} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) held = node.argument.literal;
	return held !== undefined && ts.isStringLiteralLike(held) ? held : undefined;
}

/** Whether some code assigns the binding or property a declaration names. */
export function isAssigned(writes: Writes, declaration: ts.Node, name: string | undefined): boolean {
	if (writes.bindings.has(declaration) || writes.properties.has(declaration)) return true;
	return name !== undefined && writes.names.has(name) && isMember(declaration);
}

/** A name written through an untyped receiver can replace a member, never a binding. */
function isMember(declaration: ts.Node): boolean {
	return (
		ts.isMethodDeclaration(declaration) ||
		ts.isPropertyDeclaration(declaration) ||
		ts.isPropertyAssignment(declaration) ||
		ts.isShorthandPropertyAssignment(declaration) ||
		ts.isAccessor(declaration) ||
		ts.isBinaryExpression(declaration) ||
		ts.isPropertyAccessExpression(declaration)
	);
}
