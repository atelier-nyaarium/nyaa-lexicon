// Here-document bodies: the literal, the reads inside an expanding one, and the delimiter bash never saw.

import { Cursor } from "@nyaa-lexicon/protocol";
import type { Redirect } from "unbash";
import { pushLiteral, pushOpaque, rangeAt, type Scope, staticValue, type Walk } from "./context.js";
import { walkWord } from "./words.js";

////////////////////////////////
//  Interfaces & Types

/** The delimiter line at the body's end. */
interface Closing {
	length: number;
	/** A line end or the end of input follows the delimiter; bash warns otherwise. */
	closed: boolean;
}

////////////////////////////////
//  Functions & Helpers

/** `<<-` strips leading tabs from every body line. */
function stripped(content: string): string {
	const cursor = new Cursor(content);
	let value = "";
	let lineStart = true;
	while (cursor.good()) {
		const character = cursor.next();
		if (lineStart && character === "\t") continue;
		value += character;
		lineStart = character === "\n";
	}
	return value;
}

/** An empty delimiter closes only at an empty line. */
function closingOf(after: string, delimiter: string, strip: boolean): Closing {
	const cursor = new Cursor(after);
	if (strip) cursor.takeWhile((character) => character === "\t");
	const expected = new Cursor(delimiter);
	while (expected.good()) if (cursor.next() !== expected.next()) return { length: 0, closed: false };
	if (cursor.peek() === "\n") return { length: cursor.offset + 1, closed: true };
	return { length: cursor.offset, closed: delimiter !== "" && !cursor.good() };
}

// unbash 4.0.11 gives no position for a quoted or static body or its delimiter line; both are read from the text.
export function walkRedirect(w: Walk, scope: Scope, redirect: Redirect): void {
	if (redirect.operator !== "<<" && redirect.operator !== "<<-") {
		walkWord(w, scope, redirect.target, false);
		return;
	}
	// The delimiter is quote-removed but never expanded: a name bash matches, not program text.
	const target = redirect.target;
	if (target !== undefined) pushOpaque(w, target.pos, target.end);
	const content = redirect.content;
	if (content === undefined) return;
	const body = redirect.body;
	const start = body?.pos ?? Math.max(w.text.indexOf("\n", redirect.end) + 1, w.heredocNext);
	const end = body?.end ?? start + content.length;
	if (start <= 0) return;
	const strip = redirect.operator === "<<-";
	const value = strip ? stripped(content) : content;
	const staticBody = body === undefined || staticValue(body) !== undefined;
	if (staticBody) pushLiteral(w, scope, value, start, end);
	pushOpaque(w, start, end);
	if (redirect.heredocQuoted === true) w.raw.push(start, end);
	// A static body holds no expansion to read and no part worth walking again; walking it anyway
	// would report its literal text runs a second time, once here and once per part.
	if (!staticBody) walkWord(w, scope, body, false);
	const delimiter = redirect.target?.value ?? "";
	const closing = closingOf(w.text.slice(end), delimiter, strip);
	w.heredocNext = end + closing.length;
	// The delimiter line is the body's end, whatever it spells.
	pushOpaque(w, end, w.heredocNext);
	if (!closing.closed) {
		w.out.diagnostics.push({
			severity: "warning",
			message: `here-document delimited by end-of-file (wanted \`${delimiter}')`,
			range: rangeAt(w, redirect.pos, redirect.end),
			path: w.module,
		});
	}
}
