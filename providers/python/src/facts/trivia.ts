// Comments and blank lines, read from tokens alone so a file the parser refuses still has them.

import type { CommentSpan } from "@nyaa-lexicon/protocol";
import type { Token, TokenType } from "../syntax/tokenizer.js";
import type { Source } from "./source.js";

////////////////////////////////
//  Constants

const NON_CODE: ReadonlySet<TokenType> = new Set(["INDENT", "DEDENT", "NL", "COMMENT", "NEWLINE", "ENDMARKER"]);
const STRING_OPENERS: ReadonlySet<TokenType> = new Set(["FSTRING_START", "TSTRING_START"]);
const STRING_CLOSERS: ReadonlySet<TokenType> = new Set(["FSTRING_END", "TSTRING_END"]);

////////////////////////////////
//  Functions & Helpers

function isCode(token: Token): boolean {
	return !NON_CODE.has(token.type);
}

/** Last line a token covers; ending at a line's start covers none of it. */
function lastLine(source: Source, token: Token): number {
	if (!token.string.includes("\n")) return token.line;
	const end = source.position(token.end);
	return end.character === 0 && end.line > token.line ? end.line - 1 : end.line;
}

////////////////////////////////
//  Main

export function commentSpans(source: Source): CommentSpan[] {
	const spans: CommentSpan[] = [];
	const tokens = source.tokens;
	let before: Token | undefined;
	let next = 0;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as Token;
		if (isCode(token)) before = token;
		if (token.type !== "COMMENT") continue;
		if (next <= index) next = index + 1;
		while (next < tokens.length && !isCode(tokens[next] as Token)) next++;
		const after = tokens[next];
		spans.push({
			range: source.range(token.pos, token.end),
			text: token.string,
			codeBefore: before !== undefined && lastLine(source, before) === token.line,
			codeAfter: after !== undefined && after.line === token.line,
		});
	}
	return spans;
}

/** Zero-based lines no token touches; null when lexing stopped short. */
export function blankLines(source: Source, complete: boolean): number[] | null {
	const tokens = source.tokens;
	const endmarker = tokens.at(-1);
	if (!complete || endmarker?.type !== "ENDMARKER") return null;
	const touched = new Uint8Array(endmarker.line + 1);
	const touch = (from: number, to: number): void => {
		touched.fill(1, from, to + 1);
	};
	const openers: number[] = [];
	for (const token of tokens) {
		if (STRING_OPENERS.has(token.type)) openers.push(token.line);
		else if (STRING_CLOSERS.has(token.type) && openers.length > 0) {
			touch(openers.pop() as number, lastLine(source, token));
		}
		if (isCode(token) || token.type === "COMMENT") touch(token.line, lastLine(source, token));
	}
	// The end marker opens the line past the last.
	const lines: number[] = [];
	for (let line = 0; line < endmarker.line; line++) if (touched[line] === 0) lines.push(line);
	return lines;
}
