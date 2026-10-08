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
	/** Text removed with nothing in its place, as a line continuation inside a word. */
	splices?: readonly OffsetRange[];
	/** String, template and regex literals: kept as written, a line break or tab escaped. */
	verbatim?: readonly OffsetRange[];
	/** Offsets of `<` and `>` tokens the parser read as type brackets; any other is an operator. */
	angles?: readonly number[];
}

/** Steps a lookup takes, counted for tests that bound its work instead of timing it. */
export interface WorkMeter {
	steps: number;
}

////////////////////////////////
//  Constants

/** Stands for a folded container's contents. */
export const FOLD_MARK = String.fromCodePoint(0x2026);

/** A line broken after one of these joins without a space; angles join through their marks. */
const OPENERS = new Set(["(", "["]);

/** A line broken before one of these joins without a space. */
const TIGHT_BEFORE = new Set([")", "]", ",", ";", "."]);

/** A line broken before one of these drops the trailing comma. */
const CLOSERS = new Set([")", "]", "}"]);

/** An omission before one of these takes the space before it too. */
const JOINS_LEFT = new Set([",", ";", ")", "]"]);

/** Never part of a header. */
const TERMINATORS = new Set([";", ","]);

/** How a literal writes the whitespace a line cannot hold. */
const ESCAPES: Record<string, string> = { "\r\n": "\\n", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** Where the search for a literal's stand-in starts: the private use area. */
const FIRST_MARK = 0xe000;

const LAST_CODE_POINT = 0x10ffff;

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

/** A literal's text with the splices inside it removed: a line continuation joins its lines. */
function spliced(text: string, literal: OffsetRange, splices: readonly OffsetRange[]): string {
	const slice = text.slice(literal.start, literal.end);
	const coordinates = coordinatesOf(slice);
	const edits: TextEdit[] = [];
	for (const splice of splices) {
		if (!within(literal, splice)) continue;
		const range = coordinates.rangeAt(splice.start - literal.start, splice.end - literal.start);
		if (range !== undefined) edits.push({ range, newText: "" });
	}
	const result = applyEdits(slice, planEdits(coordinates, edits).edits);
	return "text" in result ? result.text : slice;
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

/** Characters none of the pieces holds, so a stand-in cannot collide with source. Null when none are left. */
function freeMarks(text: string, pieces: readonly OffsetRange[], count: number): string[] | null {
	const used = new Set<number>();
	for (const piece of pieces) {
		for (const character of text.slice(piece.start, piece.end)) {
			const code = character.codePointAt(0) ?? 0;
			if (code >= FIRST_MARK) used.add(code);
		}
	}
	const marks: string[] = [];
	for (let code = FIRST_MARK; marks.length < count; code++) {
		if (code > LAST_CODE_POINT) return null;
		if (!used.has(code)) marks.push(String.fromCodePoint(code));
	}
	return marks;
}

/** Stand-ins: the literal mark, and the parser's type brackets. */
interface Marks {
	literal: string;
	open: string;
	close: string;
}

/** One piece with its cuts applied; each literal stands in as its index between two marks. */
function applied(
	text: string,
	piece: OffsetRange,
	span: HeaderSpan,
	marks: Marks,
	literals: string[],
): string | undefined {
	const mark = marks.literal;
	const slice = text.slice(piece.start, piece.end);
	const coordinates = coordinatesOf(slice);
	const edits: TextEdit[] = [];
	const replace = (start: number, end: number, newText: string): void => {
		const range = coordinates.rangeAt(start - piece.start, end - piece.start);
		if (range !== undefined) edits.push({ range, newText });
	};
	for (const fold of span.folds ?? []) if (within(piece, fold)) replace(fold.start, fold.end, folded(text, fold));
	const splices = span.splices ?? [];
	const verbatim = (span.verbatim ?? []).filter((literal) => within(piece, literal));
	for (const literal of verbatim) {
		replace(literal.start, literal.end, `${mark}${literals.length}${mark}`);
		literals.push(escaped(spliced(text, literal, splices)));
	}
	for (const cut of span.omit ?? []) {
		if (!within(piece, cut)) continue;
		const omitted = omission(text, piece, cut);
		replace(omitted.start, omitted.end, omitted.newText);
	}
	// A splice inside a literal was applied to its text above.
	for (const splice of splices) {
		if (within(piece, splice) && !verbatim.some((literal) => within(literal, splice)))
			replace(splice.start, splice.end, "");
	}
	for (const at of span.angles ?? []) {
		if (at < piece.start || at >= piece.end) continue;
		if (text[at] === "<") replace(at, at + 1, marks.open);
		else if (text[at] === ">") replace(at, at + 1, marks.close);
	}
	// A cut inside an earlier one overlaps it, and the plan leaves it out.
	const result = applyEdits(slice, planEdits(coordinates, edits).edits);
	return "text" in result ? result.text : undefined;
}

/** Whitespace runs to one space; a broken line joins tight at brackets and loses a trailing comma. */
function collapse(raw: string, marks: Marks): string {
	const opens = (character: string) => OPENERS.has(character) || character === marks.open;
	const closes = (character: string) => CLOSERS.has(character) || character === marks.close;
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
			// A comma after an opener or another comma holds an empty slot, as `Dictionary<,>` does.
			const trailing = out.endsWith(",") && !opens(out.at(-2) ?? "") && out.at(-2) !== ",";
			if (broken && closes(character) && trailing) out = out.slice(0, -1);
			const tight =
				broken && (opens(out.at(-1) ?? "") || TIGHT_BEFORE.has(character) || character === marks.close);
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
export function renderHeader(text: string, span: HeaderSpan, meter?: WorkMeter): string | undefined {
	if (span.end <= span.start) return undefined;
	const pieces = [...(span.lead === undefined ? [] : [span.lead]), { start: span.start, end: span.end }];
	if (meter !== undefined) {
		// Each piece reads its text and every cut.
		const cuts = [span.folds, span.omit, span.splices, span.verbatim, span.angles].reduce(
			(sum, list) => sum + (list?.length ?? 0),
			0,
		);
		for (const piece of pieces) meter.steps += piece.end - piece.start + cuts;
	}
	const free = freeMarks(text, pieces, 3);
	if (free === null) return undefined;
	const [literal = "", open = "", close = ""] = free;
	const marks = { literal, open, close };
	const literals: string[] = [];
	const raws: string[] = [];
	for (const piece of pieces) {
		const raw = applied(text, piece, span, marks, literals);
		if (raw === undefined) return undefined;
		raws.push(raw);
	}
	// Marks pair up, so every odd part is a literal's index.
	const parts = collapse(raws.join(" "), marks).split(literal);
	const line = parts
		.map((part, at) =>
			at % 2 === 1 ? (literals[Number(part)] ?? "") : part.replaceAll(open, "<").replaceAll(close, ">"),
		)
		.join("");
	return line === "" ? undefined : line;
}
