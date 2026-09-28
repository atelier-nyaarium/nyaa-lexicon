// Owns GDScript literal facts and loader literal spans.

import { defined, type Literal, type TextCoordinates } from "@nyaa-lexicon/protocol";
import { type Blocks, bodyEndLine } from "./blocks.js";
import type { DeclarationFact, ReferenceToken, SourceLine } from "./parse-model.js";
import { extendsPaths, type LoaderCall } from "./path-syntax.js";
import type { ParsedScript } from "./script.js";

//////// Literals

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

/** One lexer: every literal is a token. */
export function literalsOf(script: ParsedScript, declarations: DeclarationFact[], calls: LoaderCall[]): Literal[] {
	if (!script.module.endsWith(".gd") || script.text.length === 0) return [];
	const { coordinates, lexed } = script;
	const imported = loaderSpans(lexed.tokens, calls);
	const found: Array<{ start: number; end: number; literal: Omit<Literal, "range"> }> = [];

	for (const token of lexed.tokens) {
		if (imported.has(token)) continue;
		const start = token.offset;
		const end = token.offset + token.value.length;
		if (token.string !== undefined) {
			found.push({ start, end, literal: { kind: "string", value: token.string.value } });
		} else if (token.kind === "number") {
			const number = Number(token.value.replaceAll("_", ""));
			if (Number.isFinite(number))
				found.push({ start, end, literal: { kind: "number", value: token.value, number } });
		} else if (token.kind === "identifier" && (token.value === "true" || token.value === "false")) {
			found.push({ start, end, literal: { kind: "boolean", value: token.value } });
		}
	}

	// Containers are matched by a sweep, so offsets must arrive in order.
	const containerFor = literalContainerMatcher(coordinates, script.blocks, declarations);
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
function loaderSpans(tokens: ReferenceToken[], calls: LoaderCall[]): Set<ReferenceToken> {
	const loaded = calls.flatMap((call) => call.literal ?? []);
	return new Set([...extendsPaths(tokens), ...loaded].map((path) => path.token));
}
