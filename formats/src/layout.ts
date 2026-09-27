// Comment trivia and blank lines from a reader's own tokens, never from the text around them.
// docs/parsing.md rule 13.

import type { CommentSpan, OffsetRange, TextCoordinates } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface Layout {
	/** In source order, each saying whether code shares its first and last lines. */
	comments: CommentSpan[];
	/** Lines of the extent no token touches. */
	blankLines: number[];
}

interface HeldComment {
	start: number;
	end: number;
	first: number;
	last: number;
	text: string;
}

////////////////////////////////
//  Class

/**
 * One reader's tokens, in file offsets and any order.
 *
 * Tokens never overlap: preceding code starts earlier and ends on the comment's first line;
 * following code starts after the comment on its last line.
 */
export class LayoutRecorder {
	private readonly touched = new Set<number>();
	/** Per line, the earliest start of a code token ending on it. */
	private readonly codeEnding = new Map<number, number>();
	/** Per line, the latest start of a code token starting on it. */
	private readonly codeStarting = new Map<number, number>();
	private readonly held: HeldComment[] = [];

	constructor(private readonly coordinates: TextCoordinates) {}

	code(start: number, end: number): void {
		const lines = this.touch(start, end);
		if (lines === undefined) return;
		const [first, last] = lines;
		const ending = this.codeEnding.get(last);
		if (ending === undefined || start < ending) this.codeEnding.set(last, start);
		const starting = this.codeStarting.get(first);
		if (starting === undefined || start > starting) this.codeStarting.set(first, start);
	}

	/** Without text, it touches its lines and is not reported. */
	comment(start: number, end: number, text?: string): void {
		const lines = this.touch(start, end);
		if (lines === undefined || text === undefined || text === "") return;
		this.held.push({ start, end, first: lines[0], last: lines[1], text });
	}

	/** Comments and untouched lines within `extent`. */
	finish(extent: OffsetRange): Layout {
		const comments = this.held
			.sort((left, right) => left.start - right.start)
			.flatMap((comment) => {
				const range = this.coordinates.rangeAt(comment.start, comment.end);
				if (range === undefined) return [];
				const ending = this.codeEnding.get(comment.first);
				const starting = this.codeStarting.get(comment.last);
				return [
					{
						range,
						text: comment.text,
						codeBefore: ending !== undefined && ending < comment.start,
						codeAfter: starting !== undefined && starting > comment.start,
					},
				];
			});

		const from = this.coordinates.positionAt(extent.start);
		const to = this.coordinates.positionAt(extent.end);
		const blankLines: number[] = [];
		if (from === undefined || to === undefined) return { comments, blankLines };
		// The empty remainder after a final line break is not a line.
		const last = to.character === 0 ? to.line - 1 : to.line;
		for (let line = from.line; line <= last; line++) if (!this.touched.has(line)) blankLines.push(line);
		return { comments, blankLines };
	}

	private touch(start: number, end: number): [number, number] | undefined {
		if (end <= start) return undefined;
		const first = this.coordinates.positionAt(start)?.line;
		const last = this.coordinates.positionAt(end - 1)?.line;
		if (first === undefined || last === undefined) return undefined;
		for (let line = first; line <= last; line++) this.touched.add(line);
		return [first, last];
	}
}

////////////////////////////////
//  Functions & Helpers

/** A token's own text less its surrounding whitespace, or nothing when it is all whitespace. */
export function trimmedSpan(source: string, start: number): OffsetRange | undefined {
	const leading = source.length - source.trimStart().length;
	if (leading === source.length) return undefined;
	const trailing = source.length - source.trimEnd().length;
	return { start: start + leading, end: start + source.length - trailing };
}
