// Walks over a C++ token list: significant neighbors, matched delimiters and statement ends.

import { angleDelta, defined, type Metrics, type Range } from "@nyaa-lexicon/protocol";
import type { Token } from "./tokens.js";
import { isSignificant } from "./tokens.js";

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

export function joinTokens(tokens: Token[], startIndex: number, endIndex: number): string {
	let output = "";
	let previous = "";
	const noSpaceBefore = new Set([",", ";", ")", "]", "}", ">", "::", ".", "->", "->*"]);
	const noSpaceAfter = new Set(["(", "[", "{", "<", "::", ".", "->", "->*"]);
	for (let index = startIndex; index < endIndex; index++) {
		const token = tokenAt(tokens, index);
		if (token === undefined || !isSignificant(token)) continue;
		if (output !== "" && !noSpaceBefore.has(token.text) && !noSpaceAfter.has(previous)) output += " ";
		output += token.text;
		previous = token.text;
	}
	return output.trim();
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
		const token = tokenAt(tokens, index);
		if (token === undefined) return -1;
		if (token.text === open) depth++;
		if (token.text === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

export function matchingAngle(tokens: Token[], openIndex: number, limit = tokens.length): number {
	let depth = 0;
	let guard = -1;
	for (let index = openIndex; index < limit; index++) {
		if (index <= guard) throw new Error("angle scan failed to advance");
		guard = index;
		const value = tokenAt(tokens, index)?.text;
		depth += angleDelta(value ?? "");
		if (depth === 0) return index;
		if (value === ";" || value === "{") return -1;
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
		const value = tokenAt(tokens, index)?.text;
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

export function bodyMetrics(tokens: Token[], startIndex: number, endIndex: number, parameterCount?: number): Metrics {
	let nesting = 0;
	let deepest = 0;
	let branches = 1;
	for (let index = startIndex; index < endIndex; index++) {
		const value = tokenAt(tokens, index)?.text;
		if (value === "{") {
			nesting++;
			deepest = Math.max(deepest, nesting);
		}
		if (value === "}") nesting = Math.max(0, nesting - 1);
		if (
			value === "if" ||
			value === "for" ||
			value === "while" ||
			value === "case" ||
			value === "catch" ||
			value === "?" ||
			value === "&&" ||
			value === "||"
		)
			branches++;
	}
	const start = tokenAt(tokens, startIndex);
	const end = tokenAt(tokens, endIndex - 1);
	const lines = start === undefined || end === undefined ? 1 : end.end.line - start.start.line + 1;
	return {
		lines: Math.max(1, lines),
		...defined({ parameters: parameterCount }),
		nesting: deepest,
		branches,
	};
}
