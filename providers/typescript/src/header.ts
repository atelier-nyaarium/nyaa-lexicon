// A declaration's header spans, handed to the protocol's one renderer.

import { type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

interface Cuts {
	folds: OffsetRange[];
	omit: OffsetRange[];
	verbatim: OffsetRange[];
}

////////////////////////////////
//  Functions & Helpers

function openBrace(node: ts.Node, source: ts.SourceFile): number | undefined {
	return node
		.getChildren(source)
		.find((child) => child.kind === ts.SyntaxKind.OpenBraceToken)
		?.getStart(source);
}

/** Where the body opens; undefined when the declaration has none. */
function bodyStart(node: ts.Node, source: ts.SourceFile): number | undefined {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isFunctionExpression(node)
	) {
		return node.body?.getStart(source);
	}
	if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
		return openBrace(node, source);
	}
	if (ts.isModuleDeclaration(node)) {
		let body = node.body;
		while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
		return body?.getStart(source);
	}
	return undefined;
}

/** Whose own type literals list as its members, so the header folds them. */
function foldsTypes(node: ts.Node): boolean {
	return (
		ts.isTypeAliasDeclaration(node) ||
		ts.isPropertyDeclaration(node) ||
		ts.isPropertySignature(node) ||
		ts.isVariableDeclaration(node)
	);
}

function isLiteral(node: ts.Node): boolean {
	return (
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isRegularExpressionLiteral(node) ||
		ts.isTemplateHead(node) ||
		ts.isTemplateMiddle(node) ||
		ts.isTemplateTail(node)
	);
}

/** Its span when it folds whole: a literal container, or a type literal where types fold. */
function foldedWhole(node: ts.Node, types: boolean, source: ts.SourceFile): OffsetRange | undefined {
	const folds =
		ts.isObjectLiteralExpression(node) ||
		ts.isArrayLiteralExpression(node) ||
		(types && (ts.isTypeLiteralNode(node) || ts.isMappedTypeNode(node)));
	return folds ? { start: node.getStart(source), end: node.getEnd() } : undefined;
}

/** Where its own body folds from: a function value's block, or a class expression's members. */
function foldedFrom(node: ts.Node, source: ts.SourceFile): number | undefined {
	if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isBlock(node.body)) {
		return node.body.getStart(source);
	}
	return ts.isClassExpression(node) ? openBrace(node, source) : undefined;
}

/** Folds, comments and literals within `span`, in one walk that never enters a fold. */
function collectCuts(node: ts.Node, types: boolean, span: OffsetRange, source: ts.SourceFile, cuts: Cuts): void {
	if (node.pos >= span.end || node.end <= span.start) return;
	if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
	const whole = foldedWhole(node, types, source);
	if (whole !== undefined) {
		cuts.folds.push(whole);
		return;
	}
	if (ts.isToken(node)) {
		const ranges = [
			...(ts.getLeadingCommentRanges(source.text, node.pos) ?? []),
			...(ts.getTrailingCommentRanges(source.text, node.pos) ?? []),
		];
		for (const range of ranges) {
			if (range.pos >= span.start && range.end <= span.end) cuts.omit.push({ start: range.pos, end: range.end });
		}
		if (isLiteral(node)) cuts.verbatim.push({ start: node.getStart(source), end: node.getEnd() });
		return;
	}
	const from = foldedFrom(node, source);
	if (from !== undefined) cuts.folds.push({ start: from, end: node.getEnd() });
	// Signature types stay whole.
	const inner = types && !ts.isParameter(node) && !ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node);
	for (const child of node.getChildren(source)) {
		if (from === undefined || child.end <= from) collectCuts(child, inner, span, source, cuts);
	}
}

/**
 * Header on one line, from the first token (decorators included) to the body.
 * A variable leads with its statement's `export const`, then its own declarator alone.
 */
export function headerOf(node: ts.Node, source: ts.SourceFile): string | undefined {
	const cuts: Cuts = { folds: [], omit: [], verbatim: [] };
	if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
		const lead = { start: node.parent.parent.getStart(source), end: node.parent.declarations.pos };
		const own = { start: node.getStart(source), end: node.getEnd() };
		collectCuts(node.parent.parent, false, lead, source, cuts);
		collectCuts(node, true, own, source, cuts);
		return renderHeader(source.text, { lead, ...own, ...cuts });
	}
	const span = { start: node.getStart(source), end: bodyStart(node, source) ?? node.getEnd() };
	collectCuts(node, foldsTypes(node), span, source, cuts);
	return renderHeader(source.text, { ...span, ...cuts });
}
