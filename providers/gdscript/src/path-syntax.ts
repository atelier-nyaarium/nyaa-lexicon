// Owns loader calls and extends paths, read from tokens.

import type { Range, TextCoordinates } from "@nyaa-lexicon/protocol";
import type { DeclarationFact, ReferenceToken, StringPrefix } from "./parse-model.js";
import {
	initializerStart,
	matchingReferenceToken,
	nextReferenceToken,
	previousReferenceToken,
	sourceBetween,
	tokenRange,
} from "./tokens.js";

//////// Types

export type Loader = "preload" | "load";

/** A plain string path. */
export interface PathLiteral {
	/** Quotes excluded. */
	path: string;
	range: Range;
	token: ReferenceToken;
}

/** The const or var initialized. */
export interface LoaderBinding {
	name: string;
	range: Range;
	keyword: "const" | "var";
}

export interface LoaderCall {
	loader: Loader;
	/** The loader word. */
	range: Range;
	/** Absent when computed. */
	literal?: PathLiteral;
	/** The path, or call source. */
	specifier: string;
	binding?: LoaderBinding;
}

//////// Tokens

function pathLiteral(token: ReferenceToken | undefined, prefixes: readonly StringPrefix[]): PathLiteral | undefined {
	const span = token?.string;
	if (token === undefined || span === undefined || span.triple || !prefixes.includes(span.prefix)) return undefined;
	if (span.start.line !== span.end.line) return undefined;
	const path = token.value.slice(span.prefix.length + 1, -1);
	if (path === "") return undefined;
	const start = span.start.character + span.prefix.length + 1;
	const line = span.start.line;
	return { path, range: { start: { line, character: start }, end: { line, character: start + path.length } }, token };
}

/** Not a member or declaration. */
export function isLoaderCall(tokens: ReferenceToken[], index: number): boolean {
	const token = tokens[index];
	if (token?.kind !== "identifier" || (token.value !== "preload" && token.value !== "load")) return false;
	const dot = previousReferenceToken(tokens, index);
	if (tokens[dot]?.value === "func") return false;
	const receiver = tokens[previousReferenceToken(tokens, dot)];
	if (tokens[dot]?.value === "." && !(token.value === "load" && isResourceLoader(receiver))) return false;
	const open = nextReferenceToken(tokens, index);
	return open >= 0 && tokens[open]?.value === "(";
}

/** Its `load` is the global one. */
function isResourceLoader(token: ReferenceToken | undefined): boolean {
	return token?.kind === "identifier" && token.value === "ResourceLoader";
}

/** `load` may add a type hint. */
function literalArgument(tokens: ReferenceToken[], open: number): PathLiteral | undefined {
	const argument = nextReferenceToken(tokens, open);
	const literal = pathLiteral(tokens[argument], ["", "&"]);
	if (literal === undefined) return undefined;
	const after = tokens[nextReferenceToken(tokens, argument)];
	return after?.value === ")" || after?.value === "," ? literal : undefined;
}

//////// Path syntax

export function extendsPaths(tokens: ReferenceToken[]): PathLiteral[] {
	const paths: PathLiteral[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier" || token.value !== "extends") continue;
		const literal = pathLiteral(tokens[index + 1], [""]);
		if (literal !== undefined) paths.push(literal);
	}
	return paths;
}

/** Keyed by loader token index. */
function loaderBindings(tokens: ReferenceToken[], declarations: DeclarationFact[]): Map<number, LoaderBinding> {
	const names = new Map<string, number>();
	tokens.forEach((token, index) => {
		if (token.kind === "identifier") names.set(`${token.line}:${token.character}`, index);
	});
	const bindings = new Map<number, LoaderBinding>();
	for (const declaration of declarations) {
		if (declaration.languageKind === "parameter" || declaration.languageKind === "enumMember") continue;
		const start = declaration.selectionRange.start;
		const index = names.get(`${start.line}:${start.character}`);
		if (index === undefined) continue;
		const keyword = tokens[previousReferenceToken(tokens, index)]?.value;
		if (keyword !== "const" && keyword !== "var") continue;
		const value = initializerStart(tokens, index);
		if (value >= 0 && isLoaderCall(tokens, value))
			bindings.set(value, { name: declaration.name, range: declaration.selectionRange, keyword });
	}
	return bindings;
}

export function loaderCalls(
	tokens: ReferenceToken[],
	coordinates: TextCoordinates,
	declarations: DeclarationFact[],
): LoaderCall[] {
	const bindings = loaderBindings(tokens, declarations);
	const calls: LoaderCall[] = [];
	for (let index = 0; index < tokens.length; index++) {
		if (!isLoaderCall(tokens, index)) continue;
		const token = tokens[index] as ReferenceToken;
		const open = nextReferenceToken(tokens, index);
		const literal = literalArgument(tokens, open);
		const binding = bindings.get(index);
		const base = {
			loader: token.value as Loader,
			range: tokenRange(token),
			...(binding === undefined ? {} : { binding }),
		};
		if (literal !== undefined) {
			calls.push({ ...base, literal, specifier: literal.path });
			continue;
		}
		const close = tokens[matchingReferenceToken(tokens, open, "(", ")")];
		const specifier = close === undefined ? undefined : sourceBetween(coordinates, token, close)?.trim();
		if (specifier !== undefined && specifier !== "") calls.push({ ...base, specifier });
	}
	return calls;
}
