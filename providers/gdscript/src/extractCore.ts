import {
	coordinatesOf,
	type Diagnostic,
	type ImportedName,
	type Literal,
	type Metrics,
	type Position,
	type Range,
	type Reference,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";

//////// Types

import type {
	ActiveEnum,
	ActiveFunctionHeader,
	ComposeSymbolId,
	DeclarationFact,
	DeclarationKind,
	Descriptor,
	ParsedKeyword,
	ParsedLine,
	RawLine,
	ReferenceBlock,
	ReferenceToken,
	Scope,
	SourceLine,
	Token,
	Visibility,
} from "./parse-model.js";

export type { DeclarationFact, DeclarationKind, Descriptor, Visibility } from "./parse-model.js";

//////// Cursor

class Cursor {
	private offsetValue = 0;
	private lineValue = 0;
	private columnValue = 0;
	private readonly endOffsetValue: number;

	constructor(
		private readonly source: string,
		startOffset = 0,
		endOffset = source.length,
	) {
		this.offsetValue = startOffset;
		this.endOffsetValue = Math.min(endOffset, source.length);
	}

	get offset(): number {
		return this.offsetValue;
	}

	get line(): number {
		return this.lineValue;
	}

	get column(): number {
		return this.columnValue;
	}

	peek(offset = 0): string {
		const position = this.offsetValue + offset;
		if (position < 0 || position >= this.endOffsetValue) return "";
		const codePoint = this.source.codePointAt(position);
		return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
	}

	next(): string {
		const character = this.peek();
		if (character === "") return "";
		this.offsetValue += character.length;
		if (character === "\n") {
			this.lineValue++;
			this.columnValue = 0;
		} else {
			this.columnValue += character.length;
		}
		return character;
	}

	good(): boolean {
		return this.offsetValue < this.endOffsetValue;
	}

	readLine(): RawLine | null {
		if (!this.good()) return null;
		const line = this.line;
		let text = "";
		while (this.good() && this.peek() !== "\n") text += this.next();
		if (this.peek() === "\n") this.next();
		return { line, text };
	}

	skipWhitespace(): void {
		while (this.peek() === " " || this.peek() === "\t" || this.peek() === "\r") this.next();
	}

	readIdentifier(): Token | null {
		const start = this.offset;
		if (!isIdentifierStart(this.peek())) return null;
		let name = this.next();
		while (isIdentifierPart(this.peek())) name += this.next();
		return { name, start };
	}
}

function isIdentifierStart(character: string): boolean {
	return character === "_" || /^\p{L}$/u.test(character);
}

function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || /^[\p{M}\p{N}]$/u.test(character);
}

export function isGdscriptIdentifier(name: string): boolean {
	const characters = [...name];
	return (
		characters.length > 0 &&
		isIdentifierStart(characters[0] as string) &&
		characters.slice(1).every(isIdentifierPart)
	);
}

type TripleQuote = "'" | '"';

interface ActiveString {
	quote: TripleQuote;
	triple: boolean;
	start: Position;
}

interface StringState {
	active: ActiveString | null;
	unterminated: Position[];
}

interface MaskedLine {
	code: string;
	hasString: boolean;
	stringStarts: number[];
	endsInString: boolean;
}

interface ScannedSource {
	lines: SourceLine[];
	unterminatedStrings: Position[];
}

function masked(character: string): string {
	return " ".repeat(character.length);
}

function tripleQuoteAt(cursor: Cursor, quote: TripleQuote): boolean {
	return cursor.peek() === quote && cursor.peek(1) === quote && cursor.peek(2) === quote;
}

function consumeMasked(cursor: Cursor, count: number): string {
	let result = "";
	for (let index = 0; index < count && cursor.good(); index++) result += masked(cursor.next());
	return result;
}

function maskStringContent(cursor: Cursor, state: StringState): string {
	const active = state.active as ActiveString;
	let code = "";
	while (cursor.good()) {
		if (active.triple && tripleQuoteAt(cursor, active.quote)) {
			code += consumeMasked(cursor, 3);
			state.active = null;
			return code;
		}
		const character = cursor.next();
		code += masked(character);
		if (character === "\\") {
			if (!cursor.good()) return code;
			if (cursor.peek() === "\r" && cursor.peek(1) === "") {
				code += masked(cursor.next());
				return code;
			}
			code += masked(cursor.next());
			continue;
		}
		if (!active.triple && character === active.quote) {
			state.active = null;
			return code;
		}
	}
	if (!active.triple) {
		state.unterminated.push(active.start);
		state.active = null;
	}
	return code;
}

function maskLine(text: string, line: number, state: StringState): MaskedLine {
	const cursor = new Cursor(text);
	let code = "";
	let hasString = state.active !== null;
	const stringStarts: number[] = [];
	while (cursor.good()) {
		const before = cursor.offset;
		if (state.active !== null) {
			code += maskStringContent(cursor, state);
		} else if (cursor.peek() === "#") {
			while (cursor.good()) code += masked(cursor.next());
		} else if (cursor.peek() === "'" || cursor.peek() === '"') {
			const quote = cursor.peek() as TripleQuote;
			const triple = tripleQuoteAt(cursor, quote);
			hasString = true;
			stringStarts.push(cursor.column);
			state.active = { quote, triple, start: { line, character: cursor.column } };
			code += consumeMasked(cursor, triple ? 3 : 1);
			code += maskStringContent(cursor, state);
		} else {
			code += cursor.next();
		}
		if (cursor.offset <= before) throw new Error("maskLine failed to advance");
	}
	return { code, hasString, stringStarts, endsInString: state.active !== null };
}

function scanSource(text: string): ScannedSource {
	const cursor = new Cursor(text);
	const lines: SourceLine[] = [];
	const state: StringState = { active: null, unterminated: [] };
	let line = cursor.readLine();
	while (line !== null) {
		lines.push({ ...line, ...maskLine(line.text, line.line, state) });
		line = cursor.readLine();
	}
	if (state.active !== null) state.unterminated.push(state.active.start);
	return { lines, unterminatedStrings: state.unterminated };
}

function readLines(text: string): SourceLine[] {
	return scanSource(text).lines;
}

function documentationLine(text: string): string | null {
	const match = /^\s*##(.*)$/u.exec(text);
	if (match === null) return null;
	const content = match[1] ?? "";
	return content.startsWith(" ") ? content.slice(1) : content;
}

function documentationBefore(lines: SourceLine[], lineIndex: number): string | undefined {
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

function scriptDocumentation(lines: SourceLine[]): string | undefined {
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

function attachDocumentation(
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

// The `d` flag, not indexOf: searching the match for the path text finds the FIRST occurrence,
// which in `class Foo extends "Foo"` is the class name. That put the reference range on the wrong
// span whenever a script extended a path spelled like something earlier on its own line.
function literalExtendsPath(line: SourceLine): { path: string; start: number } | null {
	const match = /^\s*(?:class\s+[\p{L}_][\p{L}\p{M}\p{N}_]*\s+)?extends\s+("|')([^"']+)\1/du.exec(line.text);
	const path = match?.[2];
	const at = match?.indices?.[2]?.[0];
	if (match === null || path === undefined || at === undefined) return null;
	return { path, start: at };
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

function parseLineHead(line: SourceLine, generic = false, start = 0, end = line.code.length): ParsedLine | null {
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

function parseLineHeads(line: SourceLine, generic = false): ParsedLine[] {
	const parsed: ParsedLine[] = [];
	for (const segment of lineSegments(line)) {
		const lineHead = parseLineHead(line, generic, segment.start, segment.end);
		if (lineHead !== null) parsed.push(lineHead);
	}
	return parsed;
}

function indentOf(text: string): number {
	const cursor = new Cursor(text);
	let width = 0;
	while (cursor.peek() === " " || cursor.peek() === "\t") {
		width += cursor.next() === "\t" ? 4 : 1;
	}
	return width;
}

function indentationEnd(text: string): number {
	const cursor = new Cursor(text);
	while (cursor.peek() === " " || cursor.peek() === "\t") cursor.next();
	return cursor.column;
}

function isIgnorable(line: SourceLine): boolean {
	const cursor = new Cursor(line.code);
	cursor.skipWhitespace();
	return cursor.peek() === "" || cursor.peek() === "#";
}

function containsCharacter(text: string, wanted: string): boolean {
	const cursor = new Cursor(text);
	while (cursor.good()) if (cursor.next() === wanted) return true;
	return false;
}

function basenameOf(module: string): string {
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

//////// Declarations

function contentEndCharacter(line: SourceLine): number {
	return line.text.endsWith("\r") ? line.text.length - 1 : line.text.length;
}

function rangeOf(coordinates: TextCoordinates, line: SourceLine): Range {
	return rangeOfLines(coordinates, line, line);
}

function rangeOfLines(coordinates: TextCoordinates, start: SourceLine, end: SourceLine): Range {
	const startOffset = coordinates.offsetAt({ line: start.line, character: 0 });
	const endOffset = coordinates.offsetAt({ line: end.line, character: contentEndCharacter(end) });
	if (startOffset === undefined || endOffset === undefined) throw new Error("source line has no coordinate");
	const range = coordinates.rangeAt(startOffset, endOffset);
	if (range === undefined) throw new Error("source line range is invalid");
	return range;
}

export function headerEndLine(lines: readonly { code: string }[], declaration: Pick<DeclarationFact, "range">): number {
	for (let line = declaration.range.start.line; line < lines.length; line++) {
		if ((lines[line]?.code ?? "").trimEnd().endsWith(":")) return line;
	}
	return declaration.range.end.line;
}

function selectionRangeOf(line: SourceLine, token: Token): Range {
	return {
		start: { line: line.line, character: token.start },
		end: { line: line.line, character: token.start + token.name.length },
	};
}

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

function stringEnd(text: string, quoteStart: number): { end: number; value: string } | null {
	const quote = text[quoteStart] as "'" | '"';
	const triple = text.startsWith(quote.repeat(3), quoteStart);
	const size = triple ? 3 : 1;
	let index = quoteStart + size;
	while (index < text.length) {
		if (triple && text.startsWith(quote.repeat(3), index)) {
			return {
				end: index + 3,
				value: decodeStringContent(text.slice(quoteStart + 3, index)),
			};
		}
		if (!triple && text[index] === quote) {
			return {
				end: index + 1,
				value: decodeStringContent(text.slice(quoteStart + 1, index)),
			};
		}
		if (text[index] === "\\") index += 2;
		else index++;
	}
	return null;
}

function numericEnd(text: string, start: number): number {
	let index = start;
	if (text.startsWith("0x", index) || text.startsWith("0X", index)) {
		index += 2;
		while (/[0-9A-Fa-f_]/.test(text[index] ?? "")) index++;
		return index;
	}
	if (text.startsWith("0b", index) || text.startsWith("0B", index)) {
		index += 2;
		while (/[01_]/.test(text[index] ?? "")) index++;
		return index;
	}
	while (/[0-9_]/.test(text[index] ?? "")) index++;
	if (text[index] === "." && /[0-9]/.test(text[index + 1] ?? "")) {
		index++;
		while (/[0-9_]/.test(text[index] ?? "")) index++;
	}
	if (text[index] === "e" || text[index] === "E") {
		let exponent = index + 1;
		if (text[exponent] === "+" || text[exponent] === "-") exponent++;
		const digits = exponent;
		while (/[0-9_]/.test(text[exponent] ?? "")) exponent++;
		if (exponent > digits) index = exponent;
	}
	return index;
}

function literalContainerMatcher(
	coordinates: TextCoordinates,
	lines: SourceLine[],
	declarations: DeclarationFact[],
): (offset: number) => string | undefined {
	const spans = declarations
		.flatMap((declaration) => {
			const endLine =
				declaration.kind === "method" ? bodyEndLine(lines, declaration) - 1 : declaration.range.end.line;
			const line = lines[endLine] as SourceLine | undefined;
			if (line === undefined) return [];
			const start = coordinates.offsetAt(declaration.range.start);
			const end = coordinates.offsetAt({ line: endLine, character: contentEndCharacter(line) });
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

export function extractLiteralsCore(module: string, text: string, declarations: DeclarationFact[]): Literal[] {
	if (!module.endsWith(".gd") || text.length === 0) return [];
	const literals: Literal[] = [];
	const coordinates = coordinatesOf(text);
	const containerFor = literalContainerMatcher(coordinates, readLines(text), declarations);
	const importedLiteralRanges = new Set(
		literalImportSyntax(module, text).map((literal) => `${literal.start}:${literal.end}`),
	);
	const addLiteral = (literal: Literal, start: number): void => {
		const containerId = containerFor(start);
		literals.push(containerId === undefined ? literal : { ...literal, containerId });
	};
	let index = 0;
	while (index < text.length) {
		const character = text[index] as string;
		if (character === "#") {
			const newline = text.indexOf("\n", index);
			index = newline < 0 ? text.length : newline + 1;
			continue;
		}
		const typedString =
			(character === "&" || character === "^") && (text[index + 1] === "'" || text[index + 1] === '"');
		const quoteStart = typedString ? index + 1 : index;
		if (text[quoteStart] === "'" || text[quoteStart] === '"') {
			const string = stringEnd(text, quoteStart);
			if (string === null) break;
			const start = typedString ? index : quoteStart;
			if (importedLiteralRanges.has(`${start}:${string.end}`)) {
				index = string.end;
				continue;
			}
			const range = coordinates.rangeAt(start, string.end);
			if (range === undefined) {
				index = string.end;
				continue;
			}
			addLiteral({ kind: "string", value: string.value, range }, start);
			index = string.end;
			continue;
		}
		const codePoint = text.codePointAt(index);
		const codeCharacter = codePoint === undefined ? character : String.fromCodePoint(codePoint);
		const codeWidth = codeCharacter.length;
		if (isIdentifierStart(codeCharacter)) {
			let end = index + codeWidth;
			while (end < text.length) {
				const nextPoint = text.codePointAt(end);
				if (nextPoint === undefined) break;
				const nextCharacter = String.fromCodePoint(nextPoint);
				if (!isIdentifierPart(nextCharacter)) break;
				end += nextCharacter.length;
			}
			const word = text.slice(index, end);
			if (word === "true" || word === "false") {
				const range = coordinates.rangeAt(index, end);
				if (range !== undefined) addLiteral({ kind: "boolean", value: word, range }, index);
			}
			index = end;
			continue;
		}
		if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(text[index + 1] ?? ""))) {
			const end = numericEnd(text, index);
			const value = text.slice(index, end);
			const number = Number(value.replaceAll("_", ""));
			if (end > index && Number.isFinite(number)) {
				const range = coordinates.rangeAt(index, end);
				if (range !== undefined) addLiteral({ kind: "number", value, number, range }, index);
			}
			index = end;
			continue;
		}
		index += codeWidth;
	}
	return literals;
}

function visibilityOf(name: string, local: boolean): Visibility {
	if (local) return "local";
	return name.startsWith("_") ? "private" : "public";
}

function signatureOf(line: SourceLine): string | undefined {
	const cursor = new Cursor(line.text);
	cursor.skipWhitespace();
	let signature = "";
	while (cursor.good()) signature += cursor.next();
	return signature === "" ? undefined : signature;
}

function signatureOfLines(lines: SourceLine[]): string | undefined {
	const signatures: string[] = [];
	for (const line of lines) {
		const signature = signatureOf(line);
		if (signature !== undefined) signatures.push(signature);
	}
	return signatures.length === 0 ? undefined : signatures.join("\n");
}

function functionHeaderComplete(lines: SourceLine[]): boolean {
	let parameterDepth = 0;
	let closedParameters = false;
	for (const line of lines) {
		const cursor = new Cursor(line.code);
		while (cursor.good()) {
			const character = cursor.next();
			if (character === "(") parameterDepth++;
			if (character === ")" && parameterDepth > 0) {
				parameterDepth--;
				closedParameters = parameterDepth === 0;
			}
			if (character === ":" && closedParameters) return true;
		}
	}
	return false;
}

function isAccessorHead(line: SourceLine): boolean {
	const cursor = new Cursor(line.code);
	cursor.skipWhitespace();
	const name = cursor.readIdentifier();
	if (name === null || (name.name !== "set" && name.name !== "get")) return false;
	cursor.skipWhitespace();
	return cursor.peek() === "(" || cursor.peek() === ":";
}

function accessorEndLine(lines: SourceLine[], declarationIndex: number, declarationIndent: number): SourceLine {
	let index = declarationIndex + 1;
	while (index < lines.length && isIgnorable(lines[index] as SourceLine)) index++;
	const accessor = lines[index] as SourceLine | undefined;
	if (accessor === undefined || indentOf(accessor.text) < declarationIndent || !isAccessorHead(accessor)) {
		return lines[declarationIndex] as SourceLine;
	}

	let end = index;
	const accessorIndent = indentOf(accessor.text);
	index++;
	while (index < lines.length) {
		const line = lines[index] as SourceLine;
		if (isIgnorable(line)) {
			index++;
			continue;
		}
		const indent = indentOf(line.text);
		if (indent > accessorIndent) {
			end = index;
			index++;
			continue;
		}
		if (indent === accessorIndent && isAccessorHead(line)) {
			end = index;
			index++;
			continue;
		}
		break;
	}
	return lines[end] as SourceLine;
}

function descriptorFor(keyword: ParsedKeyword, name: string): Descriptor {
	if (keyword === "func") return { kind: "method", name };
	if (keyword === "class_name" || keyword === "class" || keyword === "enum") return { kind: "type", name };
	return { kind: "term", name };
}

function declarationKindFor(keyword: ParsedKeyword, local: boolean): DeclarationKind {
	if (keyword === "class_name" || keyword === "class") return "class";
	if (keyword === "func") return "method";
	if (keyword === "var") return local ? "variable" : "property";
	if (keyword === "const") return "constant";
	if (keyword === "signal") return "event";
	if (keyword === "enum") return "enum";
	if (keyword === "for") return "variable";
	return "variable";
}

function makeDeclaration(
	compose: ComposeSymbolId,
	module: string,
	coordinates: TextCoordinates,
	line: SourceLine,
	token: Token,
	keyword: ParsedKeyword,
	name: string,
	scope: Scope,
	languageKind: string | undefined,
	visibility: Visibility,
	exported?: boolean,
): DeclarationFact {
	const descriptors = [...scope.descriptors, descriptorFor(keyword, name)];
	const symbolId = compose({ language: "gdscript", module, descriptors });
	const local = scope.functionScope;
	const signature = signatureOf(line);
	return {
		symbolId,
		kind: declarationKindFor(keyword, local),
		...(languageKind === undefined ? {} : { languageKind }),
		name,
		range: rangeOf(coordinates, line),
		selectionRange: selectionRangeOf(line, token),
		visibility,
		...(exported === undefined ? {} : { exported }),
		...(signature === undefined ? {} : { signature }),
		...(scope.containerId === "" ? {} : { containerId: scope.containerId }),
	};
}

function makeImplicitClass(
	compose: ComposeSymbolId,
	module: string,
	coordinates: TextCoordinates,
	line: SourceLine,
	name: string,
	className: Token | null,
): DeclarationFact {
	const token = className ?? { name, start: 0 };
	const symbolId = compose({
		language: "gdscript",
		module,
		descriptors: [{ kind: "type", name }],
	});
	const signature = signatureOf(line);
	return {
		symbolId,
		kind: "class",
		languageKind: className === null ? "script" : "class_name",
		name,
		range: rangeOf(coordinates, line),
		selectionRange: selectionRangeOf(line, token),
		visibility: visibilityOf(name, false),
		...(className === null || signature === undefined ? {} : { signature }),
	};
}

interface ParameterSegment {
	start: number;
	end: number;
}

function parameterSegments(tokens: ReferenceToken[], start: number, end: number): ParameterSegment[] {
	const segments: ParameterSegment[] = [];
	let segmentStart = start;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
			segments.push({ start: segmentStart, end: index });
			segmentStart = index + 1;
		}
	}
	segments.push({ start: segmentStart, end });
	return segments;
}

function parameterNameAndEnd(
	tokens: ReferenceToken[],
	segment: ParameterSegment,
): { name: ReferenceToken; end: ReferenceToken } | null {
	let name: ReferenceToken | null = null;
	let defaultIndex = segment.end;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = segment.start; index < segment.end; index++) {
		const token = tokens[index] as ReferenceToken;
		const value = token.value;
		if (name === null && token.kind === "identifier") name = token;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (parentheses === 0 && brackets === 0 && braces === 0 && (value === "=" || value === ":=")) {
			defaultIndex = index;
			break;
		}
	}
	if (name === null) return null;
	let endIndex = defaultIndex - 1;
	while (endIndex >= segment.start && (tokens[endIndex] as ReferenceToken).kind === "newline") endIndex--;
	const end = tokens[endIndex] as ReferenceToken | undefined;
	return end === undefined ? null : { name, end };
}

function addFunctionParameters(
	declarations: DeclarationFact[],
	module: string,
	compose: ComposeSymbolId,
	declaration: DeclarationFact,
	scope: Scope,
	tokens: ReferenceToken[],
): void {
	const nameIndex = tokens.findIndex(
		(token) =>
			token.kind === "identifier" &&
			token.line === declaration.selectionRange.start.line &&
			token.character === declaration.selectionRange.start.character &&
			token.value === declaration.name,
	);
	if (nameIndex < 0) return;
	let open = nextReferenceToken(tokens, nameIndex);
	while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
	if (open < 0) return;
	const close = matchingReferenceToken(tokens, open, "(", ")");
	if (close < 0) return;
	for (const segment of parameterSegments(tokens, open + 1, close)) {
		const parameter = parameterNameAndEnd(tokens, segment);
		if (parameter === null) continue;
		const parameterId = compose({
			language: "gdscript",
			module,
			descriptors: [
				...scope.descriptors,
				{ kind: "method", name: declaration.name },
				{ kind: "parameter", name: parameter.name.value },
			],
		});
		declarations.push({
			symbolId: parameterId,
			kind: "variable",
			languageKind: "parameter",
			name: parameter.name.value,
			range: {
				start: { line: parameter.name.line, character: parameter.name.character },
				end: { line: parameter.end.line, character: parameter.end.character + parameter.end.value.length },
			},
			selectionRange: {
				start: { line: parameter.name.line, character: parameter.name.character },
				end: { line: parameter.name.line, character: parameter.name.character + parameter.name.value.length },
			},
			visibility: "local",
			containerId: declaration.symbolId,
		});
	}
}

function enumMembers(line: SourceLine): Token[] {
	const cursor = new Cursor(line.code);
	const members: Token[] = [];
	let inside = false;
	let expectName = false;
	let expressionDepth = 0;
	while (cursor.good()) {
		const character = cursor.peek();
		if (character === "#") break;
		if (!inside) {
			cursor.next();
			if (character === "{") {
				inside = true;
				expectName = true;
			}
			continue;
		}
		if (expressionDepth > 0) {
			const consumed = cursor.next();
			if (consumed === "(") expressionDepth++;
			if (consumed === ")") expressionDepth--;
			continue;
		}
		if (character === "}") break;
		if (character === "(") {
			expressionDepth = 1;
			cursor.next();
			continue;
		}
		if (character === ",") {
			expectName = true;
			cursor.next();
			continue;
		}
		if (character === "=" && expectName === false) {
			expectName = false;
			cursor.next();
			continue;
		}
		if (expectName) {
			const token = cursor.readIdentifier();
			if (token !== null) {
				members.push(token);
				expectName = false;
				continue;
			}
		}
		cursor.next();
	}
	return members;
}

function multilineEnumMember(line: SourceLine): Token | null {
	const cursor = new Cursor(line.code);
	cursor.skipWhitespace();
	if (cursor.peek() === "" || cursor.peek() === "#" || cursor.peek() === "}") return null;
	return cursor.readIdentifier();
}

function extractGdscript(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const coordinates = coordinatesOf(text);
	const lines = readLines(text);
	const tokens = referenceTokens(lines);
	const classLine = lines
		.map((line) => ({ line, parsed: parseLineHeads(line).find((candidate) => candidate.keyword === "class_name") }))
		.find((entry) => entry.parsed?.keyword === "class_name" && entry.parsed.name !== null);
	const className = classLine?.parsed?.name ?? null;
	const rootName = className?.name ?? basenameOf(module);
	const rootLine = classLine?.line ?? {
		line: 0,
		text: "",
		code: "",
		hasString: false,
		stringStarts: [],
		endsInString: false,
	};
	const root = makeImplicitClass(compose, module, coordinates, rootLine, rootName, className);
	// The script IS the class, so the root's range spans the whole file. A one-line range here made
	// a class-level move relocate only the class_name line and orphan every member behind it.
	const firstLine = lines[0] ?? rootLine;
	const lastLine = lines[lines.length - 1] ?? firstLine;
	root.range = rangeOfLines(coordinates, firstLine, lastLine);
	const rootDocComment = scriptDocumentation(lines);
	if (rootDocComment !== undefined) root.docComment = rootDocComment;
	const declarations: DeclarationFact[] = [root];
	const documentedLines = new Set<number>();
	const scopes: Scope[] = [
		{
			indent: -1,
			descriptors: [{ kind: "type", name: rootName }],
			containerId: root.symbolId,
			functionScope: false,
		},
	];
	let activeEnum: ActiveEnum | null = null;
	let activeFunctionHeader: ActiveFunctionHeader | null = null;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] as SourceLine;
		if (activeFunctionHeader !== null) {
			activeFunctionHeader.lines.push(line);
			if (functionHeaderComplete(activeFunctionHeader.lines)) {
				activeFunctionHeader.declaration.range = rangeOfLines(
					coordinates,
					activeFunctionHeader.lines[0] as SourceLine,
					line,
				);
				const signature = signatureOfLines(activeFunctionHeader.lines);
				if (signature !== undefined) activeFunctionHeader.declaration.signature = signature;
				addFunctionParameters(
					declarations,
					module,
					compose,
					activeFunctionHeader.declaration,
					activeFunctionHeader.scope,
					tokens,
				);
				scopes.push({
					indent: activeFunctionHeader.indent,
					descriptors: [
						...activeFunctionHeader.scope.descriptors,
						{ kind: "method", name: activeFunctionHeader.declaration.name },
					],
					containerId: activeFunctionHeader.declaration.symbolId,
					functionScope: true,
				});
				activeFunctionHeader = null;
			}
			continue;
		}

		const parsedLines = parseLineHeads(line);
		if (isIgnorable(line)) continue;

		const indent = indentOf(line.text);
		if (activeEnum !== null) {
			if (indent <= activeEnum.indent || parsedLines.length > 0) {
				activeEnum = null;
			} else {
				const member = multilineEnumMember(line);
				if (member !== null && !activeEnum.names.has(member.name)) {
					activeEnum.names.add(member.name);
					const declaration = makeDeclaration(
						compose,
						module,
						coordinates,
						line,
						member,
						"const",
						member.name,
						{
							indent: activeEnum.indent,
							descriptors: activeEnum.descriptors,
							containerId: activeEnum.containerId,
							functionScope: false,
						},
						"enumMember",
						visibilityOf(member.name, false),
					);
					attachDocumentation(declaration, lines, lineIndex, documentedLines);
					declarations.push(declaration);
				}
				continue;
			}
		}
		while (scopes.length > 1 && indent <= (scopes[scopes.length - 1] as Scope).indent) scopes.pop();
		for (const parsed of parsedLines) {
			if (parsed.keyword === "class_name") continue;
			const scope = scopes[scopes.length - 1] as Scope;
			if (parsed.keyword === "func" && parsed.name === null) {
				scopes.push({
					indent,
					descriptors: scope.descriptors,
					containerId: scope.containerId,
					functionScope: true,
				});
				continue;
			}
			if (parsed.name === null || parsed.keyword === "extends") continue;

			if (parsed.keyword === "class") {
				const declaration = makeDeclaration(
					compose,
					module,
					coordinates,
					line,
					parsed.name,
					parsed.keyword,
					parsed.name.name,
					scope,
					"innerClass",
					visibilityOf(parsed.name.name, false),
				);
				attachDocumentation(declaration, lines, lineIndex, documentedLines);
				declarations.push(declaration);
				scopes.push({
					indent,
					descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
					containerId: declaration.symbolId,
					functionScope: false,
				});
				continue;
			}
			if (parsed.keyword === "enum") {
				const declaration = makeDeclaration(
					compose,
					module,
					coordinates,
					line,
					parsed.name,
					parsed.keyword,
					parsed.name.name,
					scope,
					"enum",
					visibilityOf(parsed.name.name, false),
				);
				attachDocumentation(declaration, lines, lineIndex, documentedLines);
				declarations.push(declaration);
				for (const member of enumMembers(line)) {
					const memberDeclaration = makeDeclaration(
						compose,
						module,
						coordinates,
						line,
						member,
						"const",
						member.name,
						{
							...scope,
							descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
							containerId: declaration.symbolId,
						},
						"enumMember",
						visibilityOf(member.name, false),
					);
					declarations.push(memberDeclaration);
				}
				if (containsCharacter(line.code, "{") && !containsCharacter(line.code, "}")) {
					activeEnum = {
						indent,
						descriptors: [...scope.descriptors, { kind: "type", name: parsed.name.name }],
						containerId: declaration.symbolId,
						names: new Set(enumMembers(line).map((member) => member.name)),
					};
				}
				continue;
			}

			const local = scope.functionScope;
			const languageKind =
				parsed.keyword === "signal"
					? "signal"
					: parsed.keyword === "func"
						? parsed.static
							? "static"
							: undefined
						: local
							? undefined
							: "property";
			const declaration = makeDeclaration(
				compose,
				module,
				coordinates,
				line,
				parsed.name,
				parsed.keyword,
				parsed.name.name,
				scope,
				languageKind,
				visibilityOf(parsed.name.name, local),
			);
			attachDocumentation(declaration, lines, lineIndex, documentedLines);
			if (parsed.keyword === "var") {
				declaration.range = rangeOfLines(coordinates, line, accessorEndLine(lines, lineIndex, indent));
			}
			declarations.push(declaration);
			if (parsed.keyword !== "func") continue;
			if (functionHeaderComplete([line])) {
				addFunctionParameters(declarations, module, compose, declaration, scope, tokens);
				scopes.push({
					indent,
					descriptors: [...scope.descriptors, { kind: "method", name: parsed.name.name }],
					containerId: declaration.symbolId,
					functionScope: true,
				});
			} else {
				activeFunctionHeader = {
					indent,
					scope,
					declaration,
					lines: [line],
				};
			}
		}
	}

	return declarations.map((declaration) => {
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") return declaration;
		const start = lines[declaration.range.start.line] as SourceLine | undefined;
		const end = lines[bodyEndLine(lines, declaration) - 1] as SourceLine | undefined;
		return start === undefined || end === undefined
			? declaration
			: { ...declaration, range: rangeOfLines(coordinates, start, end) };
	});
}

function bodyEndLine(lines: SourceLine[], declaration: DeclarationFact): number {
	const header = lines[declaration.range.start.line] as SourceLine | undefined;
	if (header === undefined) return declaration.range.end.line + 1;
	const headerIndent = indentOf(header.text);
	const headerEnd = headerEndLine(lines, declaration);
	let last = headerEnd;
	for (let index = headerEnd + 1; index < lines.length; index++) {
		const line = lines[index] as SourceLine;
		const indent = indentOf(line.text);
		if (isIgnorable(line)) {
			if (line.text.trim() !== "" && indent > headerIndent) last = index;
			continue;
		}
		if (indent <= headerIndent) break;
		last = index;
	}
	return last + 1;
}

function functionParameterCount(lines: SourceLine[], declaration: DeclarationFact): number {
	const code = lines
		.slice(declaration.range.start.line, headerEndLine(lines, declaration) + 1)
		.map((line) => line.code)
		.join("\n");
	const open = code.indexOf("(");
	if (open < 0) return 0;
	let depth = 0;
	let brackets = 0;
	let braces = 0;
	let parameters = 0;
	let hasValue = false;
	for (let index = open; index < code.length; index++) {
		const character = code[index] as string;
		if (character === "(") {
			depth++;
			continue;
		}
		if (character === ")") {
			depth--;
			if (depth === 0) return parameters + (hasValue ? 1 : 0);
			continue;
		}
		if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		if (depth !== 1) continue;
		if (character === "," && brackets === 0 && braces === 0) {
			if (hasValue) parameters++;
			hasValue = false;
			continue;
		}
		if (!/\s/.test(character)) hasValue = true;
	}
	return parameters + (hasValue ? 1 : 0);
}

function controlHeader(code: string): string | null {
	const trimmed = code.trimStart();
	for (const keyword of ["if", "elif", "else", "for", "while", "match"]) {
		if (trimmed === keyword || trimmed.startsWith(`${keyword} `) || trimmed.startsWith(`${keyword}:`))
			return keyword;
	}
	return null;
}

function topLevelColon(code: string): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = 0; index < code.length; index++) {
		const character = code[index] as string;
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		else if (character === ":" && parentheses === 0 && brackets === 0 && braces === 0) return index;
	}
	return -1;
}

function matchArmCount(lines: SourceLine[], start: number, end: number): number {
	const matches: { indent: number; armIndent: number | null }[] = [];
	let count = 0;
	for (let index = start; index < end; index++) {
		const line = lines[index] as SourceLine;
		if (!meaningfulLine(line)) continue;
		const indent = indentOf(line.text);
		while (matches.length > 0 && indent <= (matches[matches.length - 1] as { indent: number }).indent)
			matches.pop();
		const current = matches[matches.length - 1];
		if (current !== undefined && indent > current.indent) {
			if (current.armIndent === null) current.armIndent = indent;
			if (indent === current.armIndent && topLevelColon(line.code) >= 0) count++;
		}
		if (controlHeader(line.code) === "match") matches.push({ indent, armIndent: null });
	}
	return count;
}

function meaningfulLine(line: SourceLine): boolean {
	return !isIgnorable(line);
}

function bodyMetrics(lines: SourceLine[], start: number, end: number): Pick<Metrics, "nesting" | "branches"> {
	const controls: number[] = [];
	let nesting = 0;
	let branches = matchArmCount(lines, start, end);
	for (let index = start; index < end; index++) {
		const line = lines[index] as SourceLine;
		if (!meaningfulLine(line)) continue;
		const indent = indentOf(line.text);
		while (controls.length > 0 && indent <= (controls[controls.length - 1] as number)) controls.pop();
		nesting = Math.max(nesting, controls.length);
		const header = controlHeader(line.code);
		if (header !== null) {
			if (header !== "match") branches++;
			controls.push(indent);
		}
		if (!/^\s*(?:if|elif|else|for|while|match)\b/.test(line.code)) {
			if (/\bif\b/.test(line.code) && /\belse\b/.test(line.code)) branches++;
			branches += (line.code.match(/\b(?:and|or)\b/g) ?? []).length;
		}
	}
	return { nesting, branches: branches + 1 };
}

function metricsForDeclaration(lines: SourceLine[], declaration: DeclarationFact): Metrics {
	const metrics: Metrics = {
		lines: declaration.range.end.line - declaration.range.start.line + 1,
	};
	if (declaration.kind !== "method") return metrics;
	const headerEnd = headerEndLine(lines, declaration);
	const end = bodyEndLine(lines, declaration);
	const lastBodyLine = Math.max(headerEnd, end - 1);
	metrics.lines = lastBodyLine - declaration.range.start.line + 1;
	metrics.parameters = functionParameterCount(lines, declaration);
	const bodyStart = headerEnd + 1;
	if (bodyStart < end && lines.slice(bodyStart, end).some(meaningfulLine)) {
		Object.assign(metrics, bodyMetrics(lines, bodyStart, end));
	}
	return metrics;
}

function addDeclarationMetrics(declarations: DeclarationFact[], text: string): DeclarationFact[] {
	const lines = readLines(text);
	return declarations.map((declaration) => ({ ...declaration, metrics: metricsForDeclaration(lines, declaration) }));
}

function extractGeneric(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const declarations: DeclarationFact[] = [];
	const coordinates = coordinatesOf(text);
	for (const line of readLines(text)) {
		const parsed = parseLineHead(line, true);
		if (parsed === null || parsed.name === null) continue;
		const declaration = makeDeclaration(
			compose,
			module,
			coordinates,
			line,
			parsed.name,
			parsed.keyword,
			parsed.name.name,
			{ indent: -1, descriptors: [], containerId: "", functionScope: false },
			undefined,
			"public",
			true,
		);
		declarations.push({
			...declaration,
			kind: parsed.keyword === "class" ? "class" : parsed.keyword === "func" ? "function" : "constant",
		});
	}
	return declarations;
}

//////// References

const referenceOperators = [
	"**=",
	">>=",
	"<<=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"->",
	":=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"**",
	"<<",
	">>",
	"++",
	"--",
];

const referenceAssignmentOperators = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"<<=",
	">>=",
	"&=",
	"|=",
	"^=",
	":=",
]);

const referenceKeywords = new Set([
	"and",
	"as",
	"await",
	"break",
	"class",
	"class_name",
	"const",
	"continue",
	"elif",
	"else",
	"enum",
	"extends",
	"false",
	"for",
	"func",
	"if",
	"in",
	"is",
	"match",
	"not",
	"null",
	"or",
	"pass",
	"return",
	"self",
	"signal",
	"static",
	"super",
	"true",
	"var",
	"void",
	"when",
	"while",
]);

const referenceCallKeywords = new Set([
	"class",
	"class_name",
	"const",
	"enum",
	"extends",
	"for",
	"func",
	"if",
	"match",
	"return",
	"signal",
	"when",
	"while",
]);

function referenceTokens(lines: SourceLine[]): ReferenceToken[] {
	const cursor = new Cursor(lines.map((line) => line.code).join("\n"));
	const tokens: ReferenceToken[] = [];
	while (cursor.good()) {
		const character = cursor.peek();
		if (character === "\n") {
			const line = cursor.line;
			const column = cursor.column;
			cursor.next();
			tokens.push({ kind: "newline", value: "\n", line, character: column });
			continue;
		}
		if (character === " " || character === "\t" || character === "\r") {
			cursor.next();
			continue;
		}
		const line = cursor.line;
		const column = cursor.column;
		if (isIdentifierStart(character)) {
			let value = cursor.next();
			while (isIdentifierPart(cursor.peek())) value += cursor.next();
			tokens.push({ kind: "identifier", value, line, character: column });
			continue;
		}
		const operator = referenceOperators.find((candidate) =>
			candidate.split("").every((part, index) => cursor.peek(index) === part),
		);
		if (operator !== undefined) {
			for (let index = 0; index < operator.length; index++) cursor.next();
			tokens.push({ kind: "symbol", value: operator, line, character: column });
			continue;
		}
		tokens.push({ kind: "symbol", value: cursor.next(), line, character: column });
	}
	return tokens;
}

interface OpenDelimiter {
	value: "(" | "[" | "{";
	position: Position;
}

interface PendingBlockHeader {
	indent: number;
	range: Range;
}

function diagnosticAt(module: string, message: string, range: Range): Diagnostic {
	return { severity: "error", message, range, path: module };
}

function pointRange(position: Position, length = 1): Range {
	return {
		start: position,
		end: { line: position.line, character: position.character + length },
	};
}

function blockHeaderRange(line: SourceLine): Range | null {
	const end = line.code.trimEnd().length;
	if (end === 0 || line.code[end - 1] !== ":") return null;
	if (line.stringStarts.some((start) => start >= end)) return null;
	return {
		start: { line: line.line, character: end - 1 },
		end: { line: line.line, character: end },
	};
}

function syntaxMeaningful(line: SourceLine): boolean {
	return line.hasString || !isIgnorable(line);
}

function lineContinues(line: SourceLine): boolean {
	return line.code.trimEnd().endsWith("\\");
}

function closingDelimiter(value: string): OpenDelimiter["value"] | null {
	if (value === ")") return "(";
	if (value === "]") return "[";
	if (value === "}") return "{";
	return null;
}

export function extractDiagnosticsCore(module: string, text: string): Diagnostic[] {
	if (!module.endsWith(".gd")) return [];
	const scanned = scanSource(text);
	const diagnostics = scanned.unterminatedStrings.map((position) =>
		diagnosticAt(module, "String literal has no closing quote.", pointRange(position)),
	);
	const tokensByLine = new Map<number, ReferenceToken[]>();
	for (const token of referenceTokens(scanned.lines)) {
		const lineTokens = tokensByLine.get(token.line) ?? [];
		lineTokens.push(token);
		tokensByLine.set(token.line, lineTokens);
	}

	const delimiters: OpenDelimiter[] = [];
	const indentationLevels = [0];
	let logicalStart: SourceLine | null = null;
	let pendingHeader: PendingBlockHeader | null = null;
	for (const line of scanned.lines) {
		if (logicalStart === null && syntaxMeaningful(line)) {
			logicalStart = line;
			const indent = indentOf(line.text);
			const currentIndent = indentationLevels[indentationLevels.length - 1] as number;
			const opensBody = pendingHeader !== null && indent > pendingHeader.indent;
			if (pendingHeader !== null && !opensBody) {
				diagnostics.push(diagnosticAt(module, "Block header has no indented body.", pendingHeader.range));
			}
			pendingHeader = null;
			if (opensBody && indent > currentIndent) {
				indentationLevels.push(indent);
			} else if (indent < currentIndent) {
				while (
					indentationLevels.length > 1 &&
					indent < (indentationLevels[indentationLevels.length - 1] as number)
				) {
					indentationLevels.pop();
				}
				if (indent !== indentationLevels[indentationLevels.length - 1]) {
					diagnostics.push(
						diagnosticAt(module, "Indentation dedents to a level that was not opened.", {
							start: { line: line.line, character: 0 },
							end: { line: line.line, character: indentationEnd(line.text) },
						}),
					);
					indentationLevels.push(indent);
				}
			}
		}

		for (const token of tokensByLine.get(line.line) ?? []) {
			if (token.value === "(" || token.value === "[" || token.value === "{") {
				delimiters.push({ value: token.value, position: { line: token.line, character: token.character } });
				continue;
			}
			const opening = closingDelimiter(token.value);
			if (opening !== null && delimiters[delimiters.length - 1]?.value === opening) delimiters.pop();
		}

		const continues = delimiters.length > 0 || line.endsInString || lineContinues(line);
		if (logicalStart !== null && !continues) {
			const headerRange = blockHeaderRange(line);
			if (headerRange !== null) pendingHeader = { indent: indentOf(logicalStart.text), range: headerRange };
			logicalStart = null;
		}
	}

	if (pendingHeader !== null) {
		diagnostics.push(diagnosticAt(module, "Block header has no indented body.", pendingHeader.range));
	}
	for (const delimiter of delimiters) {
		diagnostics.push(
			diagnosticAt(
				module,
				`Opening ${JSON.stringify(delimiter.value)} is not closed before end of file.`,
				pointRange(delimiter.position),
			),
		);
	}
	return diagnostics.sort((left, right) => {
		const leftStart = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
		const rightStart = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
		return leftStart.line - rightStart.line || leftStart.character - rightStart.character;
	});
}

function nextReferenceToken(tokens: ReferenceToken[], index: number): number {
	let next = index + 1;
	while (next < tokens.length && tokens[next]?.kind === "newline") next++;
	return next < tokens.length ? next : -1;
}

function matchingReferenceToken(tokens: ReferenceToken[], start: number, open: string, close: string): number {
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === open) depth++;
		if (value === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function addReferenceTypeExpression(
	tokens: ReferenceToken[],
	start: number,
	stops: Set<string>,
	typePositions: Set<string>,
	heritagePositions?: Set<string>,
): void {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind === "newline" && parentheses === 0 && brackets === 0 && braces === 0) break;
		if (parentheses === 0 && brackets === 0 && braces === 0 && stops.has(token.value)) break;
		if (token.value === "(") parentheses++;
		else if (token.value === ")") {
			if (parentheses === 0) break;
			parentheses--;
		} else if (token.value === "[") brackets++;
		else if (token.value === "]") brackets--;
		else if (token.value === "{") braces++;
		else if (token.value === "}") {
			if (braces === 0) break;
			braces--;
		} else if (token.kind === "identifier") {
			(heritagePositions ?? typePositions).add(`${token.line}:${token.character}`);
		}
	}
}

function addReferenceParameters(
	tokens: ReferenceToken[],
	start: number,
	end: number,
	parameterPositions: Set<string>,
): void {
	let segmentStart = start;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	const addSegment = (from: number, to: number): void => {
		for (let index = from; index < to; index++) {
			const token = tokens[index] as ReferenceToken;
			if (token.kind === "identifier") {
				parameterPositions.add(`${token.line}:${token.character}`);
				return;
			}
		}
	};
	for (let index = start; index < end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
			addSegment(segmentStart, index);
			segmentStart = index + 1;
		}
	}
	addSegment(segmentStart, end);
}

export function extractGdscriptParameterNames(text: string): Set<string> {
	const tokens = referenceTokens(readLines(text));
	const parameterPositions = new Set<string>();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier" || token.value !== "func") continue;
		let open = nextReferenceToken(tokens, index);
		while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
		if (open < 0) continue;
		const close = matchingReferenceToken(tokens, open, "(", ")");
		if (close >= 0) addReferenceParameters(tokens, open + 1, close, parameterPositions);
	}
	return new Set(
		tokens
			.filter(
				(token) => token.kind === "identifier" && parameterPositions.has(`${token.line}:${token.character}`),
			)
			.map((token) => token.value),
	);
}

function referenceBlockEnd(lines: SourceLine[], headerEndLine: number, indent: number): number {
	for (let index = headerEndLine + 1; index < lines.length; index++) {
		const line = lines[index] as SourceLine;
		if (!isIgnorable(line) && indentOf(line.text) <= indent) return index - 1;
	}
	return lines.length - 1;
}

function referenceBlocks(lines: SourceLine[], declarations: DeclarationFact[]): ReferenceBlock[] {
	const blocks: ReferenceBlock[] = [];
	for (const declaration of declarations.slice(1)) {
		if (declaration.kind === "property" && declaration.range.end.line > declaration.range.start.line) {
			let accessorLine = declaration.range.start.line + 1;
			while (accessorLine < lines.length && isIgnorable(lines[accessorLine] as SourceLine)) accessorLine++;
			const accessor = lines[accessorLine] as SourceLine | undefined;
			if (accessor !== undefined && isAccessorHead(accessor)) {
				blocks.push({
					startLine: accessorLine,
					endLine: declaration.range.end.line,
					indent: indentOf(accessor.text),
					containerId: declaration.symbolId,
					functionId: declaration.symbolId,
				});
			}
			continue;
		}
		if (declaration.kind !== "method" && declaration.languageKind !== "innerClass") continue;
		const line = lines[declaration.range.start.line] as SourceLine | undefined;
		if (line === undefined) continue;
		const indent = indentOf(line.text);
		blocks.push({
			startLine: declaration.range.start.line,
			endLine: referenceBlockEnd(lines, headerEndLine(lines, declaration), indent),
			indent,
			containerId: declaration.symbolId,
			...(declaration.kind === "method" ? { functionId: declaration.symbolId } : {}),
		});
	}
	return blocks;
}

function referenceScopeAtLine(blocks: ReferenceBlock[], rootId: string, line: number): ReferenceBlock {
	let selected: ReferenceBlock = { startLine: -1, endLine: Number.MAX_SAFE_INTEGER, indent: -1, containerId: rootId };
	for (const block of blocks) {
		if (line >= block.startLine && line <= block.endLine && block.startLine >= selected.startLine) selected = block;
	}
	return selected;
}

function referenceRange(token: ReferenceToken) {
	return {
		start: { line: token.line, character: token.character },
		end: { line: token.line, character: token.character + token.value.length },
	};
}

function referenceBinding(
	name: string,
	scope: ReferenceBlock,
	localNames: Map<string, Set<string>>,
	parameterNames: Map<string, Set<string>>,
): Reference["binding"] {
	const functionNames = localNames.get(scope.functionId ?? "");
	const functionParameters = parameterNames.get(scope.functionId ?? scope.containerId);
	if (functionNames?.has(name) || functionParameters?.has(name)) {
		return { status: "unbound", reason: "NotIndexed", detail: "the declaration is not in the symbol index" };
	}
	return { status: "unbound", reason: "NotImplemented", detail: "GDScript binding is not implemented" };
}

function referenceIsNamedArgument(tokens: ReferenceToken[], assignmentIndex: number): boolean {
	let previous = assignmentIndex - 1;
	while (previous >= 0 && (tokens[previous] as ReferenceToken).kind === "newline") previous--;
	if (previous < 0 || (tokens[previous] as ReferenceToken).kind !== "identifier") return false;
	let parentheses = 0;
	for (let index = previous - 1; index >= 0; index--) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === ")") parentheses++;
		if (value === "(") {
			if (parentheses > 0) {
				parentheses--;
				continue;
			}
			let before = index - 1;
			while (before >= 0 && (tokens[before] as ReferenceToken).kind === "newline") before--;
			const token = tokens[before] as ReferenceToken | undefined;
			return token?.kind === "identifier" && !referenceCallKeywords.has(token.value);
		}
	}
	return false;
}

function referenceIsAccessorHead(tokens: ReferenceToken[], index: number): boolean {
	const open = nextReferenceToken(tokens, index);
	if (open < 0 || (tokens[open] as ReferenceToken).value !== "(") return false;
	const close = matchingReferenceToken(tokens, open, "(", ")");
	const after = close < 0 ? -1 : nextReferenceToken(tokens, close);
	return after >= 0 && (tokens[after] as ReferenceToken).value === ":";
}

function extractGdscriptReferences(module: string, text: string, compose: ComposeSymbolId): Reference[] {
	const lines = readLines(text);
	const declarations = extractGdscript(module, text, compose);
	const tokens = referenceTokens(lines);
	const declarationPositions = new Set(
		declarations.map(
			(declaration) => `${declaration.selectionRange.start.line}:${declaration.selectionRange.start.character}`,
		),
	);
	const parameterPositions = new Set<string>();
	const typePositions = new Set<string>();
	const heritagePositions = new Set<string>();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.value === "->") {
			addReferenceTypeExpression(tokens, index + 1, new Set([":"]), typePositions);
			continue;
		}
		if (token.kind !== "identifier") continue;
		if (
			token.value === "func" ||
			token.value === "signal" ||
			((token.value === "get" || token.value === "set") && referenceIsAccessorHead(tokens, index))
		) {
			let open = nextReferenceToken(tokens, index);
			while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
			if (open >= 0 && (tokens[open] as ReferenceToken).value === "(") {
				const close = matchingReferenceToken(tokens, open, "(", ")");
				if (close >= 0) addReferenceParameters(tokens, open + 1, close, parameterPositions);
			}
		}
		if (token.value === "as" || token.value === "is") {
			addReferenceTypeExpression(tokens, index + 1, new Set([",", ")", "]", "=", ":", "in"]), typePositions);
		}
		if (token.value === "extends") {
			addReferenceTypeExpression(tokens, index + 1, new Set([":"]), typePositions, heritagePositions);
		}
	}
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier") continue;
		const next = nextReferenceToken(tokens, index);
		if (
			(declarationPositions.has(`${token.line}:${token.character}`) ||
				parameterPositions.has(`${token.line}:${token.character}`)) &&
			next >= 0 &&
			(tokens[next] as ReferenceToken).value === ":"
		) {
			addReferenceTypeExpression(tokens, next + 1, new Set(["=", ",", ")", "in", ":"]), typePositions);
		}
	}

	const blocks = referenceBlocks(lines, declarations);
	const rootId = (declarations[0] as DeclarationFact).symbolId;
	const localNames = new Map<string, Set<string>>();
	for (const declaration of declarations) {
		if (declaration.visibility !== "local" || declaration.containerId === undefined) continue;
		const names = localNames.get(declaration.containerId) ?? new Set<string>();
		names.add(declaration.name);
		localNames.set(declaration.containerId, names);
	}
	const parameterNames = new Map<string, Set<string>>();
	for (const token of tokens) {
		if (token.kind !== "identifier" || !parameterPositions.has(`${token.line}:${token.character}`)) continue;
		const scope = referenceScopeAtLine(blocks, rootId, token.line);
		const ownerId = scope.functionId ?? scope.containerId;
		const names = parameterNames.get(ownerId) ?? new Set<string>();
		names.add(token.value);
		parameterNames.set(ownerId, names);
	}

	const references: Reference[] = [];
	const pathReferences: Reference[] = [];
	const literalLoaderPositions = new Set<string>();
	const addPathReference = (line: SourceLine, name: string, start: number, role: Reference["role"]): void => {
		const scope = referenceScopeAtLine(blocks, rootId, line.line);
		pathReferences.push({
			name,
			range: {
				start: { line: line.line, character: start },
				end: { line: line.line, character: start + name.length },
			},
			role,
			binding: referenceBinding(name, scope, localNames, parameterNames),
			fromId: scope.containerId,
		});
	};
	for (const line of lines) {
		const extendsPath = literalExtendsPath(line);
		if (extendsPath !== null) addPathReference(line, extendsPath.path, extendsPath.start, "extends");
		// Same reason as literalExtendsPath: indexOf found the loader word in `preload("preload")`.
		for (const match of line.text.matchAll(/\b(preload|load)\s*\(\s*&?\s*(["'])([^"']+)\2/dg)) {
			const loaderStart = match.index ?? -1;
			const loader = match[1] ?? "";
			const name = match[3] ?? "";
			const pathStart = match.indices?.[3]?.[0];
			if (loaderStart < 0 || name === "" || pathStart === undefined) continue;
			if (!line.code.startsWith(loader, loaderStart)) continue;
			literalLoaderPositions.add(`${line.line}:${loaderStart}`);
			addPathReference(line, name, pathStart, "import");
		}
	}
	const addReference = (
		token: ReferenceToken,
		role: Reference["role"],
		binding = referenceBinding(
			token.value,
			referenceScopeAtLine(blocks, rootId, token.line),
			localNames,
			parameterNames,
		),
	): void => {
		const scope = referenceScopeAtLine(blocks, rootId, token.line);
		references.push({
			name: token.value,
			range: referenceRange(token),
			role,
			binding,
			fromId: scope.containerId,
		});
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier") continue;
		const tokenKey = `${token.line}:${token.character}`;
		const next = nextReferenceToken(tokens, index);
		const nextValue = next < 0 ? "" : (tokens[next] as ReferenceToken).value;
		const previous = index > 0 ? (tokens[index - 1] as ReferenceToken) : undefined;
		if (token.value === "for") {
			if (next >= 0 && (tokens[next] as ReferenceToken).kind === "identifier")
				addReference(tokens[next] as ReferenceToken, "write");
			continue;
		}
		if (token.value === "extends") {
			let target = nextReferenceToken(tokens, index);
			while (target >= 0 && (tokens[target] as ReferenceToken).kind !== "newline") {
				const candidate = tokens[target] as ReferenceToken;
				if (
					candidate.kind === "identifier" &&
					heritagePositions.has(`${candidate.line}:${candidate.character}`)
				) {
					addReference(candidate, "extends");
					break;
				}
				target++;
			}
			continue;
		}
		if (token.value === "preload" || token.value === "load") {
			if (!literalLoaderPositions.has(tokenKey) && next >= 0 && nextValue === "(")
				addReference(token, "call", {
					status: "unbound",
					reason: "RuntimeConstructed",
					detail: "the loader path is computed at runtime",
				});
			continue;
		}
		if (token.value === "new" && previous?.value === ".") continue;
		if (heritagePositions.has(tokenKey)) continue;
		if (typePositions.has(tokenKey)) {
			addReference(token, "typeUse");
			continue;
		}
		if (declarationPositions.has(tokenKey) || parameterPositions.has(tokenKey)) continue;
		if (referenceKeywords.has(token.value) || previous?.value === "@") continue;
		if ((token.value === "get" || token.value === "set") && referenceIsAccessorHead(tokens, index)) continue;
		const increment = nextValue === "++" || previous?.value === "++";
		if (increment) {
			addReference(token, "read");
			addReference(token, "write");
			continue;
		}
		if (referenceAssignmentOperators.has(nextValue) && !referenceIsNamedArgument(tokens, index)) {
			if (nextValue !== "=" && nextValue !== ":=") addReference(token, "read");
			addReference(token, "write");
			continue;
		}
		if (nextValue === "(") {
			if (
				!referenceCallKeywords.has(token.value) &&
				token.value !== "new" &&
				!referenceIsAccessorHead(tokens, index)
			) {
				addReference(token, "call");
			}
			continue;
		}
		addReference(token, "read");
	}
	return [...references, ...pathReferences];
}

export function extractDeclarationsCore(module: string, text: string, compose: ComposeSymbolId): DeclarationFact[] {
	const declarations = module.endsWith(".gd")
		? extractGdscript(module, text, compose)
		: extractGeneric(module, text, compose);
	return module.endsWith(".gd") ? addDeclarationMetrics(declarations, text) : declarations;
}

export interface TypeAnnotationFact {
	symbolId?: string;
	targetRange: Range;
	typeRange: Range;
	display: string;
}

export interface ImportFact {
	specifier: string;
	imported: ImportedName[];
	reExport: boolean;
}

interface LiteralImportSyntax {
	specifier: string;
	start: number;
	end: number;
	line: number;
	loaderStart: number;
}

function literalImportSyntax(module: string, text: string): LiteralImportSyntax[] {
	if (!module.endsWith(".gd")) return [];
	const coordinates = coordinatesOf(text);
	const lines = readLines(text);
	const syntax: LiteralImportSyntax[] = [];
	for (const line of lines) {
		const extendsPath = literalExtendsPath(line);
		if (extendsPath !== null) {
			const start = coordinates.offsetAt({ line: line.line, character: extendsPath.start - 1 });
			const end = coordinates.offsetAt({
				line: line.line,
				character: extendsPath.start + extendsPath.path.length + 1,
			});
			if (start !== undefined && end !== undefined) {
				syntax.push({ specifier: extendsPath.path, start, end, line: line.line, loaderStart: -1 });
			}
		}
		for (const match of line.text.matchAll(/\b(preload|load)\s*\(\s*&?\s*(["'])([^"']+)\2/g)) {
			const loaderStart = match.index ?? -1;
			const loader = match[1] ?? "";
			const specifier = match[3] ?? "";
			const full = match[0] ?? "";
			if (loaderStart < 0 || specifier === "" || !line.code.startsWith(loader, loaderStart)) continue;
			const quoteStart = full.indexOf(match[2] ?? "");
			const typedPrefix = quoteStart > 0 && full[quoteStart - 1] === "&" ? 1 : 0;
			const start = coordinates.offsetAt({
				line: line.line,
				character: loaderStart + quoteStart - typedPrefix,
			});
			const end = coordinates.offsetAt({
				line: line.line,
				character: loaderStart + full.lastIndexOf(match[2] ?? "") + 1,
			});
			if (start !== undefined && end !== undefined)
				syntax.push({ specifier, start, end, line: line.line, loaderStart });
		}
	}
	return syntax;
}

function tokenIndexAt(tokens: ReferenceToken[], position: Position): number {
	return tokens.findIndex((token) => token.line === position.line && token.character === position.character);
}

function typeExpressionEnd(tokens: ReferenceToken[], start: number, stops: Set<string>, allowNewline = false): number {
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind === "newline" && !allowNewline && parentheses === 0 && brackets === 0 && braces === 0)
			return index;
		if (parentheses === 0 && brackets === 0 && braces === 0 && stops.has(token.value)) return index;
		if (token.value === "(") parentheses++;
		else if (token.value === ")") parentheses--;
		else if (token.value === "[") brackets++;
		else if (token.value === "]") brackets--;
		else if (token.value === "{") braces++;
		else if (token.value === "}") braces--;
	}
	return tokens.length;
}

function sourceBetween(coordinates: TextCoordinates, start: ReferenceToken, end: ReferenceToken): string | undefined {
	return coordinates.sliceRange({
		start: { line: start.line, character: start.character },
		end: { line: end.line, character: end.character + end.value.length },
	});
}

function typeFact(
	coordinates: TextCoordinates,
	tokens: ReferenceToken[],
	start: number,
	end: number,
	targetRange: Range,
	symbolId?: string,
): TypeAnnotationFact | null {
	if (end <= start) return null;
	const first = tokens[start] as ReferenceToken;
	const last = tokens[end - 1] as ReferenceToken;
	if (first.kind === "newline" || last.kind === "newline") return null;
	const display = sourceBetween(coordinates, first, last)?.trim();
	if (display === undefined || display === "") return null;
	return {
		...(symbolId === undefined ? {} : { symbolId }),
		targetRange,
		typeRange: {
			start: referenceRange(first).start,
			end: referenceRange(last).end,
		},
		display,
	};
}

function addParameterTypeFacts(
	coordinates: TextCoordinates,
	tokens: ReferenceToken[],
	start: number,
	end: number,
	facts: TypeAnnotationFact[],
	parameterDeclarations: DeclarationFact[],
): void {
	let segmentStart = start;
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	const addSegment = (from: number, to: number): void => {
		let nameIndex = -1;
		for (let index = from; index < to; index++) {
			if ((tokens[index] as ReferenceToken).kind === "identifier") {
				nameIndex = index;
				break;
			}
		}
		if (nameIndex < 0) return;
		let colon = -1;
		for (let index = nameIndex + 1; index < to; index++) {
			const token = tokens[index] as ReferenceToken;
			if (token.value === "=") break;
			if (token.value === ":") {
				colon = index;
				break;
			}
		}
		if (colon < 0) return;
		const typeEnd = typeExpressionEnd(tokens, colon + 1, new Set(["=", ",", ")", ";"]), true);
		const name = tokens[nameIndex] as ReferenceToken;
		const parameter = parameterDeclarations.find(
			(candidate) =>
				candidate.selectionRange.start.line === name.line &&
				candidate.selectionRange.start.character === name.character,
		);
		const fact = typeFact(
			coordinates,
			tokens,
			colon + 1,
			Math.min(typeEnd, to),
			referenceRange(name),
			parameter?.symbolId,
		);
		if (fact !== null) facts.push(fact);
	};
	for (let index = start; index < end; index++) {
		const value = (tokens[index] as ReferenceToken).value;
		if (value === "(") parentheses++;
		else if (value === ")") parentheses--;
		else if (value === "[") brackets++;
		else if (value === "]") brackets--;
		else if (value === "{") braces++;
		else if (value === "}") braces--;
		else if (value === "," && parentheses === 0 && brackets === 0 && braces === 0) {
			addSegment(segmentStart, index);
			segmentStart = index + 1;
		}
	}
	addSegment(segmentStart, end);
}

export function extractTypeAnnotationsCore(
	module: string,
	text: string,
	compose: ComposeSymbolId,
): TypeAnnotationFact[] {
	if (!module.endsWith(".gd")) return [];
	const coordinates = coordinatesOf(text);
	const lines = readLines(text);
	const declarations = extractGdscript(module, text, compose);
	const tokens = referenceTokens(lines);
	const facts: TypeAnnotationFact[] = [];
	for (const declaration of declarations) {
		const nameIndex = tokenIndexAt(tokens, declaration.selectionRange.start);
		if (nameIndex < 0) continue;
		const name = tokens[nameIndex] as ReferenceToken;
		if (
			(declaration.kind === "property" || declaration.kind === "variable" || declaration.kind === "constant") &&
			declaration.languageKind !== "parameter"
		) {
			const colon = nextReferenceToken(tokens, nameIndex);
			if (colon >= 0 && (tokens[colon] as ReferenceToken).value === ":") {
				const typeEnd = typeExpressionEnd(tokens, colon + 1, new Set(["=", ",", ";", "in"]));
				const fact = typeFact(
					coordinates,
					tokens,
					colon + 1,
					typeEnd,
					referenceRange(name),
					declaration.symbolId,
				);
				if (fact !== null) facts.push(fact);
			}
		}
		if (declaration.kind !== "method") continue;
		let open = nextReferenceToken(tokens, nameIndex);
		while (open >= 0 && (tokens[open] as ReferenceToken).value !== "(") open = nextReferenceToken(tokens, open);
		if (open < 0) continue;
		const close = matchingReferenceToken(tokens, open, "(", ")");
		if (close < 0) continue;
		addParameterTypeFacts(
			coordinates,
			tokens,
			open + 1,
			close,
			facts,
			declarations.filter(
				(candidate) => candidate.containerId === declaration.symbolId && candidate.languageKind === "parameter",
			),
		);
		for (let index = close + 1; index <= tokens.length; index++) {
			const token = tokens[index] as ReferenceToken | undefined;
			if (token === undefined || token.line > headerEndLine(lines, declaration)) break;
			if (token.value !== "->") continue;
			const typeEnd = typeExpressionEnd(tokens, index + 1, new Set([":"]));
			const fact = typeFact(coordinates, tokens, index + 1, typeEnd, referenceRange(name), declaration.symbolId);
			if (fact !== null) facts.push(fact);
			break;
		}
	}
	return facts;
}

export function extractReferencesCore(module: string, text: string, compose: ComposeSymbolId): Reference[] {
	return module.endsWith(".gd") ? extractGdscriptReferences(module, text, compose) : [];
}

function importedLoaderName(declarations: DeclarationFact[], line: number, loaderStart: number): ImportedName[] {
	const declaration = declarations
		.filter(
			(candidate) =>
				candidate.selectionRange.start.line === line &&
				candidate.selectionRange.start.character < loaderStart &&
				candidate.selectionRange.end.character <= loaderStart,
		)
		.sort((left, right) => right.selectionRange.start.character - left.selectionRange.start.character)[0];
	if (declaration === undefined) return [];
	return [{ local: declaration.name, localRange: declaration.selectionRange }];
}

export function extractImportsCore(module: string, text: string, compose: ComposeSymbolId): ImportFact[] {
	if (!module.endsWith(".gd")) return [];
	const coordinates = coordinatesOf(text);
	const lines = readLines(text);
	const declarations = extractGdscript(module, text, compose);
	const imports: ImportFact[] = [];
	const literalLoaderPositions = new Set<string>();
	for (const line of lines) {
		const extendsPath = literalExtendsPath(line);
		if (extendsPath !== null) imports.push({ specifier: extendsPath.path, imported: [], reExport: false });
		for (const match of line.text.matchAll(/\b(preload|load)\s*\(\s*&?\s*(["'])([^"']+)\2/g)) {
			const loaderStart = match.index ?? -1;
			const loader = match[1] ?? "";
			const specifier = match[3] ?? "";
			if (loaderStart < 0 || specifier === "" || !line.code.startsWith(loader, loaderStart)) continue;
			literalLoaderPositions.add(`${line.line}:${loaderStart}`);
			imports.push({
				specifier,
				imported: importedLoaderName(declarations, line.line, loaderStart),
				reExport: false,
			});
		}
	}

	const tokens = referenceTokens(lines);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ReferenceToken;
		if (token.kind !== "identifier" || (token.value !== "preload" && token.value !== "load")) continue;
		const tokenKey = `${token.line}:${token.character}`;
		if (literalLoaderPositions.has(tokenKey)) continue;
		const open = nextReferenceToken(tokens, index);
		if (open < 0 || (tokens[open] as ReferenceToken).value !== "(") continue;
		const close = matchingReferenceToken(tokens, open, "(", ")");
		if (close < 0) continue;
		const closing = tokens[close] as ReferenceToken | undefined;
		if (closing === undefined) continue;
		const specifier = sourceBetween(coordinates, token, closing)?.trim();
		if (specifier === undefined || specifier === "") continue;
		imports.push({
			specifier,
			imported: importedLoaderName(declarations, token.line, token.character),
			reExport: false,
		});
	}
	return imports;
}
