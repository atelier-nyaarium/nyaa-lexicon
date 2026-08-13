// Writing a set of edits to disk without leaving a half-rename.
//
// The splice itself lives in the protocol package beside TextEdit, so the conformance suite checks
// provider edits with the same code that applies them here.

import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyEdits, type TextEdit } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface FileEdits {
	module: string;
	edits: TextEdit[];
}

export type ApplyOutcome = { applied: true; modules: string[] } | { applied: false; reason: string; module?: string };

////////////////////////////////
//  Functions & Helpers

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
