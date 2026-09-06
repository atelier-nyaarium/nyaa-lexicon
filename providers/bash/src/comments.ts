// The file's comments: every `#` outside the spans the walk saw a `#` as data in, to its line's end.

import type { CommentSpan } from "@nyaa-lexicon/protocol";
import { rangeAt, type Walk } from "./context.js";

////////////////////////////////
//  Functions & Helpers

/** The opaque spans sorted and merged. */
function mergedOpaque(w: Walk): number[] {
	const pairs: [number, number][] = [];
	for (let i = 0; i < w.opaque.length; i += 2) pairs.push([w.opaque[i] as number, w.opaque[i + 1] as number]);
	pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: number[] = [];
	for (const [start, end] of pairs) {
		const last = merged.length - 1;
		if (last >= 0 && start <= (merged[last] as number)) merged[last] = Math.max(merged[last] as number, end);
		else merged.push(start, end);
	}
	return merged;
}

export function commentsIn(w: Walk): CommentSpan[] {
	const text = w.text;
	const opaque = mergedOpaque(w);
	const comments: CommentSpan[] = [];
	let span = 0;
	let at = text.indexOf("#");
	while (at !== -1) {
		while (span < opaque.length && (opaque[span + 1] as number) <= at) span += 2;
		if (span < opaque.length && (opaque[span] as number) <= at) {
			at = text.indexOf("#", opaque[span + 1] as number);
			continue;
		}
		const newline = text.indexOf("\n", at);
		let end = newline === -1 ? text.length : newline;
		if (text[end - 1] === "\r") end--;
		// The shebang counts: it is lexically a comment, and the corpus expects it reported.
		comments.push({ range: rangeAt(w, at, end), text: text.slice(at, end) });
		at = text.indexOf("#", end);
	}
	return comments;
}
