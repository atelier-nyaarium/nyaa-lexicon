// The single owner of the map between an offset and a {line, character} position.
//
// Its own module because every provider and the core need it, and the alternative is what this
// replaced: one converter per module, each with its own idea of what is out of bounds. They
// disagreed, and the disagreement was invisible until a move wrote an edit into the wrong file.
//
// The contract is REFUSAL, never clamping. A position that does not address a character is an
// answer of undefined, because the caller can report that. Clamping turns a caller's arithmetic
// bug into a correct-looking edit at the wrong place, which is the failure this project exists to
// avoid making.

import type { Position, Range } from "./symbols.js";

////////////////////////////////
//  Interfaces & Types

export interface OffsetRange {
	start: number;
	end: number;
}

/**
 * One text's coordinate map. Built once per text, because the line index is the expensive part
 * and a caller converting several positions should not pay for it each time.
 */
export interface TextCoordinates {
	/** Undefined when the offset is outside the text. */
	positionAt(offset: number): Position | undefined;
	/** Undefined when the position does not address a character or a line end. */
	offsetAt(position: Position): number | undefined;
	/** Undefined when either end is unaddressable, or the range runs backwards. */
	offsetsForRange(range: Range): OffsetRange | undefined;
	rangeAt(start: number, end: number): Range | undefined;
	sliceRange(range: Range): string | undefined;
	/** One line's content, terminator excluded. Undefined when the line does not exist. */
	lineText(line: number): string | undefined;
	/** Lines in the text; the count of addressable line numbers. */
	lineCount(): number;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Characters are UTF-16 code units, matching the conformance suite's stated position contract.
 *
 * A line terminator is not addressable content: the last position on a line is the one before its
 * `\n`, and before the `\r` of a `\r\n` pair. Allowing a position between `\r` and `\n` let an
 * edit split a line ending, which no caller ever means.
 */
export function coordinatesOf(text: string): TextCoordinates {
	const starts = lineStartsOf(text);

	// Where the line's content ends, excluding whatever terminates it.
	function contentEnd(line: number): number {
		const next = starts[line + 1];
		if (next === undefined) return text.length;
		const beforeNewline = next - 1;
		return beforeNewline > (starts[line] as number) && text[beforeNewline - 1] === "\r"
			? beforeNewline - 1
			: beforeNewline;
	}

	function offsetAt(position: Position): number | undefined {
		const start = starts[position.line];
		if (start === undefined) return undefined;
		if (!Number.isInteger(position.character) || position.character < 0) return undefined;
		const offset = start + position.character;
		return offset > contentEnd(position.line) ? undefined : offset;
	}

	/**
	 * Binary search over the ascending line index: the greatest start at or below the offset.
	 *
	 * Logarithmic because a PARSE converts one position per declaration across a whole file, so any
	 * scan is quadratic in the document.
	 */
	function positionAt(offset: number): Position | undefined {
		if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return undefined;
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const middle = Math.floor((low + high + 1) / 2);
			if ((starts[middle] as number) <= offset) low = middle;
			else high = middle - 1;
		}
		return { line: low, character: offset - (starts[low] as number) };
	}

	function offsetsForRange(range: Range): OffsetRange | undefined {
		const start = offsetAt(range.start);
		const end = offsetAt(range.end);
		if (start === undefined || end === undefined || end < start) return undefined;
		return { start, end };
	}

	return {
		positionAt,
		offsetAt,
		offsetsForRange,
		rangeAt(start, end) {
			const from = positionAt(start);
			const to = positionAt(end);
			return from === undefined || to === undefined || end < start ? undefined : { start: from, end: to };
		},
		sliceRange(range) {
			const offsets = offsetsForRange(range);
			return offsets === undefined ? undefined : text.slice(offsets.start, offsets.end);
		},
		lineText(line) {
			const start = starts[line];
			return start === undefined ? undefined : text.slice(start, contentEnd(line));
		},
		lineCount: () => starts.length,
	};
}

function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	return starts;
}

/** Total order over positions: negative when a precedes b. The ONE spelling of this comparison;
 * private copies drifted before, which is this module's founding bug class. */
export function comparePositions(a: Position, b: Position): number {
	return a.line !== b.line ? a.line - b.line : a.character - b.character;
}

export function sameRange(a: Range, b: Range): boolean {
	return comparePositions(a.start, b.start) === 0 && comparePositions(a.end, b.end) === 0;
}
