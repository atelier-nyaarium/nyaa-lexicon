// Turning text edits into new file contents, and writing them without leaving a half-rename.
//
// Pure application is separated from the writing so the interesting part, applying several edits
// to one string without them shifting each other, is testable without a filesystem.

import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TextEdit } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface FileEdits {
	module: string;
	edits: TextEdit[];
}

export type ApplyOutcome = { applied: true; modules: string[] } | { applied: false; reason: string; module?: string };

////////////////////////////////
//  Functions & Helpers

/** Line and character to an index, so edits can be sorted and spliced in one coordinate system. */
function offsetOf(lineStarts: number[], position: { line: number; character: number }): number | null {
	const start = lineStarts[position.line];
	if (start === undefined) return null;
	return start + position.character;
}

function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	return starts;
}

/**
 * Apply every edit to one file's text.
 *
 * Applied back to front, so an earlier edit never moves the coordinates of a later one. Sorting
 * here rather than trusting the provider means a provider that returns edits in reading order and
 * one that returns them in any other order both produce the same file.
 *
 * Overlapping edits are refused rather than resolved. Two edits claiming the same characters is a
 * provider bug, and picking a winner would turn it into a silently wrong file.
 */
export function applyEdits(text: string, edits: TextEdit[]): { text: string } | { problem: string } {
	const lineStarts = lineStartsOf(text);
	const spans: Array<{ start: number; end: number; newText: string }> = [];

	for (const edit of edits) {
		const start = offsetOf(lineStarts, edit.range.start);
		const end = offsetOf(lineStarts, edit.range.end);
		if (start === null || end === null)
			return { problem: `an edit is outside the file at line ${edit.range.start.line}` };
		if (end < start) return { problem: `an edit ends before it starts at line ${edit.range.start.line}` };
		spans.push({ start, end, newText: edit.newText });
	}

	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		const previous = spans[i - 1] as { end: number };
		const current = spans[i] as { start: number };
		if (current.start < previous.end) return { problem: "two edits overlap, so the result would depend on order" };
	}

	let out = text;
	for (const span of [...spans].reverse()) out = out.slice(0, span.start) + span.newText + out.slice(span.end);
	return { text: out };
}

/**
 * Write every file, or none of them.
 *
 * Both halves are checked before anything is written, because a rename that succeeds in three
 * files and fails in the fourth leaves a codebase that does not compile and no record of how far
 * it got. Each write is then a temp file plus a rename, so a crash mid-write cannot truncate a
 * source file.
 *
 * This is not atomic ACROSS files: a crash between two renames leaves some applied. Making that
 * impossible needs a journal, and the pre-check removes every failure this code can actually see.
 */
export function writeAll(
	workspaceRoot: string,
	files: FileEdits[],
	readFile: (module: string) => string | null,
): ApplyOutcome {
	const staged: Array<{ module: string; text: string }> = [];

	for (const file of files) {
		const before = readFile(file.module);
		if (before === null) return { applied: false, reason: "file could not be read", module: file.module };

		const result = applyEdits(before, file.edits);
		if ("problem" in result) return { applied: false, reason: result.problem, module: file.module };
		staged.push({ module: file.module, text: result.text });
	}

	for (const file of staged) {
		const full = path.join(workspaceRoot, file.module);
		const temporary = `${full}.lexicon-tmp`;
		try {
			writeFileSync(temporary, file.text);
			renameSync(temporary, full);
		} catch (error) {
			return {
				applied: false,
				reason: error instanceof Error ? error.message : String(error),
				module: file.module,
			};
		}
	}
	return { applied: true, modules: staged.map((file) => file.module) };
}
