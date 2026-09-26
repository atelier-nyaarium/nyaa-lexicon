// A declaration's header spans, handed to the protocol's one renderer.

import { type HeaderFold, type HeaderSpan, type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import type { Word } from "unbash";
import { ASSIGNMENT_RE, type Walk } from "./context.js";

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
	const at = ASSIGNMENT_RE.exec(text)?.[0].length;
	// A CRLF line leaves `\r` on the word.
	const close = text.endsWith("\r") ? text.length - 1 : text.length;
	if (at === undefined || text[at] !== "(" || text[close - 1] !== ")") return [];
	return [{ start: pos + at, end: pos + close }];
}

/** Each line break escaped by an odd run of backslashes. */
function continuations(text: string, piece: OffsetRange): OffsetRange[] {
	const found: OffsetRange[] = [];
	for (let at = piece.start; at < piece.end; at++) {
		if (text[at] !== "\n") continue;
		const last = text[at - 1] === "\r" ? at - 2 : at - 1;
		let run = 0;
		while (last - run >= piece.start && text[last - run] === "\\") run++;
		if (run % 2 === 1) found.push({ start: last, end: at + 1 });
	}
	return found;
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
export function signHeaders(w: Walk, comments: readonly OffsetRange[]): void {
	const quoted = outermost(w.quoted);
	for (const { declaration, span } of w.headers) {
		const omit: OffsetRange[] = [...(span.omit ?? [])];
		const verbatim: OffsetRange[] = [];
		for (const piece of span.lead === undefined ? [span] : [span.lead, span]) {
			omit.push(...startingWithin(comments, piece), ...continuations(w.text, piece));
			verbatim.push(...startingWithin(quoted, piece));
		}
		const signature = renderHeader(w.text, { ...span, omit, verbatim });
		if (signature !== undefined) declaration.signature = signature;
	}
}
