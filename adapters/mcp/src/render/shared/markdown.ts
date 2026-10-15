////////////////////////////////
//  Functions & Helpers

/**
 * A COMPLETE Markdown code span, delimiters included, so no caller writes its own.
 *
 * CommonMark gives a backslash no meaning inside a code span and closes the span on the first
 * backtick run matching the opening one, so the fence has to come from the content. A caller that
 * wrapped this in backticks of its own would reopen exactly that.
 */
export function code(value: string): string {
	// CommonMark has no empty code span, and a line ending inside one becomes a space.
	if (value === "") return "";
	const flat = value.replace(/\r\n|\r|\n/g, " ");
	const longest = [...flat.matchAll(/`+/g)].reduce((run, match) => Math.max(run, match[0].length), 0);
	// One space is stripped from each end only when both ends carry one and the content is not all spaces.
	const padded =
		!/^ +$/.test(flat) &&
		(flat.startsWith("`") || flat.endsWith("`") || (flat.startsWith(" ") && flat.endsWith(" ")));
	const fence = "`".repeat(longest + 1);
	const pad = padded ? " " : "";
	return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * Describe is a summary, and documentation is normalized to one line, so the cut is by sentence.
 *
 * Every cut is MARKED. A section of six bulleted rules summarized to its first sentence, with nothing
 * saying so, reads as the whole section rather than as a preview of it.
 */
function summarize(text: string, limit = 200): string {
	const full = text.trimEnd();
	const sentence = full.indexOf(". ");
	if (sentence > 0 && sentence < limit) return marked(full.slice(0, sentence + 1), full);
	if (full.length <= limit) return full;
	const boundary = full.lastIndexOf(" ", limit);
	return marked(full.slice(0, boundary > 0 ? boundary : limit).trimEnd(), full);
}

/** The ellipsis only where something was actually dropped. */
function marked(cut: string, full: string): string {
	return cut.length < full.length ? `${cut} ...` : cut;
}

/** Quoted so a comment's own markers cannot be read as this document's markup. */
function indent(raw: string): string {
	return raw
		.split("\n")
		.map((line) => `      ${line}`)
		.join("\n");
}

export { indent, summarize };
