// Owns GDScript literal parsing and loader literal spans.

import { coordinatesOf, type Literal, type TextCoordinates } from "@nyaa-lexicon/protocol";
import { isIdentifierPart, isIdentifierStart } from "./cursor.js";
import { bodyEndLine, contentEndCharacter } from "./declarations.js";
import type { DeclarationFact, SourceLine } from "./parse-model.js";
import { pathSyntax } from "./path-syntax.js";
import { scanSource } from "./source-scan.js";

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

/** One lexer: spans for strings, masked code for the rest. */
export function extractLiteralsCore(module: string, text: string, declarations: DeclarationFact[]): Literal[] {
	if (!module.endsWith(".gd") || text.length === 0) return [];
	const coordinates = coordinatesOf(text);
	const scanned = scanSource(text);
	const imported = new Set(literalImportSyntax(module, coordinates, scanned.lines).map((l) => `${l.start}:${l.end}`));
	const found: Array<{ start: number; end: number; literal: Omit<Literal, "range"> }> = [];
	const add = (start: number, end: number, literal: Omit<Literal, "range">): void => {
		if (!imported.has(`${start}:${end}`)) found.push({ start, end, literal });
	};

	for (const span of scanned.strings) {
		const quoteStart = coordinates.offsetAt(span.start);
		const end = coordinates.offsetAt(span.end);
		if (quoteStart === undefined || end === undefined) continue;
		const size = span.triple ? 3 : 1;
		const value = decodeStringContent(text.slice(quoteStart + size, end - size));
		// Typed prefix belongs to the literal.
		const prefix = text[quoteStart - 1];
		const start = prefix === "&" || prefix === "^" ? quoteStart - 1 : quoteStart;
		add(start, end, { kind: "string", value });
	}

	for (const line of scanned.lines) {
		const code = line.code;
		const at = (character: number) => coordinates.offsetAt({ line: line.line, character });
		let index = 0;
		while (index < code.length) {
			const character = code[index] as string;
			const codePoint = code.codePointAt(index);
			const codeCharacter = codePoint === undefined ? character : String.fromCodePoint(codePoint);
			if (isIdentifierStart(codeCharacter)) {
				let end = index + codeCharacter.length;
				while (end < code.length) {
					const nextPoint = code.codePointAt(end);
					if (nextPoint === undefined) break;
					const nextCharacter = String.fromCodePoint(nextPoint);
					if (!isIdentifierPart(nextCharacter)) break;
					end += nextCharacter.length;
				}
				const word = code.slice(index, end);
				const start = at(index);
				const stop = at(end);
				if ((word === "true" || word === "false") && start !== undefined && stop !== undefined) {
					add(start, stop, { kind: "boolean", value: word });
				}
				index = end;
				continue;
			}
			if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(code[index + 1] ?? ""))) {
				const end = numericEnd(code, index);
				const value = code.slice(index, end);
				const number = Number(value.replaceAll("_", ""));
				const start = at(index);
				const stop = at(end);
				if (end > index && Number.isFinite(number) && start !== undefined && stop !== undefined) {
					add(start, stop, { kind: "number", value, number });
				}
				index = end;
				continue;
			}
			index += codeCharacter.length;
		}
	}

	// Containers are matched by a sweep, so offsets must arrive in order.
	const containerFor = literalContainerMatcher(coordinates, scanned.lines, declarations);
	const literals: Literal[] = [];
	for (const { start, end, literal } of found.sort((left, right) => left.start - right.start)) {
		const range = coordinates.rangeAt(start, end);
		if (range === undefined) continue;
		const containerId = containerFor(start);
		literals.push({ ...literal, range, ...(containerId === undefined ? {} : { containerId }) });
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

function literalImportSyntax(module: string, coordinates: TextCoordinates, lines: SourceLine[]): LiteralImportSyntax[] {
	if (!module.endsWith(".gd")) return [];
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
