// Here-document bodies: the literal, the reads inside an expanding one, and the delimiter bash never saw.

import type { Redirect } from "unbash";
import { pushLiteral, rangeAt, type Scope, staticValue, type Walk } from "./context.js";
import { walkWord } from "./words.js";

////////////////////////////////
//  Functions & Helpers

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// unbash places only an expanding here-document body; a quoted or unclosed one is found by this scan.
// Stand-in for upstream body positions; remove by 2026-09-19.
export function walkRedirect(w: Walk, scope: Scope, redirect: Redirect): void {
	walkWord(w, scope, redirect.target, false);
	if (redirect.operator !== "<<" && redirect.operator !== "<<-") return;
	const content = redirect.content;
	if (content === undefined) return;
	const body = redirect.body;
	const start = body?.pos ?? Math.max(w.text.indexOf("\n", redirect.end) + 1, w.heredocNext);
	const end = body?.end ?? start + content.length;
	if (start <= 0) return;
	// `<<-` strips leading tabs from every body line.
	const value = redirect.operator === "<<-" ? content.replace(/^\t+/gm, "") : content;
	if (body === undefined || staticValue(body) !== undefined) pushLiteral(w, scope, value, start, end);
	walkWord(w, scope, body, false);
	const delimiter = redirect.target?.value ?? "";
	const closing =
		delimiter === "" ? null : new RegExp(`^\\t*${escapeRegExp(delimiter)}(?:\\r?\\n|$)`).exec(w.text.slice(end));
	w.heredocNext = end + (closing?.[0].length ?? 0);
	if (closing === null) {
		w.out.diagnostics.push({
			severity: "warning",
			message: `here-document delimited by end-of-file (wanted \`${delimiter}')`,
			range: rangeAt(w, redirect.pos, redirect.end),
			path: w.module,
		});
	}
}
