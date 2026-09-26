// The one reading of a workspace file, for indexing and for a writer. Routing is the caller's; the
// bound and the text check are here, so no second read site can decode a binary or stall on a giant.

import {
	MAX_SOURCE_BYTES,
	readWorkspaceFile,
	readWorkspaceHead,
	resolveContained,
	workspaceFile,
} from "@nyaa-lexicon/protocol";
import { moduleNotText, moduleNotUtf8, moduleOutsideWorkspace, type Refusal, textNotEncodable } from "./refusals.js";

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
	| { kind: "tooLarge"; bytes: number }
	/** Its real path leaves the workspace, through a link. */
	| { kind: "outside" };

export type SourceReader = (module: string) => SourceRead;

/** Lossless text, null when absent, or why a writer may not splice it. */
export type WritableSource = { text: string | null } | { refused: Refusal };

export { MAX_SOURCE_BYTES };

////////////////////////////////
//  Constants

/** Refusal reason for a module outside the workspace. */
export const OUTSIDE_WORKSPACE_REASON = "its real path leaves the workspace";

////////////////////////////////
//  Functions & Helpers

/**
 * The absolute path a WRITE may land on, or a named refusal.
 * Refuses when a directory link inside the workspace would let the write land outside it.
 */
export function insideWorkspace(root: string, module: string): string {
	if (workspaceFile(root, module) === null) {
		throw new Error(`module path must stay inside the workspace, got: ${module}`);
	}
	const where = resolveContained(root, module, "keep");
	if (where.kind !== "outside") return where.path;
	throw new Error(`module path must not leave the workspace through a link, got: ${module}`);
}

export function readSource(root: string, module: string): SourceRead {
	const read = readWorkspaceFile(root, module);
	// Unreadable indexes as missing, like a gone file.
	return read.kind === "unreadable" ? { kind: "missing" } : read;
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
		case "outside":
			return { refused: moduleOutsideWorkspace(module) };
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
	return readWorkspaceHead(root, module);
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
