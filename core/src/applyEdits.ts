// Writing a set of edits to disk without leaving a half-rename.
//
// The splice itself lives in the protocol package beside TextEdit, so the conformance suite checks
// provider edits with the same code that applies them here.

import { applyEdits, type FileEdits } from "@nyaa-lexicon/protocol";
import type { WriteOutcome } from "./refusalSlots.js";
import { editsRefused, moduleUnreadable, writeThrew } from "./refusals.js";
import { insideWorkspace, type SourceReader, writableSource, writableText } from "./sourceRead.js";
import { writeSourceFile } from "./sourceWriter.js";

export type { FileEdits } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export type ApplyOutcome = WriteOutcome;

/** A file's staged text, or the first refusal. */
export type StagedEdits =
	| { staged: Array<{ module: string; text: string }> }
	| Extract<ApplyOutcome, { applied: false }>;

////////////////////////////////
//  Functions & Helpers

/** Splices every file's edits without writing. */
export function stageAll(files: Array<Pick<FileEdits, "module" | "edits">>, readSource: SourceReader): StagedEdits {
	const staged: Array<{ module: string; text: string }> = [];

	for (const file of files) {
		const before = writableSource(file.module, readSource(file.module));
		if ("refused" in before) return { applied: false, reason: before.refused, module: file.module };
		if (before.text === null) return { applied: false, reason: moduleUnreadable(file.module), module: file.module };

		const result = applyEdits(before.text, file.edits);
		if ("problem" in result) return { applied: false, reason: editsRefused(result.problem), module: file.module };
		const unwritable = writableText(file.module, result.text);
		if (unwritable !== null) return { applied: false, reason: unwritable, module: file.module };
		staged.push({ module: file.module, text: result.text });
	}
	return { staged };
}

/** Preflights every file. Writes can stop partway. */
export function writeAll(
	workspaceRoot: string,
	files: Array<Pick<FileEdits, "module" | "edits">>,
	readSource: SourceReader,
): ApplyOutcome {
	const preflight = stageAll(files, readSource);
	if (!("staged" in preflight)) return preflight;
	const { staged } = preflight;

	for (const file of staged) {
		try {
			writeSourceFile(insideWorkspace(workspaceRoot, file.module), file.text);
		} catch (error) {
			return { applied: false, reason: writeThrew(error), module: file.module };
		}
	}
	return { applied: true, modules: staged.map((file) => file.module) };
}
