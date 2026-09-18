// Here-document bodies: the literal, the reads inside an expanding one, and the delimiter bash never saw.

import type { Redirect } from "unbash";
import { pushLiteral, pushOpaque, rangeAt, type Scope, staticValue, type Walk } from "./context.js";
import { walkWord } from "./words.js";

////////////////////////////////
//  Functions & Helpers

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// unbash places only an expanding here-document body; a quoted or unclosed one is found by this scan.
// Stand-in for upstream body positions; remove by 2026-09-19.
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
	// `<<-` strips leading tabs from every body line.
	const value = redirect.operator === "<<-" ? content.replace(/^\t+/gm, "") : content;
	const staticBody = body === undefined || staticValue(body) !== undefined;
	if (staticBody) pushLiteral(w, scope, value, start, end);
	pushOpaque(w, start, end);
	// A static body holds no expansion to read and no part worth walking again; walking it anyway
	// would report its literal text runs a second time, once here and once per part.
	if (!staticBody) walkWord(w, scope, body, false);
	const delimiter = redirect.target?.value ?? "";
	const closing =
		delimiter === "" ? null : new RegExp(`^\\t*${escapeRegExp(delimiter)}(?:\\r?\\n|$)`).exec(w.text.slice(end));
	w.heredocNext = end + (closing?.[0].length ?? 0);
	// The delimiter line is the body's end, whatever it spells.
	pushOpaque(w, end, w.heredocNext);
	if (closing === null) {
		w.out.diagnostics.push({
			severity: "warning",
			message: `here-document delimited by end-of-file (wanted \`${delimiter}')`,
			range: rangeAt(w, redirect.pos, redirect.end),
			path: w.module,
		});
	}
}
