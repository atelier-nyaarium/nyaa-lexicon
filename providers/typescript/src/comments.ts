// Comment spans and blank lines from the compiler's trivia scanner and token tree.
//
// Never a marker search: `//` inside a string, a template or a regex is not a comment, and only a
// real tokenizer knows the difference.

import type { CommentSpan } from "@nyaa-lexicon/protocol";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/** Taken from the facts it rides in: the protocol barrel does not export the span type itself. */
export type { CommentSpan };

/** A file's comments, and the lines no token touches. */
export interface Trivia {
	comments: CommentSpan[];
	blankLines: number[];
}

/** UTF-16 offsets, end exclusive. */
interface Span {
	start: number;
	end: number;
}

////////////////////////////////
//  Functions & Helpers

/** A doc comment parses into nodes, but its span is comment text rather than tokens. */
function isDocNode(node: ts.Node): boolean {
	return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/** Every token in source order; its `pos` opens the trivia run that ends where it starts. */
function visitTokens(node: ts.Node, source: ts.SourceFile, onToken: (token: ts.Node) => void): void {
	if (isDocNode(node)) return;
	if (ts.isToken(node)) {
		onToken(node);
		return;
	}
	for (const child of node.getChildren(source)) visitTokens(child, source, onToken);
}

/** Its span when read as code: never the end of file, a missing token or JSX layout whitespace. */
function codeSpanOf(token: ts.Node, source: ts.SourceFile): Span | undefined {
	if (ts.isJsxText(token) && token.containsOnlyTriviaWhiteSpaces) return undefined;
	const start = token.getStart(source);
	return start < token.end ? { start, end: token.end } : undefined;
}

/** The nearest code on each side decides; code is in order and never overlaps a comment. */
function commentsOf(source: ts.SourceFile, spans: readonly Span[], code: readonly Span[]): CommentSpan[] {
	const lineOf = (offset: number) => source.getLineAndCharacterOfPosition(offset).line;
	let next = 0;
	return spans.map((span) => {
		while (next < code.length && (code[next] as Span).end <= span.start) next++;
		const before = code[next - 1];
		const after = code[next];
		return {
			range: {
				start: source.getLineAndCharacterOfPosition(span.start),
				end: source.getLineAndCharacterOfPosition(span.end),
			},
			text: source.text.slice(span.start, span.end),
			codeBefore: before !== undefined && lineOf(before.end - 1) === lineOf(span.start),
			codeAfter: after !== undefined && lineOf(after.start) === lineOf(span.end - 1),
		};
	});
}

/** A trailing newline does not add an extra line. */
function blankLinesOf(source: ts.SourceFile, spans: readonly Span[]): number[] {
	const starts = source.getLineStarts();
	const count = starts.length - (starts.at(-1) === source.text.length ? 1 : 0);
	const touched = new Array<boolean>(count).fill(false);
	for (const span of spans) {
		const last = source.getLineAndCharacterOfPosition(span.end - 1).line;
		for (let line = source.getLineAndCharacterOfPosition(span.start).line; line <= last; line++) {
			touched[line] = true;
		}
	}
	return touched.flatMap((held, line) => (held ? [] : [line]));
}

////////////////////////////////
//  Extraction

/**
 * Every comment the language defines, verbatim and in source order, and the blank lines between.
 *
 * Whether a span is prose is core's question. Dropping an interpreter line or a commented-out
 * statement here would hide it from the only layer that can decide.
 */
export function extractTrivia(source: ts.SourceFile): Trivia {
	const text = source.text;
	// Keyed by start: one comment is reached from both sides of its token gap, and is one fact.
	const found = new Map<number, number>();
	const code: Span[] = [];

	// Both range scans step over shebang trivia, so it is taken from the text.
	const shebang = ts.getShebang(text);
	if (shebang !== undefined) found.set(0, shebang.length);

	visitTokens(source, source, (token) => {
		const span = codeSpanOf(token, source);
		if (span !== undefined) code.push(span);
		// JSX text opens where its tag closes, so it has no trivia to scan.
		if (ts.isJsxText(token)) return;
		// Trailing covers the rest of this line, leading everything past the first break.
		for (const range of ts.getTrailingCommentRanges(text, token.pos) ?? []) found.set(range.pos, range.end);
		for (const range of ts.getLeadingCommentRanges(text, token.pos) ?? []) found.set(range.pos, range.end);
	});

	const spans = [...found.entries()].sort(([left], [right]) => left - right).map(([start, end]) => ({ start, end }));
	return { comments: commentsOf(source, spans, code), blankLines: blankLinesOf(source, [...spans, ...code]) };
}
