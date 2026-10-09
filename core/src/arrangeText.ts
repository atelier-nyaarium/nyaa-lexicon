import { comparePositions, type TextEdit } from "@nyaa-lexicon/protocol";

export function mergeRemovals(edits: readonly TextEdit[]): TextEdit[] {
	const ordered = [...edits].sort((left, right) => comparePositions(left.range.start, right.range.start));
	const result: TextEdit[] = [];
	for (const edit of ordered) {
		const last = result.at(-1);
		if (
			last !== undefined &&
			last.newText === "" &&
			edit.newText === "" &&
			comparePositions(edit.range.start, last.range.end) <= 0
		) {
			last.range = {
				start: comparePositions(last.range.start, edit.range.start) < 0 ? last.range.start : edit.range.start,
				end: comparePositions(last.range.end, edit.range.end) > 0 ? last.range.end : edit.range.end,
			};
		} else result.push({ ...edit });
	}
	return result;
}
