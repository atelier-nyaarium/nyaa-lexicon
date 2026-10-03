// Owns declaration header and body spans, read from statements.

import type { CommentSpan } from "@nyaa-lexicon/protocol";
import {
	type BracketBody,
	blockColon,
	bracketBodies,
	type LogicalLine,
	lambdaBlockColon,
	logicalLines,
	type TokenSpan,
} from "./expression.js";
import type { DeclarationFact, ReferenceToken, SourceLine } from "./parse-model.js";
import { isLineBreak, type LexedSource, tokenAt } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** A file's statements, with the statement each token belongs to. */
export interface Blocks {
	lexed: LexedSource;
	statements: LogicalLine[];
	/** Statement index of each token; -1 between statements. */
	owner: Int32Array;
	/** Block lambdas' bodies inside brackets, each before the bodies inside it. */
	bodies: BracketBody[];
	/** Index of the innermost body holding each token; -1 outside every body. */
	bodyOwner: Int32Array;
}

/** A statement within its list: the file's, or a bracketed lambda body's. */
export interface StatementAt {
	statements: readonly LogicalLine[];
	index: number;
	/** The line ending the list. */
	endLine: number;
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

/** A `;`-separated piece of one statement. */
export interface Segment {
	statement: LogicalLine;
	/** Its last code token. */
	last: number;
	/** A `;` with code after it ends it. */
	separated: boolean;
}

/** Where a block lambda's body sits: indented after its statement, or in a bracket within it. */
export type LambdaBlock = "after" | "inside";

////////////////////////////////
//  Functions & Helpers

export function blocksOf(lexed: LexedSource): Blocks {
	const statements = logicalLines(lexed.tokens, lexed.lines);
	const owner = new Int32Array(lexed.tokens.length).fill(-1);
	statements.forEach((statement, index) => {
		owner.fill(index, statement.start, statement.end);
	});
	const bodies: BracketBody[] = [];
	for (const statement of statements) bracketBodies(lexed.tokens, lexed.lines, statement, bodies);
	const bodyOwner = new Int32Array(lexed.tokens.length).fill(-1);
	bodies.forEach((body, index) => {
		for (const statement of body.statements) bodyOwner.fill(index, statement.start, statement.end);
	});
	return { lexed, statements, owner, bodies, bodyOwner };
}

/** Statement `index` of the file's list; -1 stands before the first. */
export function topLevel(blocks: Blocks, index: number): StatementAt {
	return { statements: blocks.statements, index, endLine: blocks.lexed.lines.length };
}

/** The innermost statement holding `token`. */
export function statementAt(blocks: Blocks, token: number): StatementAt | undefined {
	const body = blocks.bodies[blocks.bodyOwner[token] ?? -1];
	if (body === undefined) {
		const index = blocks.owner[token] ?? -1;
		return index < 0 ? undefined : topLevel(blocks, index);
	}
	const index = body.statements.findIndex((statement) => statement.start <= token && token < statement.end);
	return index < 0 ? undefined : { statements: body.statements, index, endLine: body.endLine };
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
		if (!isLineBreak(tokens[index])) return true;
	}
	return false;
}

/** The block colon's line, else the header statement's last. */
export function headerEndLine(blocks: Blocks, declaration: Pick<DeclarationFact, "range" | "selectionRange">): number {
	const header = blockHeader(blocks, declaration);
	if (header === undefined) return declaration.range.end.line;
	return blocks.lexed.tokens[header.colon]?.line ?? header.statement.lastLine;
}

/** The segment from `name` on; undefined when a bracket around `name` or opened after it does not close inside it. */
export function segmentOf(blocks: Blocks, name: number): Segment | undefined {
	const at = statementAt(blocks, name);
	const statement = at?.statements[at.index];
	if (statement === undefined) return undefined;
	const tokens = blocks.lexed.tokens;
	let depth = 0;
	let last = name;
	for (let index = name + 1; index < statement.end; index++) {
		const token = tokens[index] as ReferenceToken;
		if (isLineBreak(token)) continue;
		const value = token.value;
		if (value === "(" || value === "[" || value === "{") depth++;
		else if (value === ")" || value === "]" || value === "}") {
			if (depth === 0) return undefined;
			depth--;
		} else if (depth === 0 && value === ";") {
			// A trailing `;` ends the statement, not the segment.
			return { statement, last, separated: hasCode(tokens, { start: index + 1, end: statement.end }) };
		}
		last = index;
	}
	return depth === 0 ? { statement, last, separated: false } : undefined;
}

/** The block lambda in the segment from `name` on; `after` when one ends the statement. */
export function lambdaBlockOf(blocks: Blocks, name: number): LambdaBlock | undefined {
	const at = statementAt(blocks, name);
	const statement = at?.statements[at.index];
	if (statement === undefined) return undefined;
	const tokens = blocks.lexed.tokens;
	const own = blocks.bodyOwner[name];
	let depth = 0;
	let inside = false;
	for (let index = name + 1; index < statement.end; index++) {
		if (blocks.bodyOwner[index] !== own) {
			inside = true;
			continue;
		}
		const value = (tokens[index] as ReferenceToken).value;
		if (value === "(" || value === "[" || value === "{") depth++;
		else if (value === ")" || value === "]" || value === "}") depth--;
		else if (depth === 0 && value === ";") break;
		else if (value === "func") {
			const colon = lambdaBlockColon(tokens, index, statement.end);
			if (colon >= 0 && colon + 1 === statement.end) return "after";
		}
	}
	return inside ? "inside" : undefined;
}

/** `token` sits inside a bracket of its file-level statement. */
export function inBracket(blocks: Blocks, token: number): boolean {
	const statement = blocks.statements[blocks.owner[token] ?? -1];
	if (statement === undefined) return false;
	let depth = 0;
	for (let index = statement.start; index < token; index++) {
		const value = (blocks.lexed.tokens[index] as ReferenceToken).value;
		if (value === "(" || value === "[" || value === "{") depth++;
		else if (value === ")" || value === "]" || value === "}") depth--;
	}
	return depth > 0;
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

/** Last line of the body indented past `indent` after statement `at`, its comments included; `last` when empty. */
export function indentedBodyEnd(blocks: Blocks, at: StatementAt, indent: number, last: number): number {
	const { lexed } = blocks;
	const { statements } = at;
	let end = last;
	let next = at.index + 1;
	while (next < statements.length && (statements[next] as LogicalLine).indent > indent) {
		end = (statements[next] as LogicalLine).lastLine;
		next++;
	}
	const dedent = statements[next]?.line ?? at.endLine;
	const comments = lexed.comments;
	for (let index = commentAfter(comments, end); index < comments.length; index++) {
		const line = (comments[index] as CommentSpan).range.start.line;
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
	return indentedBodyEnd(blocks, topLevel(blocks, header.index), statement.indent, statement.lastLine) + 1;
}
