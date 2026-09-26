import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Constants

/** Recovery recognizes this suffix. */
const TEMPORARY_SUFFIX = ".lexicon-tmp";

////////////////////////////////
//  Functions & Helpers

export function temporaryPathFor(full: string): string {
	return `${full}${TEMPORARY_SUFFIX}`;
}

function modeOf(full: string): number | null {
	try {
		const stat = lstatSync(full);
		return stat.isFile() ? stat.mode & 0o7777 : null;
	} catch {
		return null;
	}
}

/** Atomically replaces files; preserves regular-file modes. */
export function writeSourceFile(full: string, contents: string | Uint8Array): void {
	const temporary = temporaryPathFor(full);
	mkdirSync(path.dirname(full), { recursive: true });
	sweepTemporary(full);
	const mode = modeOf(full);
	// Exclusive creation rejects link races.
	writeFileSync(temporary, contents, { flag: "wx" });
	try {
		if (mode !== null) chmodSync(temporary, mode);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	renameSync(temporary, full);
}

/** Removes leftovers without following links. */
export function sweepTemporary(full: string): void {
	const temporary = temporaryPathFor(full);
	try {
		lstatSync(temporary);
	} catch {
		return;
	}
	rmSync(temporary, { force: true });
}
