// A declaration's header as one line: the one rendering behind every provider's `signature`.
//
// A provider knows its language's spans: where the header starts and stops, which containers are
// written as values, where its comments and literals are. Everything past that is text, and text is
// shared.

import { coordinatesOf, type OffsetRange } from "./coordinates.js";
import { applyEdits, planEdits, type TextEdit } from "./edits.js";

////////////////////////////////
//  Interfaces & Types

/** A literal container written as a value, delimiters included. */
export interface HeaderFold extends OffsetRange {
	/** No delimiters, as an indented suite. Reads as the mark alone. */
	bare?: boolean;
}

/** Where one header sits in its file, as UTF-16 offsets, end exclusive. */
export interface HeaderSpan {
	/** Rendered before `start`: what a declarator shares with its siblings, as a statement's keywords. */
	lead?: OffsetRange;
	/** The first token, decorators and attributes included; never the doc comment. */
	start: number;
	/** Where the body begins, or where the declaration ends. */
	end: number;
	/** Literal containers written as values. The outermost wins. */
	folds?: readonly HeaderFold[];
	/** Text left out, comments included. Ones outside the span are ignored. */
	omit?: readonly OffsetRange[];
	/** String, template and regex literals: kept as written, a line break or tab escaped. */
	verbatim?: readonly OffsetRange[];
}

////////////////////////////////
//  Constants

/** Stands for a folded container's contents. */
export const FOLD_MARK = String.fromCodePoint(0x2026);

/** A line broken after one of these joins without a space. */
const OPENERS = new Set(["(", "[", "<"]);

/** A line broken before one of these joins without a space. */
const TIGHT_BEFORE = new Set([")", "]", ">", ",", ";", "."]);

/** A line broken before one of these drops the trailing comma. */
const CLOSERS = new Set([")", "]", ">", "}"]);

/** An omission before one of these takes the space before it too. */
const JOINS_LEFT = new Set([",", ";", ")", "]"]);

/** Never part of a header. */
const TERMINATORS = new Set([";", ","]);

/** How a literal writes the whitespace a line cannot hold. */
const ESCAPES: Record<string, string> = { "\r\n": "\\n", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** Where the search for a literal's stand-in starts: the private use area. */
const FIRST_MARK = 0xe000;

////////////////////////////////
//  Functions & Helpers

function isSpace(character: string): boolean {
	return character.trim() === "";
}

function isBreak(character: string): boolean {
	return character === "\n" || character === "\r";
}

function isHorizontal(character: string | undefined): boolean {
	return character === " " || character === "\t";
}

function within(piece: OffsetRange, cut: OffsetRange): boolean {
	return cut.start >= piece.start && cut.end <= piece.end && cut.start < cut.end;
}

/** Its delimiters around the mark; an empty one stays as written. */
function folded(text: string, fold: HeaderFold): string {
	const inner = fold.bare === true ? text.slice(fold.start, fold.end) : text.slice(fold.start + 1, fold.end - 1);
	const empty = inner.trim() === "";
	if (fold.bare === true) return empty ? " " : FOLD_MARK;
	const open = text[fold.start] ?? "";
	const close = fold.end - 1 > fold.start ? (text[fold.end - 1] ?? "") : "";
	return `${open}${empty ? "" : FOLD_MARK}${close}`;
}

/** A literal on one line: any whitespace but a space escaped. */
function escaped(literal: string): string {
	return literal.replace(
		/\r\n|[^\S ]/g,
		(space) => ESCAPES[space] ?? `\\u${space.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** A space, or nothing before punctuation, taking the space before it along. */
function omission(text: string, piece: OffsetRange, cut: OffsetRange): OffsetRange & { newText: string } {
	let next = cut.end;
	while (next < piece.end && isHorizontal(text[next])) next++;
	if (!JOINS_LEFT.has(text[next] ?? "")) return { ...cut, newText: " " };
	let start = cut.start;
	while (start > piece.start && isHorizontal(text[start - 1])) start--;
	return { start, end: cut.end, newText: "" };
}

/** A character none of the pieces holds, so a literal's stand-in cannot collide with source. */
function freeMark(text: string, pieces: readonly OffsetRange[]): string {
	const used = new Set<number>();
	for (const piece of pieces) {
		for (const character of text.slice(piece.start, piece.end)) {
			const code = character.codePointAt(0) ?? 0;
			if (code >= FIRST_MARK) used.add(code);
		}
	}
	let code = FIRST_MARK;
	while (used.has(code)) code++;
	return String.fromCodePoint(code);
}

/** One piece with its cuts applied; each literal stands in as its index between two marks. */
function applied(
	text: string,
	piece: OffsetRange,
	span: HeaderSpan,
	mark: string,
	literals: string[],
): string | undefined {
	const slice = text.slice(piece.start, piece.end);
	const coordinates = coordinatesOf(slice);
	const edits: TextEdit[] = [];
	const replace = (start: number, end: number, newText: string): void => {
		const range = coordinates.rangeAt(start - piece.start, end - piece.start);
		if (range !== undefined) edits.push({ range, newText });
	};
	for (const fold of span.folds ?? []) if (within(piece, fold)) replace(fold.start, fold.end, folded(text, fold));
	for (const literal of span.verbatim ?? []) {
		if (!within(piece, literal)) continue;
		replace(literal.start, literal.end, `${mark}${literals.length}${mark}`);
		literals.push(escaped(text.slice(literal.start, literal.end)));
	}
	for (const cut of span.omit ?? []) {
		if (!within(piece, cut)) continue;
		const omitted = omission(text, piece, cut);
		replace(omitted.start, omitted.end, omitted.newText);
	}
	// A cut inside an earlier one overlaps it, and the plan leaves it out.
	const result = applyEdits(slice, planEdits(coordinates, edits).edits);
	return "text" in result ? result.text : undefined;
}

/** Whitespace runs to one space; a broken line joins tight at brackets and loses a trailing comma. */
function collapse(raw: string): string {
	let out = "";
	let gap = false;
	let broken = false;
	for (const character of raw) {
		if (isSpace(character)) {
			gap = true;
			broken ||= isBreak(character);
			continue;
		}
		if (gap && out !== "") {
			if (broken && CLOSERS.has(character) && out.endsWith(",")) out = out.slice(0, -1);
			const tight = broken && (OPENERS.has(out.at(-1) ?? "") || TIGHT_BEFORE.has(character));
			if (!tight) out += " ";
		}
		out += character;
		gap = false;
		broken = false;
	}
	while (TERMINATORS.has(out.at(-1) ?? "")) out = out.slice(0, -1).trimEnd();
	return out;
}

/** One line from the span: omissions dropped, folds marked, literals kept. Undefined if empty. */
export function renderHeader(text: string, span: HeaderSpan): string | undefined {
	if (span.end <= span.start) return undefined;
	const pieces = [...(span.lead === undefined ? [] : [span.lead]), { start: span.start, end: span.end }];
	const mark = freeMark(text, pieces);
	const literals: string[] = [];
	const raws: string[] = [];
	for (const piece of pieces) {
		const raw = applied(text, piece, span, mark, literals);
		if (raw === undefined) return undefined;
		raws.push(raw);
	}
	// Marks pair up, so every odd part is a literal's index.
	const parts = collapse(raws.join(" ")).split(mark);
	const line = parts.map((part, at) => (at % 2 === 1 ? (literals[Number(part)] ?? "") : part)).join("");
	return line === "" ? undefined : line;
}
