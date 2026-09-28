// Type text: canonical spellings, inferred expression types and literal values.

import type { Descriptor } from "@nyaa-lexicon/protocol";
import { bracketDelta } from "./angles.js";
import type { DraftRecord, DraftType } from "./model.js";
import type { Token } from "./tokens.js";
import { isSignificant } from "./tokens.js";
import { joinType, significantAfter, tokenAt } from "./tokenWalk.js";
import { FUNCTION_QUALIFIERS, INTEGRAL_WORDS } from "./words.js";

////////////////////////////////
//  Constants

/** Words a declared type is shown without. */
const UNTYPED_WORDS: ReadonlySet<string> = new Set(["const", "volatile", "static", "constexpr", "inline"]);

/** `auto` as formatted, bare or under a pointer or reference. */
const AUTO_TYPES: ReadonlySet<string> = new Set(["auto", "auto *", "auto &", "auto &&"]);

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
 * A by-value parameter's type without its top-level `const` and `volatile`, which the function's
 * type drops: after the last `*`, or anywhere without one. A reference, array or function keeps all.
 */
function withoutTopLevelCv(
	tokens: Token[],
	indexes: readonly number[],
	templateBrackets: ReadonlySet<number>,
): number[] {
	let depth = 0;
	let pointer = -1;
	const top: boolean[] = [];
	for (const [at, index] of indexes.entries()) {
		const token = tokenAt(tokens, index);
		const value = token?.text ?? "";
		top.push(depth === 0);
		if (depth === 0 && (value === "&" || value === "&&" || value === "[" || value === "(")) return [...indexes];
		if (depth === 0 && value === "*") pointer = at;
		if (value === "(" || value === "[") depth++;
		else if (value === ")" || value === "]") depth = Math.max(0, depth - 1);
		else depth = Math.max(0, depth + bracketDelta(token, templateBrackets));
	}
	return indexes.filter((index, at) => {
		const value = tokenAt(tokens, index)?.text;
		return !(top[at] === true && at > pointer && (value === "const" || value === "volatile"));
	});
}

/**
 * A parameter's type as overload identity, never shown, its name and default already dropped:
 * top-level cv-qualifiers dropped, integral spellings folded, template parameters by position.
 */
export function canonicalType(
	tokens: Token[],
	indexes: readonly number[],
	templateBrackets: ReadonlySet<number>,
	positions: ReadonlyMap<string, string>,
): string {
	const words = withoutTopLevelCv(tokens, indexes, templateBrackets).map((index) => {
		const token = tokenAt(tokens, index);
		return token?.kind === "identifier" ? (positions.get(token.value) ?? token.text) : (token?.text ?? "");
	});
	return foldIntegral(words).join(" ");
}

export function functionQualifiers(tokens: Token[], startIndex: number, endIndex: number): string {
	const found: string[] = [];
	for (let index = startIndex; index < endIndex; index++) {
		const value = tokenAt(tokens, index)?.text;
		if (value === "{" || value === ";" || value === "=" || value === "->" || value === ":") break;
		if (value !== undefined && FUNCTION_QUALIFIERS.has(value)) found.push(value);
	}
	return found.join(" ");
}

export function namePath(record: DraftRecord | null): Descriptor[] {
	if (record === null) return [];
	return [...namePath(record.parent), ...(record.qualifier ?? []), record.own];
}

/** A declared type from its tokens, cv-qualifiers and storage words left out. */
export function formatType(tokens: Token[], indexes: readonly number[], angles: ReadonlySet<number>): string {
	return joinType(
		tokens,
		indexes.filter((index) => !UNTYPED_WORDS.has(tokenAt(tokens, index)?.text ?? "")),
		angles,
	);
}

/** A placeholder type, `auto` bare or as `auto&`, `auto*` or `auto&&`, or `decltype(auto)`. */
export function isAutoType(typeText: string): boolean {
	return AUTO_TYPES.has(typeText) || typeText.startsWith("decltype(auto)");
}

export function inferExpressionType(tokens: Token[], startIndex: number, endIndex: number): string | null {
	let current = startIndex;
	while (current < endIndex && !isSignificant(tokenAt(tokens, current) as Token)) current++;
	const token = tokenAt(tokens, current);
	if (token === undefined) return null;
	if (token.kind === "string") return "const char*";
	if (token.kind === "number") return numberLiteralType(token.text);
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
		// A pointer or reference to the initializer's type is not its type.
		const inferred = typeText === "auto" ? inferExpressionType(tokens, initializerStart, initializerEnd) : null;
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

function isFloatingLiteral(text: string): boolean {
	return /^0[xX]/.test(text) ? /[pP]/.test(text) : /[.eE]/.test(text);
}

/** The type a number literal names by its form and suffix; null for a size suffix. */
function numberLiteralType(text: string): string | null {
	if (isFloatingLiteral(text)) return /[fF]$/.test(text) ? "float" : /[lL]$/.test(text) ? "long double" : "double";
	const suffix = (/[uUlLzZ]*$/.exec(text)?.[0] ?? "").toLowerCase();
	if (suffix.includes("z")) return null;
	const size = suffix.includes("ll") ? "long long" : suffix.includes("l") ? "long" : "int";
	return suffix.includes("u") ? `unsigned ${size}` : size;
}

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
	const hex = /^0[xX]/.test(normalized);
	if (hex && isFloatingLiteral(normalized)) return decodeHexFloat(normalized);
	const number = Number(!hex && isFloatingLiteral(normalized) ? normalized.replace(/[fFlL]$/, "") : normalized);
	return Number.isFinite(number) ? number : undefined;
}

/** A hexadecimal floating literal's value: `0x1.8p3` is 12. */
function decodeHexFloat(text: string): number | undefined {
	const match = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?[0-9]+)[fFlL]?$/.exec(text);
	const whole = match?.[1] ?? "";
	const fraction = match?.[2] ?? "";
	if (match === null || whole + fraction === "") return undefined;
	const value = (Number.parseInt(whole + fraction, 16) / 16 ** fraction.length) * 2 ** Number(match[3]);
	return Number.isFinite(value) ? value : undefined;
}

export function unknownTemplateType(detail: string): DraftType {
	return { status: "unknown", reason: "NotImplemented", detail };
}
