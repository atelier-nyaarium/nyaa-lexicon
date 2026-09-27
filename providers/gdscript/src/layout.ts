// Owns the layout facts core decides from: comment trivia, blank lines, and member insertion lines.

import type { CommentSpan, TextCoordinates } from "@nyaa-lexicon/protocol";
import type { DeclarationFact, ReferenceToken } from "./parse-model.js";
import { type ScannedSource, scanSource } from "./source-scan.js";
import { matchingReferenceToken, nextReferenceToken, previousReferenceToken, referenceTokens } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** One logical line: a newline inside brackets or after a backslash continues it. */
interface Statement {
	line: number;
	/** Last token's last line. */
	lastLine: number;
	/** First token's column; Godot refuses mixed indentation, so columns compare. */
	indent: number;
}

export interface Layout {
	comments: CommentSpan[];
	blankLines: number[];
}

////////////////////////////////
//  Constants

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

////////////////////////////////
//  Functions & Helpers

/** A string's closing line, else the token's own. */
function lastLineOf(token: ReferenceToken): number {
	return token.string?.end.line ?? token.line;
}

function isContinuation(token: ReferenceToken | undefined): boolean {
	return token?.kind === "symbol" && token.value === "\\";
}

/** Comments are masked out of the tokens, so every token but a newline is code. */
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
export function blankLinesOf(scanned: ScannedSource, tokens: readonly ReferenceToken[]): number[] {
	const touched = new Set<number>();
	for (const token of codeTokens(tokens)) {
		for (let line = token.line; line <= lastLineOf(token); line++) touched.add(line);
	}
	for (const comment of scanned.comments) touched.add(comment.range.start.line);
	// An unterminated string yields no token.
	for (const line of scanned.lines) if (line.hasString) touched.add(line.line);
	return scanned.lines.filter((line) => !touched.has(line.line)).map((line) => line.line);
}

/** GDScript has one comment form: `#` to end of line, and no block comment. */
export function extractLayoutCore(text: string): Layout {
	const scanned = scanSource(text);
	const tokens = referenceTokens(scanned);
	return { comments: commentTrivia(scanned.comments, tokens), blankLines: blankLinesOf(scanned, tokens) };
}

/** Logical lines, and each code token's statement index. */
function statementsOf(tokens: readonly ReferenceToken[]): { statements: Statement[]; owner: Map<number, number> } {
	const statements: Statement[] = [];
	const owner = new Map<number, number>();
	let depth = 0;
	let open: Statement | null = null;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind === "newline") {
			if (open !== null && depth === 0 && !isContinuation(tokens[index - 1])) {
				statements.push(open);
				open = null;
			}
			continue;
		}
		if (OPENERS.has(token.value)) depth++;
		else if (CLOSERS.has(token.value) && depth > 0) depth--;
		if (open === null) open = { line: token.line, lastLine: lastLineOf(token), indent: token.character };
		else open.lastLine = lastLineOf(token);
		owner.set(index, statements.length);
	}
	if (open !== null) statements.push(open);
	return { statements, owner };
}

/** An indented body's last line, or undefined when inline or empty. Indented comments before the dedent count. */
function indentedBodyEnd(
	statements: readonly Statement[],
	header: number,
	indent: number,
	comments: readonly CommentSpan[],
): number | undefined {
	let last: number | undefined;
	let next = header + 1;
	while (next < statements.length && (statements[next] as Statement).indent > indent) {
		last = (statements[next] as Statement).lastLine;
		next++;
	}
	if (last === undefined) return undefined;
	const dedent = statements[next]?.line;
	for (const comment of comments) {
		const line = comment.range.start.line;
		if (comment.codeBefore !== false || line <= last) continue;
		if (dedent !== undefined && line >= dedent) break;
		if (comment.range.start.character > indent) last = line;
	}
	return last;
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
	scanned: ScannedSource,
	tokens: ReferenceToken[],
	coordinates: TextCoordinates,
): DeclarationFact[] {
	const { statements, owner } = statementsOf(tokens);
	const comments = commentTrivia(scanned.comments, tokens);
	const named = new Map<string, number>();
	tokens.forEach((token, index) => {
		if (token.kind === "identifier") named.set(`${token.line}:${token.character}`, index);
	});
	// The line after a body, when the text has one.
	const after = (last: number | undefined): number | undefined =>
		last !== undefined && last + 1 < coordinates.lineCount() ? last + 1 : undefined;
	const insertLine = (declaration: DeclarationFact): number | undefined => {
		if (isRootClass(declaration)) return after(indentedBodyEnd(statements, -1, -1, comments));
		const { line, character } = declaration.selectionRange.start;
		const name = named.get(`${line}:${character}`);
		if (name === undefined) return undefined;
		if (declaration.kind === "enum") return braceInsertLine(tokens, name);
		if (declaration.languageKind !== "innerClass") return undefined;
		const header = owner.get(name);
		if (header === undefined) return undefined;
		return after(indentedBodyEnd(statements, header, (statements[header] as Statement).indent, comments));
	};
	return declarations.map((declaration) => {
		const memberInsertLine = insertLine(declaration);
		return memberInsertLine === undefined ? declaration : { ...declaration, memberInsertLine };
	});
}
