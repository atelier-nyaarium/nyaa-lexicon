// Splicing edits into whole texts without writing; journaled steps write.
//
// The splice itself lives in the protocol package beside TextEdit, so the conformance suite checks
// provider edits with the same code that applies them here.

import { applyEdits, type FileEdits } from "@nyaa-lexicon/protocol";
import type { WriteOutcome } from "./refusalSlots.js";
import { editsRefused, moduleUnreadable } from "./refusals.js";
import { type SourceReader, writableSource, writableText } from "./sourceRead.js";

export type { FileEdits } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/** A file's staged text, or the first refusal. */
export type StagedEdits =
	| { staged: Array<{ module: string; text: string }> }
	| Extract<WriteOutcome, { applied: false }>;

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
