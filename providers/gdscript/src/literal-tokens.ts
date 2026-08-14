// Owns GDScript literal parsing and loader literal spans.

import { coordinatesOf, type Literal, type TextCoordinates } from "@nyaa-lexicon/protocol";
import { isIdentifierPart, isIdentifierStart } from "./cursor.js";
import { bodyEndLine, contentEndCharacter } from "./declarations.js";
import type { DeclarationFact, SourceLine } from "./parse-model.js";
import { pathSyntax } from "./path-syntax.js";
import { readLines } from "./source-scan.js";

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

//////// Loader spans

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
		for (const path of pathSyntax(line)) {
			const start = coordinates.offsetAt({ line: line.line, character: path.literalStart });
			const end = coordinates.offsetAt({ line: line.line, character: path.literalEnd });
			if (start !== undefined && end !== undefined) {
				syntax.push({
					specifier: path.path,
					start,
					end,
					line: line.line,
					loaderStart: path.loaderStart,
				});
			}
		}
	}
	return syntax;
}
