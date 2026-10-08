// A declaration's header spans, handed to the protocol's one renderer.

import {
	type HeaderFold,
	type HeaderSpan,
	type OffsetRange,
	renderHeader,
	SourceCursor,
	type WorkMeter,
} from "@nyaa-lexicon/protocol";
import { rangesOf } from "./comments.js";
import { assignmentOf, type Walk } from "./context.js";
import type { Token, Word } from "./syntax/ast.js";

////////////////////////////////
//  Interfaces & Types

/** The header of the word a command declares. */
export type HeaderOf = (word: Word) => HeaderSpan;

////////////////////////////////
//  Functions & Helpers

/** A command's words through `word`, for a command declaring one name. */
export function commandHeader(command: Word, word: Word): HeaderSpan {
	return { start: command.pos, end: word.end };
}

/** A command's word and the options before its first operand. */
export function leadOf(command: Word, words: readonly Word[], operands: readonly Word[]): OffsetRange {
	return { start: command.pos, end: (words[words.length - operands.length - 1] ?? command).end };
}

/** One of the names a command declares: its lead, then the name's own word. */
export function operandHeader(lead: OffsetRange, word: Word): HeaderSpan {
	return { lead, start: word.pos, end: word.end };
}

/** An array or compound assignment folds its parentheses. */
export function assignmentFolds(text: string, pos: number): HeaderFold[] {
	const head = assignmentOf(text);
	if (head === undefined || !head.array) return [];
	const cursor = new SourceCursor(head.value);
	let before = "";
	let last = "";
	while (cursor.good()) {
		before = last;
		last = cursor.next();
	}
	// A CRLF line leaves `\r` on the word.
	const carriage = last === "\r";
	if ((carriage ? before : last) !== ")") return [];
	return [{ start: pos + head.valueAt, end: pos + text.length - (carriage ? 1 : 0) }];
}

/** The ranges starting inside the piece, from ranges sorted by start. */
function startingWithin(ranges: readonly OffsetRange[], piece: OffsetRange): OffsetRange[] {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((ranges[middle] as OffsetRange).start < piece.start) low = middle + 1;
		else high = middle;
	}
	const found: OffsetRange[] = [];
	for (let at = low; at < ranges.length; at++) {
		const range = ranges[at] as OffsetRange;
		if (range.start >= piece.end) break;
		found.push(range);
	}
	return found;
}

/** Quoted parts sorted, each outside every other. */
function outermost(pairs: readonly number[]): OffsetRange[] {
	const ranges: OffsetRange[] = [];
	for (let at = 0; at < pairs.length; at += 2) {
		ranges.push({ start: pairs[at] as number, end: pairs[at + 1] as number });
	}
	ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: OffsetRange[] = [];
	for (const range of ranges) if (range.start >= (kept.at(-1)?.end ?? 0)) kept.push(range);
	return kept;
}

/** Every declaration's signature: comments and line continuations out, quoted parts as written. */
export function signHeaders(w: Walk, tokens: readonly Token[], meter?: WorkMeter): void {
	const comments = rangesOf(tokens, "comment");
	const continuations = rangesOf(tokens, "continuation");
	const quoted = outermost(w.quoted);
	for (const { declaration, span } of w.headers) {
		const omit: OffsetRange[] = [...(span.omit ?? [])];
		const splices: OffsetRange[] = [];
		const verbatim: OffsetRange[] = [];
		for (const piece of span.lead === undefined ? [span] : [span.lead, span]) {
			omit.push(...startingWithin(comments, piece));
			// Bash removes a backslash-newline outright, so a continued word stays one word.
			splices.push(...startingWithin(continuations, piece));
			verbatim.push(...startingWithin(quoted, piece));
		}
		const signature = renderHeader(w.text, { ...span, omit, splices, verbatim }, meter);
		if (signature !== undefined) declaration.signature = signature;
	}
}
