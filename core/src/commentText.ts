// The one owner of comment prose.
//
// Search matches normalized text, so every comment fact carries both: the raw span as written, and
// this. Two spellings of one comment would be two answers to the same question, which is why
// nothing else in core is allowed to strip a marker.
//
// Marker SHAPES are recognized, never languages. A comment already known to be a comment can have
// its leading punctuation removed without asking which grammar produced it, and that is what keeps
// this file free of the language branch core forbids.

////////////////////////////////
//  Constants

/**
 * Minimal openers paired with their closers.
 *
 * Minimal on purpose. Matching `/**` first would consume the closing slash of `/**\/`, leaving a
 * stray character and no closer, which is the same misread that made a provider treat an empty
 * block comment as a doc opener and swallow the rest of its file.
 */
const BLOCK_DELIMITERS = [
	{ open: "/*", close: "*/" },
	{ open: "<!--", close: "-->" },
] as const;

/** Decoration a doc opener adds after the real marker. */
const OPENER_DECORATION = /^[*!]+/;

/** Line markers, longest first. */
const LINE_MARKERS = ["///", "//!", "//", "##", "#!", "#"] as const;

/** A line of pure rule, which is decoration rather than prose. */
const DECORATION = /^[-=*_/#~+]{3,}$/;

////////////////////////////////
//  Functions & Helpers

function stripLineMarker(line: string): { text: string; stripped: boolean } {
	const trimmed = line.trimStart();
	for (const marker of LINE_MARKERS) {
		if (trimmed.startsWith(marker)) return { text: trimmed.slice(marker.length), stripped: true };
	}
	return { text: trimmed, stripped: false };
}

/** A block comment's continuation gutter, which is decoration the writer never typed as prose. */
function stripGutter(line: string): string {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("*") && !trimmed.startsWith("*/")) return trimmed.slice(1);
	return trimmed;
}

/** Opener off the front, closer off the back, THEN decoration. That order is the whole trick. */
function stripBlock(text: string): { text: string; stripped: boolean } {
	for (const { open, close } of BLOCK_DELIMITERS) {
		if (!text.startsWith(open)) continue;
		let body = text.slice(open.length);
		if (body.endsWith(close)) body = body.slice(0, -close.length);
		return { text: body.replace(OPENER_DECORATION, ""), stripped: true };
	}
	return { text, stripped: false };
}

function collapse(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

////////////////////////////////
//  Normalizing

/**
 * The searchable form of a comment: markers, gutters and decoration gone, whitespace collapsed.
 *
 * Collapsing newlines is the point rather than a side effect. A sentence wrapped across two line
 * comments is one sentence to a reader, so it has to be one string to a search.
 *
 * Text whose shape is not recognized keeps every character, because guessing at an unknown marker
 * risks eating prose, and prose that survives unstripped still matches a search for its own words.
 */
export function normalizeCommentText(raw: string): string {
	const block = stripBlock(raw);
	if (block.stripped) {
		const lines = block.text.split("\n").map(stripGutter);
		return collapse(lines.filter((line) => !DECORATION.test(line.trim())).join(" "));
	}

	const lines = raw.split("\n");
	const stripped = lines.map(stripLineMarker);
	// Unrecognized on every line means this is not a shape we know. Keep it whole.
	if (!stripped.some((line) => line.stripped)) return collapse(raw);

	return collapse(
		stripped
			.map((line) => line.text)
			.filter((text) => !DECORATION.test(text.trim()))
			.join(" "),
	);
}
