// Type text: canonical spellings, inferred expression types and literal values.

import { angleDelta, type Descriptor } from "@nyaa-lexicon/protocol";
import type { DraftRecord, DraftType } from "./model.js";
import type { Token } from "./tokens.js";
import { isSignificant } from "./tokens.js";
import { joinTokens, significantAfter, tokenAt } from "./tokenWalk.js";
import { FUNCTION_QUALIFIERS, INTEGRAL_WORDS } from "./words.js";

////////////////////////////////
//  Functions & Helpers

/** One spelling per integral type, so `unsigned` and `unsigned int` name one overload. */
export function foldIntegral(words: string[]): string[] {
	if (words.includes("double") || !words.some((word) => INTEGRAL_WORDS.has(word))) return words;
	const has = (word: string) => words.includes(word);
	const longs = words.filter((word) => word === "long").length;
	let type: string;
	if (has("char")) type = has("unsigned") ? "unsigned char" : has("signed") ? "signed char" : "char";
	else {
		const size = has("short") ? "short" : longs >= 2 ? "long long" : longs === 1 ? "long" : "int";
		type = has("unsigned") ? `unsigned ${size}` : size;
	}
	return [type, ...words.filter((word) => !INTEGRAL_WORDS.has(word))];
}

/**
 * Overload identity, never shown: each parameter's type with its name and default argument
 * dropped, then the function's cv and ref qualifiers.
 */
export function canonicalParameterSignature(tokens: Token[], startIndex: number, endIndex: number): string {
	const parts: string[] = [];
	let part: number[] = [];
	let parentheses = 0;
	let brackets = 0;
	let angles = 0;
	const flush = () => {
		const assign = part.findIndex((index) => tokenAt(tokens, index)?.text === "=");
		const indexes = assign < 0 ? part : part.slice(0, assign);
		if (indexes.length > 1) {
			const last = indexes.at(-1) as number;
			const before = indexes.at(-2) as number;
			if (tokenAt(tokens, last)?.kind === "identifier" && tokenAt(tokens, before)?.text !== "::") indexes.pop();
		}
		if (indexes.length > 0)
			parts.push(foldIntegral(indexes.map((index) => tokenAt(tokens, index)?.text ?? "")).join(" "));
		part = [];
	};
	for (let index = startIndex; index < endIndex; index++) {
		const token = tokenAt(tokens, index);
		if (token === undefined || !isSignificant(token)) continue;
		const value = token.text;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else angles += angleDelta(value);
		if (value === "," && parentheses === 0 && brackets === 0 && angles === 0) flush();
		else part.push(index);
	}
	flush();
	return parts.join(",");
}

export function functionQualifiers(tokens: Token[], startIndex: number, endIndex: number): string {
	const found: string[] = [];
	for (let index = startIndex; index < endIndex; index++) {
		const value = tokenAt(tokens, index)?.text;
		if (value === "{" || value === ";" || value === "=" || value === "->") break;
		if (value !== undefined && FUNCTION_QUALIFIERS.has(value)) found.push(value);
	}
	return found.join(" ");
}

export function namePath(record: DraftRecord | null): Descriptor[] {
	if (record === null) return [];
	return [...namePath(record.parent), ...(record.qualifier ?? []), record.own];
}

export function formatType(tokens: Token[], indexes: number[]): string {
	const filtered = indexes.filter((index) => {
		const value = tokenAt(tokens, index)?.text;
		return (
			value !== "const" &&
			value !== "volatile" &&
			value !== "static" &&
			value !== "constexpr" &&
			value !== "inline"
		);
	});
	if (filtered.length === 0) return "";
	const first = filtered[0] as number;
	const last = (filtered.at(-1) as number) + 1;
	return joinTokens(tokens, first, last);
}

export function isAutoType(typeText: string): boolean {
	return typeText === "auto" || typeText.startsWith("decltype(auto)");
}

export function inferExpressionType(tokens: Token[], startIndex: number, endIndex: number): string | null {
	let current = startIndex;
	while (current < endIndex && !isSignificant(tokenAt(tokens, current) as Token)) current++;
	const token = tokenAt(tokens, current);
	if (token === undefined) return null;
	if (token.kind === "string") return "const char*";
	if (token.kind === "number") return /[.eE]/.test(token.text) ? "double" : "int";
	if (token.value === "true" || token.value === "false") return "bool";
	if (token.value === "new") {
		const next = significantAfter(tokens, current, endIndex);
		const name = tokenAt(tokens, next);
		return name === undefined ? null : `${name.value}*`;
	}
	return null;
}

export function draftTypeFor(
	typeText: string,
	tokens: Token[],
	initializerStart: number,
	initializerEnd: number,
): DraftType | undefined {
	if (typeText === "") return undefined;
	if (isAutoType(typeText)) {
		const inferred = inferExpressionType(tokens, initializerStart, initializerEnd);
		return inferred === null
			? { status: "unknown", reason: "NotImplemented", detail: "the initializer type is not inferred" }
			: { status: "inferred", display: inferred, basis: "initializer expression" };
	}
	return { status: "known", display: typeText };
}

////////////////////////////////
//  Constants

export const INTEGER_LITERAL = /^(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|0[0-7]*|[1-9][0-9]*)$/;

export const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

////////////////////////////////
//  Functions & Helpers

export function decodeNumberLiteral(text: string): number | undefined {
	const normalized = text.replaceAll("'", "");
	const integerText = normalized.replace(/[uUlL]+$/, "");
	if (INTEGER_LITERAL.test(integerText)) {
		try {
			const integer = /^0[0-7]+$/.test(integerText) ? BigInt(`0o${integerText.slice(1)}`) : BigInt(integerText);
			return integer <= MAX_SAFE_INTEGER_BIGINT ? Number(integer) : undefined;
		} catch {
			return undefined;
		}
	}
	const number = Number(normalized);
	return Number.isFinite(number) ? number : undefined;
}

export function unknownTemplateType(detail: string): DraftType {
	return { status: "unknown", reason: "NotImplemented", detail };
}
