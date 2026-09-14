// The one policy for reading a source file to index: a size bound and a binary guard. The core and a
// provider building its own workspace index read through it, so the two never admit different files.

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

////////////////////////////////
//  Interfaces & Types

export type SourceFileRead =
	| {
			kind: "text";
			text: string;
			/** Re-encoding `text` as UTF-8 gives back the bytes read; a BOM does. */
			lossless: boolean;
	  }
	/** Absent, or not a regular file. */
	| { kind: "missing" }
	/** Present, but the read failed; a later read may succeed. */
	| { kind: "unreadable" }
	| { kind: "binary" }
	| { kind: "tooLarge"; bytes: number };

////////////////////////////////
//  Constants

/** Past this a file is generated or data, and the yaml reader is quadratic in keys. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Git's own heuristic: a NUL in the head means binary. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** What a decode puts in place of dropped bytes. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

////////////////////////////////
//  Functions & Helpers

function missing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

export function readSourceFile(absolute: string): SourceFileRead {
	let fd: number;
	try {
		// Before open: opening a FIFO blocks until someone writes it.
		if (!statSync(absolute).isFile()) return { kind: "missing" };
		fd = openSync(absolute, "r");
	} catch (error) {
		return missing(error) ? { kind: "missing" } : { kind: "unreadable" };
	}
	try {
		const size = fstatSync(fd).size;
		if (size > MAX_SOURCE_BYTES) return { kind: "tooLarge", bytes: size };
		// Bounded by the size seen, so a file growing under the read cannot outrun the limit.
		const buffer = Buffer.allocUnsafe(size);
		const bytes = buffer.subarray(0, readSync(fd, buffer, 0, size, 0));
		if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { kind: "binary" };
		const text = bytes.toString("utf8");
		return { kind: "text", text, lossless: roundTrips(text, bytes) };
	} catch {
		return { kind: "unreadable" };
	} finally {
		closeSync(fd);
	}
}

/** No replacement character, nothing dropped. */
function roundTrips(text: string, bytes: Buffer): boolean {
	return !text.includes(REPLACEMENT_CHARACTER) || Buffer.from(text, "utf8").equals(bytes);
}
