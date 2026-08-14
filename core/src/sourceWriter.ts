// The one way a source file in the workspace is written, and the one place its temp name is spelled.
//
// Three modules used to hand-roll the same write-then-rename, each spelling `.lexicon-tmp` itself,
// while recovery swept for exactly that literal. The crash guarantee therefore held only because
// three authors happened to agree, and nothing would have failed if one drifted. Now the suffix has
// a single definition and recovery asks this module what to look for.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Constants

/** Recovery greps for this, so it is defined once and read, never retyped. */
const TEMPORARY_SUFFIX = ".lexicon-tmp";

////////////////////////////////
//  Functions & Helpers

/** Where a half-finished write would have left its temp file. */
export function temporaryPathFor(full: string): string {
	return `${full}${TEMPORARY_SUFFIX}`;
}

/**
 * Write one file so a crash cannot truncate it: a temp file, then a rename.
 *
 * Takes bytes or text, because restoring a journalled image writes the exact bytes it captured
 * while an edit writes decoded text, and routing one of them around this module is how the
 * convention drifted in the first place.
 */
export function writeSourceFile(full: string, contents: string | Uint8Array): void {
	const temporary = temporaryPathFor(full);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(temporary, contents);
	renameSync(temporary, full);
}

/** Removes the temp file a write left behind when it died between the write and the rename. */
export function sweepTemporary(full: string): void {
	const temporary = temporaryPathFor(full);
	if (existsSync(temporary)) rmSync(temporary, { force: true });
}
