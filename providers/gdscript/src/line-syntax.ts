// Owns GDScript line-head syntax, read from each line's tokens.

import { Cursor } from "./cursor.js";
import type { ParsedKeyword, ParsedLine, ReferenceToken } from "./parse-model.js";
import { isIgnorable, type LexedSource } from "./tokens.js";

//////// Line scanner

/** Script-level and standalone annotations, which belong to no declaration. */
const DETACHED_ANNOTATIONS = new Set([
	"tool",
	"icon",
	"static_unload",
	"export_category",
	"export_group",
	"export_subgroup",
	"warning_ignore_start",
	"warning_ignore_restore",
]);

/** Keywords that head a declaration. */
const DECLARING = new Set(["class_name", "extends", "func", "var", "const", "signal", "enum", "class", "for"]);

/** A run of annotations: where the ones the next declaration owns begin. */
export interface AnnotationRun {
	/** Null when none follow the last detached one. */
	head: number | null;
	detached: boolean;
	/** Names from `head` on. */
	owned: string[];
}

/** Token indices, end exclusive. */
interface Span {
	start: number;
	end: number;
}

function identifierAt(tokens: readonly ReferenceToken[], at: number, end: number): ReferenceToken | undefined {
	const token = tokens[at];
	return at < end && token?.kind === "identifier" ? token : undefined;
}

/** Past `@name` and its arguments; unclosed arguments run to `end`. */
function skipAnnotation(tokens: readonly ReferenceToken[], at: number, end: number): { name: string; next: number } {
	const word = identifierAt(tokens, at + 1, end);
	let next = word === undefined ? at + 1 : at + 2;
	const name = word?.value ?? "";
	if (next >= end || tokens[next]?.value !== "(") return { name, next };
	let depth = 0;
	while (next < end) {
		const value = (tokens[next] as ReferenceToken).value;
		next++;
		if (value === "(") depth++;
		if (value === ")" && --depth === 0) break;
	}
	return { name, next };
}

function skipAnnotations(tokens: readonly ReferenceToken[], span: Span): { run: AnnotationRun; next: number } {
	const run: AnnotationRun = { head: null, detached: false, owned: [] };
	let next = span.start;
	while (next < span.end && tokens[next]?.value === "@") {
		const start = (tokens[next] as ReferenceToken).character;
		const skipped = skipAnnotation(tokens, next, span.end);
		if (DETACHED_ANNOTATIONS.has(skipped.name)) {
			run.head = null;
			run.detached = true;
			run.owned = [];
		} else {
			run.head ??= start;
			run.owned.push(skipped.name);
		}
		next = skipped.next;
	}
	return { run, next };
}

/** Code tokens starting on `line`. */
function lineSpan(lexed: LexedSource, line: number): Span {
	const indices = lexed.lineTokens[line] ?? [];
	const start = indices[0] ?? 0;
	return { start, end: indices.length === 0 ? start : (indices.at(-1) as number) + 1 };
}

/** Null unless the line holds annotations and nothing else. */
export function annotationLine(lexed: LexedSource, line: number): AnnotationRun | null {
	const span = lineSpan(lexed, line);
	if (lexed.tokens[span.start]?.value !== "@" || span.end === span.start) return null;
	const { run, next } = skipAnnotations(lexed.tokens, span);
	return next < span.end ? null : run;
}

export interface AnnotationsAbove {
	/** First owned annotation's line. */
	first: number;
	names: string[];
}

/** No token, string or comment touches it. */
function isBlank(lexed: LexedSource, line: number): boolean {
	return isIgnorable(lexed, line) && lexed.lines[line]?.hasString !== true && !lexed.commentLines.has(line);
}

/** Owned annotation lines above `line`. */
export function annotationsAbove(lexed: LexedSource, line: number): AnnotationsAbove {
	const above: AnnotationsAbove = { first: line, names: [] };
	for (let index = line - 1; index >= 0; index--) {
		if (isIgnorable(lexed, index)) {
			if (isBlank(lexed, index)) break;
			continue;
		}
		const run = annotationLine(lexed, index);
		if (run === null) break;
		if (run.head !== null) {
			above.first = index;
			above.names.unshift(...run.owned);
		}
		if (run.detached) break;
	}
	return above;
}

/** Split at `;`. */
function lineSegments(tokens: readonly ReferenceToken[], span: Span): Span[] {
	const segments: Span[] = [];
	let start = span.start;
	for (let index = span.start; index < span.end; index++) {
		if ((tokens[index] as ReferenceToken).value !== ";") continue;
		segments.push({ start, end: index });
		start = index + 1;
	}
	segments.push({ start, end: span.end });
	return segments;
}

function parseLineHead(
	tokens: readonly ReferenceToken[],
	segment: Span,
	line: Span,
	generic: boolean,
): ParsedLine | null {
	if (segment.start >= segment.end) return null;
	const annotated = tokens[segment.start]?.value === "@";
	const { run, next } = skipAnnotations(tokens, segment);
	let at = next;
	let first = identifierAt(tokens, at, segment.end);
	if (first === undefined) return null;
	const head = run.head ?? first.character;
	const leading = segment.start === line.start && head === (tokens[line.start] as ReferenceToken).character;
	const owned = { annotations: run.owned, leading };
	const nameAfter = (index: number) => {
		const name = identifierAt(tokens, index + 1, segment.end);
		return name === undefined ? null : { name: name.value, start: name.character };
	};

	if (generic) {
		if (first.value !== "export") return null;
		at++;
		first = identifierAt(tokens, at, segment.end);
		if (first === undefined) return null;
		if (first.value !== "class" && first.value !== "function" && first.value !== "const") return null;
		const name = nameAfter(at);
		if (name === null) return null;
		return {
			keyword: first.value === "function" ? "func" : first.value,
			name,
			static: false,
			annotated: false,
			head,
			...owned,
		};
	}

	let isStatic = false;
	if (first.value === "static") {
		isStatic = true;
		at++;
		first = identifierAt(tokens, at, segment.end);
		if (first === undefined) return null;
	}

	if (!DECLARING.has(first.value)) return null;
	const keyword = first.value as ParsedKeyword;
	if (keyword === "extends") return { keyword, name: null, static: isStatic, annotated, head, ...owned };
	return { keyword, name: nameAfter(at), static: isStatic, annotated, head, ...owned };
}

export function parseLineHeads(lexed: LexedSource, line: number, generic = false): ParsedLine[] {
	const span = lineSpan(lexed, line);
	const parsed: ParsedLine[] = [];
	// A generic head reads the whole line.
	for (const segment of generic ? [span] : lineSegments(lexed.tokens, span)) {
		const lineHead = parseLineHead(lexed.tokens, segment, span, generic);
		if (lineHead !== null) parsed.push(lineHead);
	}
	return parsed;
}

export function basenameOf(module: string): string {
	const cursor = new Cursor(module);
	let segment = "";
	let current = "";
	while (cursor.good()) {
		const character = cursor.next();
		if (character === "/") {
			segment = current;
			current = "";
		} else {
			current += character;
		}
	}
	segment = current === "" ? segment : current;
	return segment.endsWith(".gd") ? segment.slice(0, -3) : segment;
}
