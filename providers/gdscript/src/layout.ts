// Owns the layout facts core decides from: comment trivia, blank lines, and member insertion lines.

import type { CommentSpan, TextCoordinates } from "@nyaa-lexicon/protocol";
import { type Blocks, blockHeader, indentedBodyEnd, topLevel } from "./blocks.js";
import type { DeclarationFact, ReferenceToken } from "./parse-model.js";
import {
	type LexedSource,
	matchingReferenceToken,
	nextReferenceToken,
	previousReferenceToken,
	tokenAt,
} from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

export interface Layout {
	comments: CommentSpan[];
	blankLines: number[];
}

////////////////////////////////
//  Functions & Helpers

/** A string's closing line, else the token's own. */
function lastLineOf(token: ReferenceToken): number {
	return token.string?.end.line ?? token.line;
}

/** Comments are not tokens, so every token but a newline is code. */
function codeTokens(tokens: readonly ReferenceToken[]): ReferenceToken[] {
	return tokens.filter((token) => token.kind !== "newline");
}

function precedes(token: ReferenceToken, line: number, character: number): boolean {
	return token.line < line || (token.line === line && token.character < character);
}

/** Each comment with whether a code token shares its first line before it and its last line after it. */
export function commentTrivia(comments: readonly CommentSpan[], tokens: readonly ReferenceToken[]): CommentSpan[] {
	const code = codeTokens(tokens);
	let next = 0;
	return comments.map((comment) => {
		const { line, character } = comment.range.start;
		while (next < code.length && precedes(code[next] as ReferenceToken, line, character)) next++;
		const before = code[next - 1];
		const after = code[next];
		return {
			...comment,
			codeBefore: before !== undefined && lastLineOf(before) === line,
			codeAfter: after !== undefined && after.line === comment.range.end.line,
		};
	});
}

/** Lines no token, string or comment touches. */
export function blankLinesOf(lexed: LexedSource): number[] {
	const touched = new Set<number>();
	for (const token of codeTokens(lexed.tokens)) {
		for (let line = token.line; line <= lastLineOf(token); line++) touched.add(line);
	}
	for (const comment of lexed.comments) touched.add(comment.range.start.line);
	// An unterminated string yields no token.
	for (const line of lexed.lines) if (line.hasString) touched.add(line.line);
	return lexed.lines.filter((line) => !touched.has(line.line)).map((line) => line.line);
}

/** GDScript has one comment form: `#` to end of line, and no block comment. */
export function layoutOf(lexed: LexedSource): Layout {
	return { comments: commentTrivia(lexed.comments, lexed.tokens), blankLines: blankLinesOf(lexed) };
}

/** The closing brace's line when nothing precedes it there. */
function braceInsertLine(tokens: ReferenceToken[], name: number): number | undefined {
	const open = nextReferenceToken(tokens, name);
	if (open < 0 || (tokens[open] as ReferenceToken).value !== "{") return undefined;
	const close = matchingReferenceToken(tokens, open, "{", "}");
	if (close < 0) return undefined;
	const closer = tokens[close] as ReferenceToken;
	const before = tokens[previousReferenceToken(tokens, close)];
	return before !== undefined && lastLineOf(before) < closer.line ? closer.line : undefined;
}

function isRootClass(declaration: DeclarationFact): boolean {
	return declaration.languageKind === "script" || declaration.languageKind === "class_name";
}

/** Containers with the line a member after their last one goes on, where one is safe. */
export function withMemberInsertLines(
	declarations: DeclarationFact[],
	blocks: Blocks,
	coordinates: TextCoordinates,
): DeclarationFact[] {
	const { lexed, statements } = blocks;
	// The line after a body, when the text has one.
	const after = (last: number | undefined): number | undefined =>
		last !== undefined && last + 1 < coordinates.lineCount() ? last + 1 : undefined;
	// Undefined when statement `index` has no indented body.
	const bodyEnd = (index: number, indent: number): number | undefined => {
		const first = statements[index + 1];
		if (first === undefined || first.indent <= indent) return undefined;
		return indentedBodyEnd(blocks, topLevel(blocks, index), indent, first.lastLine);
	};
	const insertLine = (declaration: DeclarationFact): number | undefined => {
		if (isRootClass(declaration)) return after(bodyEnd(-1, -1));
		if (declaration.kind === "enum") {
			const { line, character } = declaration.selectionRange.start;
			const name = tokenAt(lexed, line, character);
			return name < 0 ? undefined : braceInsertLine(lexed.tokens, name);
		}
		if (declaration.languageKind !== "innerClass") return undefined;
		const header = blockHeader(blocks, declaration);
		return header === undefined ? undefined : after(bodyEnd(header.index, header.statement.indent));
	};
	return declarations.map((declaration) => {
		const memberInsertLine = insertLine(declaration);
		return memberInsertLine === undefined ? declaration : { ...declaration, memberInsertLine };
	});
}
