// The one reading of a workspace file for indexing. Routing is the caller's; the bound and the
// text check are here, so no second read site can decode a binary or stall on a giant.

import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { workspaceFile } from "@nyaa-lexicon/protocol";

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

/**
 * The absolute path a WRITE may land on, or a named refusal. Reads follow the name as given;
 * a write must also land under the real root, since a directory link inside the workspace can
 * point outside it and a rename through it would create the file there.
 */
export function insideWorkspace(root: string, module: string): string {
	const file = workspaceFile(root, module);
	if (file === null) throw new Error(`module path must stay inside the workspace, got: ${module}`);
	const realRoot = realpathSync(root);
	const parent = realpathSync(nearestExisting(path.dirname(file)));
	if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) {
		throw new Error(`module path must not leave the workspace through a link, got: ${module}`);
	}
	return file;
}

/** The closest ancestor on disk, so a file in a directory not yet created is judged by its future parent. */
function nearestExisting(dir: string): string {
	let current = dir;
	while (!existsSync(current)) {
		const up = path.dirname(current);
		if (up === current) return current;
		current = up;
	}
	return current;
}

export function readSource(root: string, module: string): SourceRead {
	// Outside the root there is nothing of this workspace to read.
	const file = workspaceFile(root, module);
	if (file === null) return { kind: "missing" };
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
