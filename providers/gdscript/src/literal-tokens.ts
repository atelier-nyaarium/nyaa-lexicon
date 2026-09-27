// Owns GDScript literal parsing and loader literal spans.

import { coordinatesOf, defined, type Literal, type TextCoordinates } from "@nyaa-lexicon/protocol";
import { type Blocks, blocksOf, bodyEndLine } from "./blocks.js";
import type { DeclarationFact, ReferenceToken, SourceLine, StringSpan } from "./parse-model.js";
import { extendsPaths, loaderCalls } from "./path-syntax.js";
import { lexSource, tokenRange } from "./tokens.js";

//////// Literals

function decodeStringContent(content: string): string {
	let decoded = "";
	for (let index = 0; index < content.length; index++) {
		if (content[index] !== "\\" || index + 1 >= content.length) {
			decoded += content[index] as string;
			continue;
		}
		const escaped = content[index + 1] as string;
		const simple: Record<string, string> = {
			"0": "\0",
			a: "\x07",
			b: "\b",
			e: "\x1b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "\t",
			v: "\v",
			"\\": "\\",
			'"': '"',
			"'": "'",
		};
		const replacement = simple[escaped];
		if (replacement !== undefined) {
			decoded += replacement;
			index++;
			continue;
		}
		const digits = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
		if (digits > 0) {
			const hex = content.slice(index + 2, index + 2 + digits);
			const codePoint = Number.parseInt(hex, 16);
			if (hex.length === digits && Number.isFinite(codePoint) && (escaped !== "U" || codePoint <= 0x10ffff)) {
				decoded += String.fromCodePoint(codePoint);
				index += digits + 1;
				continue;
			}
		}
		decoded += `\\${escaped}`;
		index++;
	}
	return decoded;
}

function literalContainerMatcher(
	coordinates: TextCoordinates,
	blocks: Blocks,
	declarations: DeclarationFact[],
): (offset: number) => string | undefined {
	const spans = declarations
		.flatMap((declaration) => {
			const endLine =
				declaration.kind === "method" ? bodyEndLine(blocks, declaration) - 1 : declaration.range.end.line;
			const line = blocks.lexed.lines[endLine] as SourceLine | undefined;
			if (line === undefined) return [];
			const start = coordinates.offsetAt(declaration.range.start);
			const end = coordinates.offsetAt({ line: endLine, character: line.end });
			return start === undefined || end === undefined ? [] : [{ declaration, start, end }];
		})
		.sort((left, right) => left.start - right.start || right.end - left.end);
	const active: typeof spans = [];
	let next = 0;
	return (offset: number): string | undefined => {
		while (next < spans.length && (spans[next] as (typeof spans)[number]).start <= offset) {
			active.push(spans[next] as (typeof spans)[number]);
			next++;
		}
		for (let index = active.length - 1; index >= 0; index--) {
			if ((active[index] as (typeof spans)[number]).end < offset) active.splice(index, 1);
		}
		let closest: (typeof spans)[number] | undefined;
		for (const span of active) {
			if (span.end < offset) continue;
			if (closest === undefined || span.end - span.start < closest.end - closest.start) closest = span;
		}
		return closest?.declaration.symbolId;
	};
}

function stringValue(token: ReferenceToken, span: StringSpan): string {
	const quotes = span.triple ? 3 : 1;
	const content = token.value.slice(span.prefix.length + quotes, token.value.length - quotes);
	// Raw strings keep their escapes.
	return span.prefix === "r" ? content : decodeStringContent(content);
}

/** One lexer: every literal is a token. */
export function extractLiteralsCore(module: string, text: string, declarations: DeclarationFact[]): Literal[] {
	if (!module.endsWith(".gd") || text.length === 0) return [];
	const coordinates = coordinatesOf(text);
	const lexed = lexSource(text);
	const tokens = lexed.tokens;
	const imported = loaderSpans(tokens, coordinates);
	const found: Array<{ start: number; end: number; literal: Omit<Literal, "range"> }> = [];

	for (const token of tokens) {
		if (imported.has(token)) continue;
		const range = tokenRange(token);
		const start = coordinates.offsetAt(range.start);
		const end = coordinates.offsetAt(range.end);
		if (start === undefined || end === undefined) continue;
		if (token.string !== undefined) {
			found.push({ start, end, literal: { kind: "string", value: stringValue(token, token.string) } });
		} else if (token.kind === "number") {
			const number = Number(token.value.replaceAll("_", ""));
			if (Number.isFinite(number))
				found.push({ start, end, literal: { kind: "number", value: token.value, number } });
		} else if (token.kind === "identifier" && (token.value === "true" || token.value === "false")) {
			found.push({ start, end, literal: { kind: "boolean", value: token.value } });
		}
	}

	// Containers are matched by a sweep, so offsets must arrive in order.
	const containerFor = literalContainerMatcher(coordinates, blocksOf(lexed), declarations);
	const literals: Literal[] = [];
	for (const { start, end, literal } of found.sort((left, right) => left.start - right.start)) {
		const range = coordinates.rangeAt(start, end);
		if (range === undefined) continue;
		const containerId = containerFor(start);
		literals.push({ ...literal, range, ...defined({ containerId }) });
	}
	return literals;
}

//////// Loader spans

/** Path strings that are import facts, not literals. */
function loaderSpans(tokens: ReferenceToken[], coordinates: TextCoordinates): Set<ReferenceToken> {
	const loaded = loaderCalls(tokens, coordinates, []).flatMap((call) => call.literal ?? []);
	return new Set([...extendsPaths(tokens), ...loaded].map((path) => path.token));
}
