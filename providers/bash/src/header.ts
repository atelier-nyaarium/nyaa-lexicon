// A declaration's header spans, handed to the protocol's one renderer.

import {
	type HeaderFold,
	type HeaderSpan,
	headerTriviaGroups,
	normalizeTriviaRanges,
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

/** Every declaration's signature: comments and line continuations out, quoted parts as written. */
export function signHeaders(w: Walk, tokens: readonly Token[], meter?: WorkMeter): void {
	const comments = rangesOf(tokens, "comment");
	const continuations = rangesOf(tokens, "continuation");
	const quoted = normalizeTriviaRanges(
		Array.from({ length: w.quoted.length / 2 }, (_, index) => ({
			start: w.quoted[index * 2] as number,
			end: w.quoted[index * 2 + 1] as number,
		})),
	);
	for (const { declaration, span } of w.headers) {
		const omit: OffsetRange[] = [...(span.omit ?? [])];
		// Bash continuations join words.
		const splices = headerTriviaGroups(continuations, span).flat();
		const verbatim = headerTriviaGroups(quoted, span).flat();
		omit.push(...headerTriviaGroups(comments, span).flat());
		const signature = renderHeader(w.text, { ...span, omit, splices, verbatim }, meter);
		if (signature !== undefined) declaration.signature = signature;
	}
}
