// Walks over a C++ token list: significant neighbors, matched delimiters and statement ends.

import { defined, type Metrics, type Range } from "@nyaa-lexicon/protocol";
import type { Token } from "./tokens.js";
import { isSignificant } from "./tokens.js";

////////////////////////////////
//  Constants

/** Tokens that each add a path through a body. */
const BRANCH_WORDS: ReadonlySet<string> = new Set(["if", "for", "while", "case", "catch", "?", "&&", "||"]);

////////////////////////////////
//  Functions & Helpers

export function significantBefore(tokens: Token[], index: number): number {
	let current = index - 1;
	while (current >= 0 && !isSignificant(tokens[current] as Token)) current--;
	return current;
}

export function significantAfter(tokens: Token[], index: number, limit = tokens.length): number {
	let current = index + 1;
	while (current < limit && !isSignificant(tokens[current] as Token)) current++;
	return current < limit ? current : -1;
}

export function tokenAt(tokens: Token[], index: number): Token | undefined {
	return tokens[index];
}

export function rangeFrom(tokens: Token[], startIndex: number, endIndex: number): Range | null {
	const start = tokenAt(tokens, startIndex);
	const end = tokenAt(tokens, endIndex - 1);
	if (start === undefined || end === undefined) return null;
	return { start: start.start, end: end.end };
}

const NO_SPACE_BEFORE: ReadonlySet<string> = new Set([",", ";", ")", "]", "}", ">", "::", ".", "->", "->*"]);

const NO_SPACE_AFTER: ReadonlySet<string> = new Set(["(", "[", "{", "<", "::", ".", "->", "->*"]);

export function joinTokens(tokens: Token[], startIndex: number, endIndex: number): string {
	let output = "";
	let previous = "";
	for (let index = startIndex; index < endIndex; index++) {
		const token = tokenAt(tokens, index);
		if (token === undefined || !isSignificant(token)) continue;
		if (output !== "" && !NO_SPACE_BEFORE.has(token.text) && !NO_SPACE_AFTER.has(previous)) output += " ";
		output += token.text;
		previous = token.text;
	}
	return output.trim();
}

/** The tokens at `indexes` as one type, tight around the template brackets `angles` holds. */
export function joinType(tokens: Token[], indexes: readonly number[], angles: ReadonlySet<number>): string {
	let output = "";
	let previous: Token | undefined;
	for (const index of indexes) {
		const token = tokenAt(tokens, index);
		if (token === undefined || !isSignificant(token)) continue;
		const bracket = angles.has(token.startOffset);
		const tight =
			previous === undefined ||
			NO_SPACE_BEFORE.has(token.text) ||
			NO_SPACE_AFTER.has(previous.text) ||
			(bracket && token.kind === "punctuation");
		output += tight ? token.text : ` ${token.text}`;
		previous = token;
	}
	return output;
}

/** A token's text as code sees it: empty on a directive's line, whose brackets belong to no statement. */
export function codeText(tokens: readonly Token[], index: number): string {
	const token = tokens[index];
	return token === undefined || token.directive === true ? "" : token.text;
}

export function matching(
	tokens: Token[],
	openIndex: number,
	open: string,
	close: string,
	limit = tokens.length,
): number {
	let depth = 0;
	let guard = -1;
	for (let index = openIndex; index < limit; index++) {
		if (index <= guard) throw new Error("delimiter scan failed to advance");
		guard = index;
		if (tokenAt(tokens, index) === undefined) return -1;
		const value = codeText(tokens, index);
		if (value === open) depth++;
		if (value === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

export function statementEnd(tokens: Token[], startIndex: number, limit: number): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	let guard = -1;
	for (let index = startIndex; index < limit; index++) {
		if (index <= guard) throw new Error("statement scan failed to advance");
		guard = index;
		const value = codeText(tokens, index);
		if (value === "(") parentheses++;
		else if (value === ")") parentheses = Math.max(0, parentheses - 1);
		else if (value === "[") brackets++;
		else if (value === "]") brackets = Math.max(0, brackets - 1);
		else if (value === "{") braces++;
		else if (value === "}") {
			if (braces === 0 && parentheses === 0 && brackets === 0) return index;
			braces = Math.max(0, braces - 1);
		}
		if (value === ";" && parentheses === 0 && brackets === 0 && braces === 0) return index;
	}
	return Math.max(startIndex, limit - 1);
}

////////////////////////////////
//  Classes

/**
 * Metrics for any token span from one pass over the file. Nesting is the deepest brace depth
 * reached, counted from zero at the span's start and never below it, which is the largest rise
 * of the file's running depth within the span.
 */
export class MetricsIndex {
	private readonly branches: Int32Array;

	/** A segment tree over running depths, leaf `i` the depth before token `i`: each node's least. */
	private readonly least: Float64Array;

	/** Each node's greatest depth. */
	private readonly most: Float64Array;

	/** Each node's largest later-minus-earlier rise. */
	private readonly rise: Float64Array;

	private readonly size: number;

	constructor(private readonly tokens: Token[]) {
		const count = tokens.length;
		this.branches = new Int32Array(count + 1);
		const depths = new Int32Array(count + 1);
		for (let index = 0; index < count; index++) {
			const value = codeText(tokens, index);
			this.branches[index + 1] = (this.branches[index] as number) + (BRANCH_WORDS.has(value) ? 1 : 0);
			depths[index + 1] = (depths[index] as number) + (value === "{" ? 1 : value === "}" ? -1 : 0);
		}
		let size = 1;
		while (size < count + 1) size *= 2;
		this.size = size;
		this.least = new Float64Array(2 * size).fill(Number.POSITIVE_INFINITY);
		this.most = new Float64Array(2 * size).fill(Number.NEGATIVE_INFINITY);
		this.rise = new Float64Array(2 * size).fill(Number.NEGATIVE_INFINITY);
		for (let index = 0; index <= count; index++) {
			this.least[size + index] = depths[index] as number;
			this.most[size + index] = depths[index] as number;
			this.rise[size + index] = 0;
		}
		for (let node = size - 1; node >= 1; node--) {
			const left = 2 * node;
			const right = left + 1;
			this.least[node] = Math.min(this.least[left] as number, this.least[right] as number);
			this.most[node] = Math.max(this.most[left] as number, this.most[right] as number);
			this.rise[node] = Math.max(
				this.rise[left] as number,
				this.rise[right] as number,
				(this.most[right] as number) - (this.least[left] as number),
			);
		}
	}

	of(startIndex: number, endIndex: number, parameterCount?: number): Metrics {
		const count = this.tokens.length;
		const from = Math.min(Math.max(0, startIndex), count);
		const to = Math.min(Math.max(from, endIndex), count);
		const start = tokenAt(this.tokens, startIndex);
		const end = tokenAt(this.tokens, endIndex - 1);
		const lines = start === undefined || end === undefined ? 1 : end.end.line - start.start.line + 1;
		return {
			lines: Math.max(1, lines),
			...defined({ parameters: parameterCount }),
			nesting: Math.max(0, this.riseOver(from, to)),
			branches: 1 + (this.branches[to] as number) - (this.branches[from] as number),
		};
	}

	/** The largest rise across running depths `from` through `to`, inclusive. */
	private riseOver(from: number, to: number): number {
		let low = from + this.size;
		let high = to + this.size + 1;
		const nodes: number[] = [];
		const rightNodes: number[] = [];
		while (low < high) {
			if (low % 2 === 1) nodes.push(low++);
			if (high % 2 === 1) rightNodes.push(--high);
			low = Math.floor(low / 2);
			high = Math.floor(high / 2);
		}
		// Left to right, so a rise runs from an earlier depth to a later one.
		let least = Number.POSITIVE_INFINITY;
		let rise = Number.NEGATIVE_INFINITY;
		for (const node of [...nodes, ...rightNodes.reverse()]) {
			rise = Math.max(rise, this.rise[node] as number, (this.most[node] as number) - least);
			least = Math.min(least, this.least[node] as number);
		}
		return rise;
	}
}
