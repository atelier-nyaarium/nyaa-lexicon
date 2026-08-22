// The one reading of a workspace file for indexing. Routing is the caller's; the bound and the
// text check are here, so no second read site can decode a binary or stall on a giant.

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export type SourceRead =
	| { kind: "text"; text: string }
	| { kind: "missing" }
	| { kind: "binary" }
	| { kind: "tooLarge"; bytes: number };

export type SourceReader = (module: string) => SourceRead;

////////////////////////////////
//  Constants

/** Past this a file is generated or data, and the yaml reader is quadratic in keys. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Git's own heuristic: a NUL in the head means binary. */
const BINARY_PROBE_BYTES = 8 * 1024;

////////////////////////////////
//  Functions & Helpers

export function readSource(root: string, module: string): SourceRead {
	const file = path.join(root, module);
	let fd: number;
	try {
		// Before open: opening a FIFO blocks until someone writes it.
		if (!statSync(file).isFile()) return { kind: "missing" };
		fd = openSync(file, "r");
	} catch {
		// Gone between the event and the read: nothing to index.
		return { kind: "missing" };
	}
	try {
		const size = fstatSync(fd).size;
		if (size > MAX_SOURCE_BYTES) return { kind: "tooLarge", bytes: size };
		// Bounded by the size seen, so a file growing under the read cannot outrun the limit.
		const buffer = Buffer.allocUnsafe(size);
		const bytes = buffer.subarray(0, readSync(fd, buffer, 0, size, 0));
		if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { kind: "binary" };
		return { kind: "text", text: bytes.toString("utf8") };
	} catch {
		return { kind: "missing" };
	} finally {
		closeSync(fd);
	}
}

export function sourceReader(root: string): SourceReader {
	return (module) => readSource(root, module);
}

/** Text or nothing, for a reader with no use for the reason. */
export function textOf(read: SourceRead): string | null {
	return read.kind === "text" ? read.text : null;
}

/** A text-only reader lifted to the full shape, for a fixture or an unsaved buffer. */
export function fromText(readFile: (module: string) => string | null): SourceReader {
	return (module) => {
		const text = readFile(module);
		return text === null ? { kind: "missing" } : { kind: "text", text };
	};
}

/** Why a file was not indexed, worded once. */
export function unreadableReason(read: SourceRead & { kind: "binary" | "tooLarge" }): string {
	return read.kind === "binary"
		? "not text: a NUL byte within the first 8 KiB"
		: `${read.bytes} bytes, past the ${MAX_SOURCE_BYTES} byte limit for indexing`;
}
