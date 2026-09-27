// A declaration's pattern digest: kind, name, and text without comments, whitespace collapsed outside
// string literals. Evidence that a vanished declaration reappeared elsewhere, never a key.

import {
	type CommentSpan,
	coordinatesOf,
	type Declaration,
	hashContent,
	type Literal,
	type OffsetRange,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** What a digest covers: the provider reported comment spans, or it reported none. */
export type PatternCoverage = "commentsStripped" | "commentsKept";

export interface PatternDigest {
	symbolId: string;
	patternDigest: string;
	patternCoverage: PatternCoverage;
}

/** A comment is cut; a string literal is kept as spelled. */
interface Piece extends OffsetRange {
	keep: boolean;
}

////////////////////////////////
//  Functions & Helpers

/** The first piece, in start order, at or after which some piece reaches `offset`. Searched over the
 * running maximum of piece ends, which is monotonic where the ends themselves need not be. */
function firstPieceReaching(reach: number[], offset: number): number {
	let low = 0;
	let high = reach.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((reach[mid] as number) <= offset) low = mid + 1;
		else high = mid;
	}
	return low;
}

function isWhitespace(character: string): boolean {
	return character.trim() === "";
}

/** Whitespace runs between tokens become one space. */
function collapsed(text: string): string {
	let out = "";
	let spaced = false;
	for (const character of text) {
		if (isWhitespace(character)) {
			spaced = true;
			continue;
		}
		if (spaced && out !== "") out += " ";
		spaced = false;
		out += character;
	}
	return spaced && out !== "" ? `${out} ` : out;
}

/** Every declaration with a range, from a full parse only: a shallow parse reports no comments
 * even from a provider that has them, and the same text must not digest two ways. */
export function patternDigests(
	declarations: Declaration[],
	comments: CommentSpan[] | undefined,
	literals: readonly Literal[],
	text: string,
): PatternDigest[] {
	const coordinates = coordinatesOf(text);
	const coverage: PatternCoverage = comments === undefined ? "commentsKept" : "commentsStripped";
	const pieces: Piece[] = [];
	for (const comment of comments ?? []) {
		const span = coordinates.offsetsForRange(comment.range);
		if (span !== undefined) pieces.push({ ...span, keep: false });
	}
	for (const literal of literals) {
		if (literal.kind !== "string") continue;
		const span = coordinates.offsetsForRange(literal.range);
		if (span !== undefined) pieces.push({ ...span, keep: true });
	}
	pieces.sort((a, b) => a.start - b.start);
	const reach: number[] = [];
	for (const piece of pieces) reach.push(Math.max(piece.end, reach[reach.length - 1] ?? 0));

	const digests: PatternDigest[] = [];
	for (const declaration of declarations) {
		const range = coordinates.offsetsForRange(declaration.range);
		if (range === undefined) continue;
		let body = "";
		// Code since the last kept literal, collapsed as one run so a cut comment joins its neighbours.
		let code = "";
		let cursor = range.start;
		for (let i = firstPieceReaching(reach, range.start); i < pieces.length; i++) {
			const piece = pieces[i] as Piece;
			if (piece.start >= range.end) break;
			if (piece.end <= cursor) continue;
			code += text.slice(cursor, Math.max(cursor, piece.start));
			if (piece.keep && piece.end <= range.end) {
				body += collapsed(code) + text.slice(Math.max(cursor, piece.start), piece.end);
				code = "";
			}
			cursor = Math.max(cursor, piece.end);
		}
		body += collapsed(code + text.slice(cursor, Math.max(cursor, range.end)));
		digests.push({
			symbolId: declaration.symbolId,
			patternDigest: hashContent(`${declaration.kind}\n${declaration.name}\n${body.trim()}`),
			patternCoverage: coverage,
		});
	}
	return digests;
}
