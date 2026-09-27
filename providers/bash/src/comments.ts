// Tokens from walked spans and gaps: code runs and `#` comments.

import { type CommentSpan, Cursor, type OffsetRange, unionOf } from "@nyaa-lexicon/protocol";
import { contentOffset, rangeAt, type Walk } from "./context.js";

////////////////////////////////
//  Interfaces & Types

export interface Token extends OffsetRange {
	/** A continuation is a backslash and the line break it splices. */
	kind: "code" | "comment" | "continuation";
}

////////////////////////////////
//  Constants

const BLANK_RE = /^\s$/;

////////////////////////////////
//  Functions & Helpers

/** Start and end pairs sorted and merged. */
export function spansOf(pairs: readonly number[]): OffsetRange[] {
	const ranges: OffsetRange[] = [];
	for (let i = 0; i < pairs.length; i += 2) {
		ranges.push({ start: pairs[i] as number, end: pairs[i + 1] as number });
	}
	return unionOf(ranges);
}

function lineEnds(cursor: Cursor): boolean {
	return cursor.peek() === "\n" || (cursor.peek() === "\r" && cursor.peek(1) === "\n");
}

function continues(cursor: Cursor): boolean {
	return cursor.peek() === "\\" && cursor.peek(1) === "\n";
}

/**
 * Every opaque span becomes code runs split at continuations; each gap is lexed into tokens.
 * Offsets refer to walked text in file order. Blanks are omitted, and backslashes escape outside raw spans.
 */
export function tokensOf(w: Walk, opaque: readonly OffsetRange[], raw: readonly OffsetRange[]): Token[] {
	const cursor = new Cursor(w.text);
	const tokens: Token[] = [];
	const push = (start: number, end: number, kind: Token["kind"]): void => {
		if (end > start) tokens.push({ start, end, kind });
	};
	const splice = (): void => {
		const at = cursor.offset;
		cursor.next();
		cursor.next();
		push(at, cursor.offset, "continuation");
	};
	let span = 0;
	let kept = 0;
	while (cursor.good()) {
		const at = cursor.offset;
		while (span < opaque.length && (opaque[span] as OffsetRange).end <= at) span++;
		const next = opaque[span];
		if (next !== undefined && next.start <= at) {
			let piece = at;
			while (cursor.good() && cursor.offset < next.end) {
				while (kept < raw.length && (raw[kept] as OffsetRange).end <= cursor.offset) kept++;
				const literal = raw[kept];
				if (literal !== undefined && literal.start <= cursor.offset) {
					const stop = Math.min(literal.end, next.end);
					while (cursor.good() && cursor.offset < stop) cursor.next();
				} else if (continues(cursor) && cursor.offset + 2 <= next.end) {
					push(piece, cursor.offset, "code");
					splice();
					piece = cursor.offset;
				} else if (cursor.next() === "\\" && cursor.offset < next.end) {
					cursor.next();
				}
			}
			push(piece, contentOffset(w, cursor.offset), "code");
		} else if (cursor.peek() === "#") {
			// The shebang counts: it is lexically a comment, and the corpus expects it reported.
			while (cursor.good() && !lineEnds(cursor)) cursor.next();
			push(at, cursor.offset, "comment");
		} else if (BLANK_RE.test(cursor.peek())) {
			cursor.next();
		} else if (continues(cursor)) {
			splice();
		} else {
			const stop = next?.start ?? w.text.length;
			while (
				cursor.good() &&
				cursor.offset < stop &&
				cursor.peek() !== "#" &&
				!BLANK_RE.test(cursor.peek()) &&
				!continues(cursor)
			) {
				if (cursor.next() === "\\" && cursor.offset < stop) cursor.next();
			}
			push(at, cursor.offset, "code");
		}
		if (cursor.offset === at) throw new Error(`bash token scan stalled at offset ${at}`);
	}
	return tokens;
}

export function rangesOf(tokens: readonly Token[], kind: Token["kind"]): OffsetRange[] {
	return tokens.flatMap((token) => (token.kind === kind ? [{ start: token.start, end: token.end }] : []));
}

function firstLine(w: Walk, token: Token): number {
	return w.coordinates.positionAt(token.start + w.shift)?.line ?? 0;
}

/** A token ending with its line break ends on that line. */
function lastLine(w: Walk, token: Token): number {
	return w.coordinates.positionAt(Math.max(token.start, token.end - 1) + w.shift)?.line ?? 0;
}

/** Each comment with whether the nearest code token on either side shares its line. */
export function commentSpans(w: Walk, tokens: readonly Token[]): CommentSpan[] {
	const spans: CommentSpan[] = [];
	let before: Token | undefined;
	let undecided = 0;
	for (const token of tokens) {
		if (token.kind !== "comment") {
			const line = firstLine(w, token);
			for (; undecided < spans.length; undecided++) {
				const span = spans[undecided] as CommentSpan;
				span.codeAfter = span.range.end.line === line;
			}
			before = token;
			continue;
		}
		spans.push({
			range: rangeAt(w, token.start, token.end),
			text: w.text.slice(token.start, token.end),
			codeBefore: before !== undefined && lastLine(w, before) === firstLine(w, token),
			codeAfter: false,
		});
	}
	return spans;
}

/** Lines no token touches. The empty remainder after a final line break is no line. */
export function blankLinesOf(w: Walk, tokens: readonly Token[]): number[] {
	const end = w.coordinates.positionAt(w.shift + w.text.length);
	const count = end === undefined ? 0 : end.character === 0 ? end.line : end.line + 1;
	const blank: number[] = [];
	let line = 0;
	for (const token of tokens) {
		for (const first = firstLine(w, token); line < first && line < count; line++) blank.push(line);
		line = Math.max(line, lastLine(w, token) + 1);
	}
	for (; line < count; line++) blank.push(line);
	return blank;
}
