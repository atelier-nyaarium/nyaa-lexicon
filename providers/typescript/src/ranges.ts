// The ranges a declaration reports: its whole span and its name.

import ts from "typescript";

////////////////////////////////
//  Functions & Helpers

export function rangeOf(node: ts.Node, source: ts.SourceFile) {
	const start = source.getLineAndCharacterOfPosition(node.getStart(source));
	const end = source.getLineAndCharacterOfPosition(node.getEnd());
	return { start, end };
}

export function parameterRangeOf(node: ts.ParameterDeclaration | ts.BindingElement, source: ts.SourceFile) {
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

/**
 * Only the comment block touching the declaration, because leading trivia runs back to the
 * PREVIOUS token: taking its first comment swallows section banners and file headers, which a
 * move would then carry into the destination file.
 */
export function declarationRangeOf(node: ts.Node, source: ts.SourceFile) {
	const comments = ts.getLeadingCommentRanges(source.text, node.pos) ?? [];
	const declarationStart = docCommentStart(source, comments, node.getStart(source));
	const start = source.getLineAndCharacterOfPosition(declarationStart);
	const end = source.getLineAndCharacterOfPosition(node.getEnd());
	return { start, end };
}

/** A blank line ends the block, so what sits above one is the file's rather than the symbol's. */
function docCommentStart(source: ts.SourceFile, comments: readonly ts.CommentRange[], nodeStart: number): number {
	const lineOf = (offset: number) => source.getLineAndCharacterOfPosition(offset).line;
	let start = nodeStart;
	for (let i = comments.length - 1; i >= 0; i--) {
		const comment = comments[i] as ts.CommentRange;
		// Only whitespace lies between, so a skipped line is blank.
		if (lineOf(start) - lineOf(comment.end) > 1) break;
		start = comment.pos;
	}
	return start;
}

export function nameRange(node: ts.Node, source: ts.SourceFile, name: ts.Node | undefined) {
	if (name) return rangeOf(name, source);
	const wanted = ts.isConstructorDeclaration(node)
		? ts.SyntaxKind.ConstructorKeyword
		: ts.isClassStaticBlockDeclaration(node)
			? ts.SyntaxKind.StaticKeyword
			: undefined;
	const keyword = wanted === undefined ? undefined : node.getChildren(source).find((child) => child.kind === wanted);
	return rangeOf(keyword ?? node, source);
}

/** The `default` keyword is the written name; without one there is no name span to claim. */
export function defaultSelectionRange(node: ts.Node, source: ts.SourceFile) {
	const modifier = ts.canHaveModifiers(node)
		? (ts.getModifiers(node) ?? []).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword)
		: undefined;
	const defaultKeyword =
		modifier ?? node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.DefaultKeyword);
	return defaultKeyword === undefined ? undefined : rangeOf(defaultKeyword, source);
}
