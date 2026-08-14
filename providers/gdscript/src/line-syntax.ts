// Owns GDScript documentation and line-head syntax.

import { Cursor } from "./cursor.js";
import type { DeclarationFact, ParsedKeyword, ParsedLine, SourceLine } from "./parse-model.js";

//////// Documentation

function documentationLine(text: string): string | null {
	const match = /^\s*##(.*)$/u.exec(text);
	if (match === null) return null;
	const content = match[1] ?? "";
	return content.startsWith(" ") ? content.slice(1) : content;
}

export function documentationBefore(lines: SourceLine[], lineIndex: number): string | undefined {
	const comments: string[] = [];
	for (let index = lineIndex - 1; index >= 0; index--) {
		const content = documentationLine((lines[index] as SourceLine).text);
		if (content === null) break;
		comments.unshift(content);
	}
	return comments.length === 0 ? undefined : comments.join("\n");
}

function scriptHeaderLine(line: SourceLine): boolean {
	if (isIgnorable(line) || documentationLine(line.text) !== null) return true;
	if (/^\s*@/u.test(line.text)) return true;
	const parsed = parseLineHeads(line);
	return parsed.length === 1 && (parsed[0]?.keyword === "extends" || parsed[0]?.keyword === "class_name");
}

export function scriptDocumentation(lines: SourceLine[]): string | undefined {
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as SourceLine;
		if (indentOf(line.text) !== 0) continue;
		const parsed = parseLineHeads(line);
		if (parsed.length !== 1 || (parsed[0]?.keyword !== "extends" && parsed[0]?.keyword !== "class_name")) continue;
		const docComment = documentationBefore(lines, index);
		if (docComment === undefined) continue;
		if (lines.slice(0, index).every(scriptHeaderLine)) return docComment;
	}
	return undefined;
}

export function attachDocumentation(
	declaration: DeclarationFact,
	lines: SourceLine[],
	lineIndex: number,
	documentedLines: Set<number>,
): void {
	if (documentedLines.has(lineIndex)) return;
	const docComment = documentationBefore(lines, lineIndex);
	if (docComment === undefined) return;
	declaration.docComment = docComment;
	documentedLines.add(lineIndex);
}

//////// Line scanner

function skipAnnotation(cursor: Cursor): void {
	cursor.next();
	cursor.readIdentifier();
	if (cursor.peek() !== "(") return;

	let depth = 0;
	while (cursor.good()) {
		const character = cursor.next();
		if (character === "(") depth++;
		if (character === ")") {
			depth--;
			if (depth === 0) return;
		}
	}
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

	let annotated = false;
	while (cursor.peek() === "@") {
		annotated = true;
		skipAnnotation(cursor);
		cursor.skipWhitespace();
	}

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
	if (keyword === "extends") return { keyword, name: null, static: isStatic, annotated };
	if (keyword === "enum") {
		cursor.skipWhitespace();
		return {
			keyword,
			name: cursor.readIdentifier(),
			static: isStatic,
			annotated,
		};
	}
	cursor.skipWhitespace();
	if (keyword === "for") {
		return {
			keyword,
			name: cursor.readIdentifier(),
			static: isStatic,
			annotated,
		};
	}
	return {
		keyword,
		name: cursor.readIdentifier(),
		static: isStatic,
		annotated,
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
