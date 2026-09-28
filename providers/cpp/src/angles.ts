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
	/** Holds `&&` or `||`, so `a < b && c > d` may be comparisons. */
	joined: boolean;
	/** Holds a comma, which no comparison chain does. */
	listed: boolean;
	/** Opened after a name the file declares as a template. */
	named: boolean;
}

/** What the file declares a name as: a template, whose `<` opens a list, or a value, whose never does. */
export type DeclaredName = "template" | "value";

////////////////////////////////
//  Constants

const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

/** What may follow a list's `>`; a comparison's `>` is followed by its operand instead. */
const AFTER_LIST = new Set(["::", ">", ">>", ",", ")", "]", ";", "{", "}", "...", "=", ""]);

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

/** What the unqualified name before the `<` at `index` is declared as; qualified names are other scopes'. */
function declaredBefore(
	tokens: readonly Token[],
	index: number,
	names: ReadonlyMap<string, DeclaredName>,
): DeclaredName | undefined {
	let at = index - 1;
	while (at >= 0 && !isSignificant(tokens[at] as Token)) at--;
	const name = tokens[at];
	const access = punctuation(significantFrom(tokens, at, -1));
	if (name?.kind !== "identifier" || access === "::" || access === "." || access === "->") return undefined;
	return names.get(name.value);
}

/** A name opens a list after it, unless declared a value; `operator` names the operator instead. */
function opensList(tokens: readonly Token[], index: number, names: ReadonlyMap<string, DeclaredName>): boolean {
	const before = significantFrom(tokens, index, -1);
	if (before?.kind !== "identifier" || before.value === "operator") return false;
	return declaredBefore(tokens, index, names) !== "value";
}

/** `&&` ending a type, as in `T&&>`, rather than joining conditions. */
function endsType(tokens: readonly Token[], index: number): boolean {
	const next = punctuation(significantFrom(tokens, index, 1));
	return next === ">" || next === ">>" || next === "," || next === "...";
}

/** `||`, or `&&` joining conditions: legal in a template argument, and the mark of a comparison chain. */
function joinsConditions(tokens: readonly Token[], index: number): boolean {
	const value = punctuation(tokens[index]);
	return value === "||" || (value === "&&" && !endsType(tokens, index));
}

/** What follows a `>`: its punctuation, `operand` for anything else, empty at the end. */
function followerOf(tokens: readonly Token[], index: number): string {
	const next = significantFrom(tokens, index, 1);
	if (next === undefined) return "";
	return next.kind === "punctuation" ? next.text : "operand";
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
 * after a name, closes at its depth, and is dropped if still open at a boundary or an assignment.
 * One joining `&&` or `||` and holding no comma closes as a list only before what may follow one,
 * so `a < b && c > d` stays comparisons. `names` settles what tokens cannot: after a declared
 * value `<` compares, and after a declared template it opens a list whatever follows its `>`.
 * One pass avoids rescanning comparison runs.
 */
export function templateAngles(
	tokens: readonly Token[],
	directives: ReadonlySet<number>,
	names: ReadonlyMap<string, DeclaredName> = new Map(),
): Set<number> {
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
		else if (ASSIGNMENTS.has(value)) drop(true);
		else if (joinsConditions(tokens, index) || value === ",") {
			const top = open.at(-1);
			if (top?.depth === depth && value === ",") top.listed = true;
			else if (top?.depth === depth) top.joined = true;
		} else if (value === "<" && opensList(tokens, index, names)) {
			const enclosing = open.at(-1);
			const before = significantFrom(tokens, index, -1)?.value ?? "";
			const head = before === "template" || (enclosing?.depth === depth && enclosing.head);
			const named = declaredBefore(tokens, index, names) === "template";
			open.push({ offset: token.startOffset, depth, head, joined: false, listed: false, named });
		} else if (value === ">" || value === ">>") {
			for (let at = 0; at < value.length; at++) {
				const top = open.at(-1);
				if (top === undefined || top.depth !== depth) break;
				open.pop();
				// The second half of `>>` follows the first.
				const follower = at + 1 < value.length ? ">" : followerOf(tokens, index);
				if (top.joined && !top.listed && !top.head && !top.named && !AFTER_LIST.has(follower)) break;
				angles.add(top.offset);
				angles.add(token.startOffset + at);
			}
		}
	}
	return angles;
}
