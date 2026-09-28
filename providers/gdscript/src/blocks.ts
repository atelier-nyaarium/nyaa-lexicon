// Owns declaration header and body spans, read from statements.

import type { CommentSpan } from "@nyaa-lexicon/protocol";
import { blockColon, type LogicalLine, logicalLines, type TokenSpan } from "./expression.js";
import type { DeclarationFact, ReferenceToken, SourceLine } from "./parse-model.js";
import { type LexedSource, tokenAt } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** A file's statements, with the statement each token belongs to. */
export interface Blocks {
	lexed: LexedSource;
	statements: LogicalLine[];
	/** Statement index of each token; -1 between statements. */
	owner: Int32Array;
}

export interface BlockHeader {
	/** Statement index. */
	index: number;
	statement: LogicalLine;
	/** Block colon, or -1. */
	colon: number;
	/** After the colon, to the statement's end. */
	inline: TokenSpan;
}

////////////////////////////////
//  Functions & Helpers

export function blocksOf(lexed: LexedSource): Blocks {
	const statements = logicalLines(lexed.tokens, lexed.lines);
	const owner = new Int32Array(lexed.tokens.length).fill(-1);
	statements.forEach((statement, index) => {
		owner.fill(index, statement.start, statement.end);
	});
	return { lexed, statements, owner };
}

/** The statement holding the declared name, and its first unbracketed colon after the name. */
export function blockHeader(
	blocks: Blocks,
	declaration: Pick<DeclarationFact, "selectionRange">,
): BlockHeader | undefined {
	const { start } = declaration.selectionRange;
	const name = tokenAt(blocks.lexed, start.line, start.character);
	const index = name < 0 ? -1 : (blocks.owner[name] ?? -1);
	const statement = blocks.statements[index];
	if (statement === undefined) return undefined;
	const colon = blockColon(blocks.lexed.tokens, statement, name + 1);
	return { index, statement, colon, inline: { start: colon < 0 ? statement.end : colon + 1, end: statement.end } };
}

/** Holds a token besides newlines and continuations. */
export function hasCode(tokens: readonly ReferenceToken[], span: TokenSpan): boolean {
	for (let index = span.start; index < span.end; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "newline" && !(token.kind === "symbol" && token.value === "\\")) return true;
	}
	return false;
}

/** The block colon's line, else the header statement's last. */
export function headerEndLine(blocks: Blocks, declaration: Pick<DeclarationFact, "range" | "selectionRange">): number {
	const header = blockHeader(blocks, declaration);
	if (header === undefined) return declaration.range.end.line;
	return blocks.lexed.tokens[header.colon]?.line ?? header.statement.lastLine;
}

/** First comment starting after `line`. */
function commentAfter(comments: readonly CommentSpan[], line: number): number {
	let low = 0;
	let high = comments.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((comments[middle] as CommentSpan).range.start.line <= line) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** Last line of the body indented past `indent` after statement `index`, its comments included; `last` when empty. */
export function indentedBodyEnd(blocks: Blocks, index: number, indent: number, last: number): number {
	const { lexed, statements } = blocks;
	let end = last;
	let next = index + 1;
	while (next < statements.length && (statements[next] as LogicalLine).indent > indent) {
		end = (statements[next] as LogicalLine).lastLine;
		next++;
	}
	const dedent = statements[next]?.line ?? lexed.lines.length;
	const comments = lexed.comments;
	for (let at = commentAfter(comments, end); at < comments.length; at++) {
		const line = (comments[at] as CommentSpan).range.start.line;
		if (line >= dedent) break;
		if ((lexed.lines[line] as SourceLine).indent > indent) end = line;
	}
	return end;
}

/** Line after the body: an inline tail, or indented statements and the indented comments before the dedent. */
export function bodyEndLine(blocks: Blocks, declaration: Pick<DeclarationFact, "range" | "selectionRange">): number {
	const header = blockHeader(blocks, declaration);
	if (header === undefined) return declaration.range.end.line + 1;
	const { statement } = header;
	if (hasCode(blocks.lexed.tokens, header.inline)) return statement.lastLine + 1;
	return indentedBodyEnd(blocks, header.index, statement.indent, statement.lastLine) + 1;
}
