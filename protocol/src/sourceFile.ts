// The one policy for reading a source file to index: containment, a size bound and a binary guard.
// The core and a provider building its own workspace index read through it, so the two never admit
// different files.

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { firstLineOf } from "./shebang.js";
import { resolveContained } from "./workspacePath.js";

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

/** Its real path leaves the workspace, through a link. */
export type OutsideRead = { kind: "outside" };

type Opened = { kind: "open"; fd: number } | OutsideRead | { kind: "missing" } | { kind: "unreadable" };

////////////////////////////////
//  Constants

/** Past this a file is generated or data, and the yaml reader is quadratic in keys. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Git's own heuristic: a NUL in the head means binary. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** Enough of a file to hold its shebang line. */
const SHEBANG_PROBE_BYTES = 256;

/** Left for a later read if the file keeps changing. */
const OPEN_ATTEMPTS = 3;

/** What a decode puts in place of dropped bytes. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

////////////////////////////////
//  Functions & Helpers

function missing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** A module's bytes, only when its real path stays in the root. */
export function readWorkspaceFile(root: string, module: string): SourceFileRead | OutsideRead {
	const opened = openContained(root, module);
	if (opened.kind !== "open") return opened;
	try {
		return readSourceFile(opened.fd);
	} finally {
		closeSync(opened.fd);
	}
}

/** A module's first line, for a shebang claim; undefined outside the workspace. */
export function readWorkspaceHead(root: string, module: string): string | undefined {
	const opened = openContained(root, module);
	if (opened.kind !== "open") return undefined;
	try {
		return firstLineOfFile(opened.fd);
	} finally {
		closeSync(opened.fd);
	}
}

/** Re-resolves after opening, so a link swapped mid-open is caught, not read. */
function openContained(root: string, module: string): Opened {
	for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
		let fd: number;
		try {
			const where = resolveContained(root, module);
			if (where.kind === "outside") return where;
			if (where.kind === "absent") return { kind: "missing" };
			// Before open: opening a FIFO blocks until someone writes it.
			if (!statSync(where.path).isFile()) return { kind: "missing" };
			fd = openSync(where.path, "r");
		} catch (error) {
			return missing(error) ? { kind: "missing" } : { kind: "unreadable" };
		}
		const still = stillContained(root, module, fd);
		if (still === "same") return { kind: "open", fd };
		closeSync(fd);
		if (still !== "moved") return { kind: still };
	}
	return { kind: "unreadable" };
}

/** `moved` for a file replaced since the open, e.g. an editor save. */
function stillContained(
	root: string,
	module: string,
	fd: number,
): "same" | "moved" | "outside" | "missing" | "unreadable" {
	try {
		const again = resolveContained(root, module);
		if (again.kind !== "file") return again.kind === "outside" ? "outside" : "missing";
		const opened = fstatSync(fd);
		const current = statSync(again.path);
		return opened.dev === current.dev && opened.ino === current.ino ? "same" : "moved";
	} catch (error) {
		return missing(error) ? "moved" : "unreadable";
	}
}

function readSourceFile(fd: number): SourceFileRead {
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
	}
}

/** Empty when the opening bytes cannot be read. */
function firstLineOfFile(fd: number): string {
	try {
		const buffer = Buffer.allocUnsafe(SHEBANG_PROBE_BYTES);
		const bytes = readSync(fd, buffer, 0, SHEBANG_PROBE_BYTES, 0);
		return firstLineOf(buffer.subarray(0, bytes).toString("utf8"));
	} catch {
		return "";
	}
}

/** No replacement character, nothing dropped. */
function roundTrips(text: string, bytes: Buffer): boolean {
	return !text.includes(REPLACEMENT_CHARACTER) || Buffer.from(text, "utf8").equals(bytes);
}
