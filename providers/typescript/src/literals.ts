// Literal values, each with the declaration holding it.

import type { Literal } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { isDynamicImport } from "./imports.js";
import { rangeOf } from "./ranges.js";

////////////////////////////////
//  Functions & Helpers

function containerIdOf(node: ts.Node, declarationNodes: Map<ts.Node, string>): string | undefined {
	let current: ts.Node | undefined = node;
	while (current !== undefined) {
		const id = declarationNodes.get(current);
		if (id !== undefined) return id;
		current = current.parent;
	}
	return undefined;
}

function isImportSpecifier(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
	const parent = node.parent;
	if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) {
		return true;
	}
	if (ts.isExternalModuleReference(parent)) return true;
	return ts.isCallExpression(parent) && isDynamicImport(parent) && parent.arguments[0] === node;
}

export function literalOf(
	node: ts.Node,
	source: ts.SourceFile,
	declarationNodes: Map<ts.Node, string>,
): Literal | undefined {
	let literal: Literal | undefined;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		if (isImportSpecifier(node)) return undefined;
		literal = { kind: "string", value: node.text, range: rangeOf(node, source) };
	} else if (ts.isTemplateHead(node) || ts.isTemplateMiddleOrTemplateTail(node)) {
		// A template's text parts, one literal each; the substitutions between them are not text.
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
