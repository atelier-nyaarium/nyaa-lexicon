// Blank lines around the lines a move takes out.

import { type OffsetRange, type TextCoordinates, type TextEdit, unionOf } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Blank Lines

/**
 * Takes the blank lines after a run of removed whole lines along when the run opens the file or
 * follows a blank line, so no removal leaves a blank first line or a doubled one. A run another edit
 * touches keeps them.
 */
export function settleBlankLines(text: string, coordinates: TextCoordinates, edits: readonly TextEdit[]): TextEdit[] {
	const spans = edits.flatMap((edit) => {
		const offsets = coordinates.offsetsForRange(edit.range);
		return offsets === undefined ? [] : [{ edit, ...offsets }];
	});
	const removes = ({ edit, start, end }: { edit: TextEdit; start: number; end: number }) =>
		edit.newText === "" &&
		start < end &&
		(edit.range.start.character === 0 || opensFile(text, start)) &&
		(edit.range.end.character === 0 || end === text.length);
	const removals: OffsetRange[] = spans.filter(removes).map(({ start, end }) => ({ start, end }));
	const others = spans.filter((span) => !removes(span));

	const added: TextEdit[] = [];
	for (let grown = true; grown; ) {
		grown = false;
		for (const run of unionOf(removals)) {
			const first = coordinates.positionAt(run.start)?.line;
			const blanks = blankLinesAfter(coordinates, run.end);
			if (first === undefined || blanks === undefined) continue;
			if (!opensFile(text, run.start) && coordinates.lineText(first - 1)?.trim() !== "") continue;
			if (others.some((span) => span.start <= blanks && span.end >= run.start)) continue;
			const range = coordinates.rangeAt(run.end, blanks);
			if (range === undefined) continue;
			removals.push({ start: run.end, end: blanks });
			added.push({ range, newText: "" });
			grown = true;
		}
	}
	return [...edits, ...added];
}

/** Nothing but a byte order mark comes before `offset`. */
function opensFile(text: string, offset: number): boolean {
	return offset === 0 || (offset === 1 && text.charCodeAt(0) === 0xfeff);
}

/** Past the whole blank lines from the line start at `offset`; undefined when none. */
function blankLinesAfter(coordinates: TextCoordinates, offset: number): number | undefined {
	const at = coordinates.positionAt(offset);
	if (at === undefined || at.character !== 0) return undefined;
	let line = at.line;
	// The last line has no break to take.
	while (line < coordinates.lineCount() - 1 && coordinates.lineText(line)?.trim() === "") line++;
	return line === at.line ? undefined : coordinates.offsetAt({ line, character: 0 });
}
