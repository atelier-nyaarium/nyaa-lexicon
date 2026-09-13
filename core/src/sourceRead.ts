// The one reading of a workspace file, for indexing and for a writer. Routing is the caller's; the
// bound and the text check are here, so no second read site can decode a binary or stall on a giant.

import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { firstLineOfFile, workspaceFile } from "@nyaa-lexicon/protocol";
import { moduleNotText, moduleNotUtf8, type Refusal, textNotEncodable } from "./refusals.js";

////////////////////////////////
//  Interfaces & Types

export type SourceRead =
	| {
			kind: "text";
			text: string;
			/** Re-encoding `text` as UTF-8 gives back the bytes read; a BOM does. */
			lossless: boolean;
	  }
	| { kind: "missing" }
	| { kind: "binary" }
	| { kind: "tooLarge"; bytes: number };

export type SourceReader = (module: string) => SourceRead;

/** Lossless text, null when absent, or why a writer may not splice it. */
export type WritableSource = { text: string | null } | { refused: Refusal };

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
		const text = bytes.toString("utf8");
		return { kind: "text", text, lossless: roundTrips(text, bytes) };
	} catch {
		return { kind: "missing" };
	} finally {
		closeSync(fd);
	}
}

/** No replacement character, nothing dropped. */
function roundTrips(text: string, bytes: Buffer): boolean {
	return !text.includes(REPLACEMENT_CHARACTER) || Buffer.from(text, "utf8").equals(bytes);
}

/** False for a lone surrogate, which encodes as U+FFFD. */
function encodesLosslessly(text: string): boolean {
	return Buffer.from(text, "utf8").toString("utf8") === text;
}

export function sourceReader(root: string): SourceReader {
	return (module) => readSource(root, module);
}

/** The one read a writer splices over. */
export function writableSource(module: string, read: SourceRead): WritableSource {
	switch (read.kind) {
		case "text":
			return read.lossless ? { text: read.text } : { refused: moduleNotUtf8(module) };
		case "missing":
			return { text: null };
		default:
			return { refused: moduleNotText(module, unreadableReason(read)) };
	}
}

/** Text bound for a module, refused when UTF-8 cannot carry it. */
export function writableText(module: string, text: string): Refusal | null {
	return encodesLosslessly(text) ? null : textNotEncodable(module);
}

/** A module's first line from its opening bytes, for a shebang claim; undefined when unreadable. */
export function readHead(root: string, module: string): string | undefined {
	const file = workspaceFile(root, module);
	if (file === null) return undefined;
	try {
		// Before open: opening a FIFO blocks until someone writes it.
		if (!statSync(file).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return firstLineOfFile(file);
}

/** Text or nothing, for a reader with no use for the reason. */
export function textOf(read: SourceRead): string | null {
	return read.kind === "text" ? read.text : null;
}

/** A text-only reader lifted to the full shape, for a fixture or an unsaved buffer. */
export function fromText(readFile: (module: string) => string | null): SourceReader {
	return (module) => {
		const text = readFile(module);
		if (text === null) return { kind: "missing" };
		return { kind: "text", text, lossless: encodesLosslessly(text) };
	};
}

/** Why a file was not indexed, worded once. */
export function unreadableReason(read: SourceRead & { kind: "binary" | "tooLarge" }): string {
	return read.kind === "binary"
		? "not text: a NUL byte within the first 8 KiB"
		: `${read.bytes} bytes, past the ${MAX_SOURCE_BYTES} byte limit for indexing`;
}
