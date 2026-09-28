// A knowledge note's opening, read by the markdown parser: the summary paragraph a card, a hover or
// a short read shows, and where the rest of the note starts.

import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

////////////////////////////////
//  Interfaces & Types

export type OpeningBlock = "heading" | "list" | "quote" | "code" | "rule" | "html" | "definition" | "block";

/** The first block; a paragraph as one line, and the offset its rest starts at. */
export type NoteOpening = { kind: "paragraph"; summary: string; restAt: number } | { kind: "empty" | OpeningBlock };

////////////////////////////////
//  Constants

const BLOCKS: Partial<Record<RootContent["type"], OpeningBlock>> = {
	heading: "heading",
	list: "list",
	blockquote: "quote",
	code: "code",
	thematicBreak: "rule",
	html: "html",
	definition: "definition",
};

/**
 * Block structure only. Inline constructs never move a block boundary, and emphasis resolution is
 * quadratic on crafted input.
 */
const BLOCKS_ONLY = {
	disable: {
		null: [
			"attention",
			"autolink",
			"characterReference",
			"codeText",
			"hardBreakEscape",
			"htmlText",
			"labelEnd",
			"labelStartImage",
			"labelStartLink",
		],
	},
};

const BOM = String.fromCharCode(0xfeff);

////////////////////////////////
//  Functions & Helpers

export function noteOpening(text: string): NoteOpening {
	// The parser drops a leading BOM, so its offsets start after it.
	const shift = text.startsWith(BOM) ? 1 : 0;
	const first = fromMarkdown(text.slice(shift), { extensions: [BLOCKS_ONLY] }).children[0];
	if (first === undefined) return { kind: "empty" };
	const start = first.position?.start.offset;
	const end = first.position?.end.offset;
	if (first.type !== "paragraph" || start === undefined || end === undefined) {
		return { kind: BLOCKS[first.type] ?? "block" };
	}
	const summary = text
		.slice(start + shift, end + shift)
		.split(/\r\n?|\n/)
		.map((line) => line.trim())
		.join(" ");
	return { kind: "paragraph", summary, restAt: end + shift };
}
