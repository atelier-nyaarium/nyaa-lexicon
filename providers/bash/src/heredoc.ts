// Here-document bodies: the literal, and the reads inside an expanding one.

import { pushLiteral, rangeAt, type Scope, staticValue, type Walk } from "./context.js";
import type { Redirect } from "./syntax/ast.js";
import { walkWord } from "./words.js";

////////////////////////////////
//  Functions & Helpers

export function walkRedirect(w: Walk, scope: Scope, redirect: Redirect): void {
	if (redirect.operator !== "<<" && redirect.operator !== "<<-") {
		walkWord(w, scope, redirect.target, false);
		return;
	}
	// The delimiter is quote-removed but never expanded: a name bash matches, not program text.
	const body = redirect.body;
	if (body === undefined) return;
	// A static body is one literal; walking its parts would report it again.
	const value = staticValue(body);
	if (value !== undefined) pushLiteral(w, scope, value, body.pos, body.end);
	else walkWord(w, scope, body, false);
	if (redirect.closing === undefined) {
		w.out.diagnostics.push({
			severity: "warning",
			message: `here-document delimited by end-of-file (wanted \`${redirect.target?.value ?? ""}')`,
			range: rangeAt(w, redirect.pos, redirect.end),
			path: w.module,
		});
	}
}
