// What a node declares: its kind, its names, its visibility and where it runs.

import type { Declaration, Descriptor } from "@nyaa-lexicon/protocol";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/** One name a binding declares, and the node declaring it. */
interface NameBinding<T extends ts.ParameterDeclaration | ts.VariableDeclaration> {
	name: ts.Identifier;
	node: T | ts.BindingElement;
}

export interface Classified {
	kind: Declaration["kind"];
	descriptor: Descriptor["kind"];
	languageKind?: string;
}

////////////////////////////////
//  Functions & Helpers

/** Reach, mapped onto the protocol's vocabulary rather than TypeScript's keywords. */
export function visibilityOf(node: ts.Node, exported: boolean): Declaration["visibility"] {
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

export function isExported(node: ts.Node): boolean {
	const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
	return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

////////////////////////////////
//  Declarations

/** What kind a node is, and which descriptor its id carries. Null means we do not report it. */
export function classify(node: ts.Node): Classified | null {
	if (ts.isClassDeclaration(node)) return { kind: "class", descriptor: "type" };
	if (ts.isInterfaceDeclaration(node)) return { kind: "interface", descriptor: "type" };
	if (ts.isTypeAliasDeclaration(node)) return { kind: "interface", descriptor: "type", languageKind: "typeAlias" };
	if (ts.isEnumDeclaration(node)) return { kind: "enum", descriptor: "type" };
	if (ts.isModuleDeclaration(node)) {
		return { kind: ts.isStringLiteral(node.name) ? "module" : "namespace", descriptor: "namespace" };
	}
	if (ts.isFunctionDeclaration(node)) return { kind: "function", descriptor: "method" };
	if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return { kind: "method", descriptor: "method" };
	if (ts.isConstructorDeclaration(node)) return { kind: "constructor", descriptor: "method" };
	if (ts.isClassStaticBlockDeclaration(node)) {
		return { kind: "constructor", descriptor: "method", languageKind: "staticBlock" };
	}
	if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
		return { kind: "property", descriptor: "term" };
	}
	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return { kind: "property", descriptor: "term" };
	if (ts.isEnumMember(node)) return { kind: "constant", descriptor: "term" };
	return null;
}

export function anonymousDefaultExportOf(node: ts.Node): Classified | undefined {
	if (ts.isClassDeclaration(node) && node.name === undefined && hasDefaultModifier(node)) {
		return { kind: "class", descriptor: "type" };
	}
	if (ts.isFunctionDeclaration(node) && node.name === undefined && hasDefaultModifier(node)) {
		return { kind: "function", descriptor: "method" };
	}
	if (ts.isExportAssignment(node)) {
		if (ts.isClassExpression(node.expression)) return { kind: "class", descriptor: "type" };
		if (ts.isFunctionExpression(node.expression)) return { kind: "function", descriptor: "method" };
		return { kind: "variable", descriptor: "term" };
	}
	return undefined;
}

/** Excludes bodyless signatures and function types. */
export function isRunningBody(node: ts.Node): boolean {
	return (
		(ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node) ||
			ts.isClassStaticBlockDeclaration(node)) &&
		node.body !== undefined
	);
}

/** A `for`, `for in` or `for of` head declaring its variables. */
export function loopHeadOf(node: ts.Node): ts.VariableDeclarationList | undefined {
	const initializer =
		ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
			? node.initializer
			: undefined;
	return initializer !== undefined && ts.isVariableDeclarationList(initializer) ? initializer : undefined;
}

/** Under `declare`, or in a declaration file. */
function isAmbient(node: ts.Node): boolean {
	for (let current: ts.Node = node; !ts.isSourceFile(current); current = current.parent) {
		const modifiers = ts.canHaveModifiers(current) ? (ts.getModifiers(current) ?? []) : [];
		if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
	}
	return node.getSourceFile().isDeclarationFile;
}

/** A global script exports every declaration; an ambient namespace, every member unless it names its exports. */
export function exportsImplicitly(node: ts.Node): boolean {
	if (ts.isSourceFile(node)) return isGlobalScript(node);
	return (
		ts.isModuleBlock(node) &&
		!node.statements.some((statement) => ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) &&
		isAmbient(node)
	);
}

/** `declare global` or `declare module "x"`: what it declares reaches other files unimported. */
export function isGlobalBlock(node: ts.Node): boolean {
	return (
		ts.isModuleDeclaration(node) &&
		(ts.isStringLiteral(node.name) || (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0)
	);
}

/** No import or export, and no extension or CommonJS use making it a module: its declarations are global. */
function isGlobalScript(source: ts.SourceFile): boolean {
	if (ts.isExternalModule(source) || /\.[cm][jt]s$/.test(source.fileName)) return false;
	return !/\.jsx?$/.test(source.fileName) || !usesCommonJs(source);
}

/** `require("x")`, `module.exports` or `exports.x`, which make JavaScript a CommonJS module. */
function usesCommonJs(node: ts.Node): boolean {
	if (ts.isCallExpression(node)) {
		const [argument] = node.arguments;
		const callee = node.expression;
		if (
			ts.isIdentifier(callee) &&
			callee.text === "require" &&
			argument !== undefined &&
			ts.isStringLiteral(argument)
		) {
			return true;
		}
	}
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
		const { text } = node.expression;
		if (text === "exports" || (text === "module" && node.name.text === "exports")) return true;
	}
	return ts.forEachChild(node, usesCommonJs) === true;
}

function hasDefaultModifier(node: ts.Node): boolean {
	return ts.canHaveModifiers(node)
		? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
		: false;
}

export function nameOf(node: ts.Node): string | null {
	if (ts.isClassStaticBlockDeclaration(node)) return "static";
	const name = (node as { name?: ts.Node }).name;
	if (name === undefined) return ts.isConstructorDeclaration(node) ? "constructor" : null;
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text || null;
	return null;
}

export function boundNames<T extends ts.ParameterDeclaration | ts.VariableDeclaration>(holder: T): NameBinding<T>[] {
	const bindings: NameBinding<T>[] = [];
	function visit(name: ts.BindingName, node: T | ts.BindingElement): void {
		if (ts.isIdentifier(name)) {
			bindings.push({ name, node });
			return;
		}
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) visit(element.name, element);
		}
	}
	visit(holder.name, holder);
	return bindings;
}
