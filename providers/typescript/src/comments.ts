// Comment spans, read from the compiler's own trivia scanner.
//
// Never a marker search: `//` inside a string, a template or a regex is not a comment, and only a
// real tokenizer knows the difference.

import type { CommentSpan } from "@nyaa-lexicon/protocol";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/** Taken from the facts it rides in: the protocol barrel does not export the span type itself. */
export type { CommentSpan };

////////////////////////////////
//  Functions & Helpers

/** A doc comment parses into nodes, but its span is comment text rather than tokens. */
function isDocNode(node: ts.Node): boolean {
	return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/** Walks to every token, whose `pos` opens the trivia run that ends where the token starts. */
function visitTokens(node: ts.Node, source: ts.SourceFile, onToken: (position: number) => void): void {
	if (isDocNode(node)) return;
	if (ts.isToken(node)) {
		onToken(node.pos);
		return;
	}
	for (const child of node.getChildren(source)) visitTokens(child, source, onToken);
}

////////////////////////////////
//  Extraction

/**
 * Every comment the language defines, verbatim and in source order.
 *
 * Whether a span is prose is core's question. Dropping an interpreter line or a commented-out
 * statement here would hide it from the only layer that can decide.
 */
export function extractComments(source: ts.SourceFile): CommentSpan[] {
	const text = source.text;
	const spans = new Map<number, CommentSpan>();

	// Keyed by start: one comment is reached from both sides of its token gap, and is one fact.
	const add = (start: number, end: number): void => {
		spans.set(start, {
			range: {
				start: source.getLineAndCharacterOfPosition(start),
				end: source.getLineAndCharacterOfPosition(end),
			},
			text: text.slice(start, end),
		});
	};

	// Both range scans step over shebang trivia, so it is taken from the text.
	const shebang = ts.getShebang(text);
	if (shebang !== undefined) add(0, shebang.length);

	visitTokens(source, source, (position) => {
		// Trailing covers the rest of this line, leading everything past the first break.
		for (const range of ts.getTrailingCommentRanges(text, position) ?? []) add(range.pos, range.end);
		for (const range of ts.getLeadingCommentRanges(text, position) ?? []) add(range.pos, range.end);
	});

	return [...spans.entries()].sort(([left], [right]) => left - right).map(([, span]) => span);
}
