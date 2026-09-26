// Owns GDScript line-head syntax.

import { Cursor } from "./cursor.js";
import type { ParsedKeyword, ParsedLine, SourceLine } from "./parse-model.js";

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

/** A run of annotations: where the ones the next declaration owns begin. */
export interface AnnotationRun {
	/** Null when none follow the last detached one. */
	head: number | null;
	detached: boolean;
}

function skipAnnotation(cursor: Cursor): string {
	cursor.next();
	const name = cursor.readIdentifier()?.name ?? "";
	if (cursor.peek() !== "(") return name;

	let depth = 0;
	while (cursor.good()) {
		const character = cursor.next();
		if (character === "(") depth++;
		if (character === ")") {
			depth--;
			if (depth === 0) return name;
		}
	}
	return name;
}

function skipAnnotations(cursor: Cursor): AnnotationRun {
	const run: AnnotationRun = { head: null, detached: false };
	while (cursor.peek() === "@") {
		const start = cursor.offset;
		if (DETACHED_ANNOTATIONS.has(skipAnnotation(cursor))) {
			run.head = null;
			run.detached = true;
		} else {
			run.head ??= start;
		}
		cursor.skipWhitespace();
	}
	return run;
}

/** Null unless the line holds annotations and nothing else. */
export function annotationLine(line: SourceLine): AnnotationRun | null {
	const cursor = new Cursor(line.code);
	cursor.skipWhitespace();
	if (cursor.peek() !== "@") return null;
	const run = skipAnnotations(cursor);
	return cursor.good() ? null : run;
}

interface LineSegment {
	start: number;
	end: number;
}

function lineSegments(line: SourceLine): LineSegment[] {
	const cursor = new Cursor(line.code);
	const segments: LineSegment[] = [];
	let start = 0;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("lineSegments failed to advance");
		guard = cursor.offset;
		const character = cursor.next();
		if (character === ";") {
			segments.push({ start, end: cursor.offset - 1 });
			start = cursor.offset;
		}
	}
	segments.push({ start, end: line.code.length });
	return segments;
}

export function parseLineHead(line: SourceLine, generic = false, start = 0, end = line.code.length): ParsedLine | null {
	const cursor = new Cursor(line.code, start, end);
	cursor.skipWhitespace();
	if (cursor.peek() === "" || cursor.peek() === "#") return null;

	const annotated = cursor.peek() === "@";
	const annotations = skipAnnotations(cursor);
	const head = annotations.head ?? cursor.offset;

	let first = cursor.readIdentifier();
	if (first === null) return null;
	if (generic) {
		if (first.name !== "export") return null;
		cursor.skipWhitespace();
		first = cursor.readIdentifier();
		if (first === null) return null;
		if (first.name !== "class" && first.name !== "function" && first.name !== "const") return null;
		cursor.skipWhitespace();
		const name = cursor.readIdentifier();
		if (name === null) return null;
		return {
			keyword: first.name === "function" ? "func" : first.name,
			name,
			static: false,
			annotated: false,
			head,
		};
	}

	let isStatic = false;
	if (first.name === "static") {
		isStatic = true;
		cursor.skipWhitespace();
		first = cursor.readIdentifier();
		if (first === null) return null;
	}

	const keyword = first.name as ParsedKeyword;
	if (!["class_name", "extends", "func", "var", "const", "signal", "enum", "class", "for"].includes(keyword))
		return null;
	if (keyword === "extends") return { keyword, name: null, static: isStatic, annotated, head };
	cursor.skipWhitespace();
	return {
		keyword,
		name: cursor.readIdentifier(),
		static: isStatic,
		annotated,
		head,
	};
}

export function parseLineHeads(line: SourceLine, generic = false): ParsedLine[] {
	const parsed: ParsedLine[] = [];
	for (const segment of lineSegments(line)) {
		const lineHead = parseLineHead(line, generic, segment.start, segment.end);
		if (lineHead !== null) parsed.push(lineHead);
	}
	return parsed;
}

export function indentOf(text: string): number {
	const cursor = new Cursor(text);
	let width = 0;
	while (cursor.peek() === " " || cursor.peek() === "\t") {
		width += cursor.next() === "\t" ? 4 : 1;
	}
	return width;
}

export function indentationEnd(text: string): number {
	const cursor = new Cursor(text);
	while (cursor.peek() === " " || cursor.peek() === "\t") cursor.next();
	return cursor.column;
}

export function isIgnorable(line: SourceLine): boolean {
	const cursor = new Cursor(line.code);
	cursor.skipWhitespace();
	return cursor.peek() === "" || cursor.peek() === "#";
}

export function containsCharacter(text: string, wanted: string): boolean {
	const cursor = new Cursor(text);
	while (cursor.good()) if (cursor.next() === wanted) return true;
	return false;
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
