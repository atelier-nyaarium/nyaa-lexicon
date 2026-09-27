// Which `<` and `>` tokens open and close template lists, based on tokens alone; the rest are
// operators such as comparisons, shifts, or `operator<`.

import { isSignificant, type Token } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** A `<` still waiting for its `>`. */
interface OpenList {
	offset: number;
	/** Parenthesis and bracket depth it opened at; only a `>` at the same depth closes it. */
	depth: number;
	/** Inside a `template <...>` head, where a condition in a default argument is not a comparison. */
	head: boolean;
}

////////////////////////////////
//  Constants

const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

////////////////////////////////
//  Functions & Helpers

function punctuation(token: Token | undefined): string {
	return token?.kind === "punctuation" ? token.text : "";
}

function significantFrom(tokens: readonly Token[], index: number, step: 1 | -1): Token | undefined {
	for (let current = index + step; current >= 0 && current < tokens.length; current += step) {
		const token = tokens[current] as Token;
		if (isSignificant(token)) return token;
	}
	return undefined;
}

/** A name opens a list after it; `operator` names the operator instead. */
function opensList(tokens: readonly Token[], index: number): boolean {
	const before = significantFrom(tokens, index, -1);
	return before?.kind === "identifier" && before.value !== "operator";
}

/** `&&` ending a type, as in `T&&>`, rather than joining conditions. */
function endsType(tokens: readonly Token[], index: number): boolean {
	const next = punctuation(significantFrom(tokens, index, 1));
	return next === ">" || next === ">>" || next === "," || next === "...";
}

/** `||`, an assignment, or `&&` joining conditions: none stands in a template argument unparenthesized. */
function outsideArguments(tokens: readonly Token[], index: number): boolean {
	const value = punctuation(tokens[index]);
	return value === "||" || ASSIGNMENTS.has(value) || (value === "&&" && !endsType(tokens, index));
}

/** The offsets of a `<`, `>` or `>>` token's characters that `angles` holds. */
export function bracketsOf(token: Token, angles: ReadonlySet<number>): number[] {
	const value = punctuation(token);
	if (value !== "<" && value !== ">" && value !== ">>") return [];
	const offsets = value === ">>" ? [token.startOffset, token.startOffset + 1] : [token.startOffset];
	return offsets.filter((offset) => angles.has(offset));
}

/** Template list depth change at a token. */
export function bracketDelta(token: Token | undefined, angles: ReadonlySet<number>): number {
	if (token === undefined) return 0;
	const count = bracketsOf(token, angles).length;
	return punctuation(token) === "<" ? count : -count;
}

/**
 * Marks template bracket offsets, including both halves of a `>>` closing two lists. A list opens
 * after a name, closes at its depth, and is dropped if still open at a boundary. One pass avoids
 * rescanning comparison runs.
 */
export function templateAngles(tokens: readonly Token[], directives: ReadonlySet<number>): Set<number> {
	const angles = new Set<number>();
	const open: OpenList[] = [];
	let depth = 0;
	const drop = (keepHeads: boolean) => {
		for (let top = open.at(-1); top !== undefined && top.depth >= depth; top = open.at(-1)) {
			if (keepHeads && top.head) return;
			open.pop();
		}
	};
	for (let index = 0; index < tokens.length; index++) {
		if (directives.has(index)) continue;
		const token = tokens[index] as Token;
		const value = punctuation(token);
		if (value === "(" || value === "[") depth++;
		else if (value === ")" || value === "]") {
			drop(false);
			depth = Math.max(0, depth - 1);
		} else if (value === ";" || value === "{" || value === "}") drop(false);
		else if (outsideArguments(tokens, index)) drop(true);
		else if (value === "<" && opensList(tokens, index)) {
			const enclosing = open.at(-1);
			const head =
				significantFrom(tokens, index, -1)?.value === "template" ||
				(enclosing?.depth === depth && enclosing.head);
			open.push({ offset: token.startOffset, depth, head });
		} else if (value === ">" || value === ">>") {
			for (let at = 0; at < value.length; at++) {
				const top = open.at(-1);
				if (top === undefined || top.depth !== depth) break;
				open.pop();
				angles.add(top.offset);
				angles.add(token.startOffset + at);
			}
		}
	}
	return angles;
}
