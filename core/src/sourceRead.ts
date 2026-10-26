// The one reading of a workspace file, for indexing and for a writer. Routing is the caller's; the
// bound and the text check are here, so no second read site can decode a binary or stall on a giant.
//
// The secret policy opens reads before exposing views.

import type { Range } from "@nyaa-lexicon/protocol";
import {
	MAX_SOURCE_BYTES,
	readWorkspaceFile,
	readWorkspaceHead,
	resolveContained,
	workspaceFile,
} from "@nyaa-lexicon/protocol";
import {
	moduleNotText,
	moduleNotUtf8,
	moduleOutsideWorkspace,
	type Refusal,
	secretFile,
	textNotEncodable,
} from "./refusals.js";

////////////////////////////////
//  Interfaces & Types

/** Raw read; only its reader and policy hold it. */
export type SourceRead =
	| {
			kind: "text";
			text: string;
			/** UTF-8 round-trip preserves source bytes, including BOM. */
			lossless: boolean;
			real?: string;
	  }
	| { kind: "missing" }
	| { kind: "binary"; real?: string }
	| { kind: "tooLarge"; bytes: number; real?: string }
	/** Path escaped through a link. */
	| { kind: "outside" };

/** A read with no text. */
export type NoText = Exclude<SourceRead, { kind: "text" }>;

declare const sealedBrand: unique symbol;

type WithoutText<T> = T extends { text: string } ? Omit<T, "text"> : T;

/** Text is sealed; metadata remains module-bound. */
export type SealedRead = WithoutText<SourceRead> & {
	readonly module: string;
	readonly real?: string;
	readonly [sealedBrand]: true;
};

/** Sealed read with text. */
export type SealedText = SealedRead & { kind: "text" };

export type SourceReader = (module: string) => SealedRead;

/** Unmasked module text. */
export interface PlainView {
	kind: "plain";
	text: string;
	hash: string;
	/** UTF-8 round-trip preserves source bytes. */
	lossless: boolean;
}

/** Module text with hidden values masked. */
export interface MaskedView {
	kind: "masked";
	/** Hidden spans blanked; newlines remain. */
	text: string;
	/** Collapsed view hash. */
	hash: string;
	/** Whether any span is hidden. */
	hidden: boolean;
	hiddenRanges(): readonly Range[];
	/** Reads hidden spans as markers; null for invalid ranges. */
	slice(range: Range): string | null;
	/** Fixed markers; source newlines remain. */
	display(range?: Range): string | null;
	/** Whether hidden text or a whole-file secret overlaps a range. */
	touches(range: Range): boolean;
	/** Whether a range lies inside an omitted extent. */
	omits(range: Range): boolean;
}

/** View whose text is refused. */
export interface RefusedView {
	kind: "refused";
	hash: string;
}

/** Consumer view of a text read. */
export type TextView = PlainView | MaskedView | RefusedView;

/** Module view, including non-text reads. */
export type AllowedView = TextView | NoText;

export type ViewReader = (module: string) => AllowedView;

/** Lossless text, null when absent, or a write refusal. */
export type WritableSource = { text: string | null } | { refused: Refusal };

export { MAX_SOURCE_BYTES };

////////////////////////////////
//  Constants

/** Reason for an outside path. */
export const OUTSIDE_WORKSPACE_REASON = "its real path leaves the workspace";

/** Reason for a denied path. */
export const DENIED_BY_SCOPE_REASON = "denied by scope";

/** Raw reads kept off sealed values. */
const sealedReads = new WeakMap<object, SourceRead>();

////////////////////////////////
//  Functions & Helpers

/**
 * Validates a write destination. Rejects directory links escaping the workspace.
 */
export function insideWorkspace(root: string, module: string): string {
	if (workspaceFile(root, module) === null) {
		throw new Error(`module path must stay inside the workspace, got: ${module}`);
	}
	const where = resolveContained(root, module, "keep");
	if (where.kind !== "outside") return where.path;
	throw new Error(`module path must not leave the workspace through a link, got: ${module}`);
}

/** Seals a read and binds it to a module. */
export function seal(module: string, read: SourceRead): SealedRead {
	const shape =
		read.kind === "text"
			? { kind: read.kind, lossless: read.lossless, ...(read.real === undefined ? {} : { real: read.real }) }
			: read;
	const sealed = { ...shape, module } as SealedRead;
	sealedReads.set(sealed, read);
	return sealed;
}

/** Opens a sealed read for policy evaluation. */
export function unseal(sealed: SealedRead): SourceRead {
	const read = sealedReads.get(sealed);
	if (read === undefined) throw new Error(`not a sealed read: ${sealed.module}`);
	return read;
}

export function readSource(root: string, module: string): SealedRead {
	const read = readWorkspaceFile(root, module);
	// Unreadable reads count as missing.
	return seal(module, read.kind === "unreadable" ? { kind: "missing" } : read);
}

/** Applies size, NUL, and UTF-8 checks to supplied bytes. */
export function sourceReadBytes(module: string, bytes: Uint8Array | null): SealedRead {
	if (bytes === null) return seal(module, { kind: "binary" });
	if (bytes.length > MAX_SOURCE_BYTES) return seal(module, { kind: "tooLarge", bytes: bytes.length });
	if (bytes.subarray(0, 8192).includes(0)) return seal(module, { kind: "binary" });
	const text = Buffer.from(bytes).toString("utf8");
	const lossless = Buffer.from(text, "utf8").equals(Buffer.from(bytes));
	return seal(module, { kind: "text", text, lossless });
}

/** False when UTF-8 encoding changes text. */
function encodesLosslessly(text: string): boolean {
	return Buffer.from(text, "utf8").toString("utf8") === text;
}

export function sourceReader(root: string): SourceReader {
	return (module) => readSource(root, module);
}

/** Maps a policy view to writable source text. */
export function writableSource(module: string, view: AllowedView): WritableSource {
	switch (view.kind) {
		case "plain":
			return view.lossless ? { text: view.text } : { refused: moduleNotUtf8(module) };
		case "missing":
			return { text: null };
		case "outside":
			return { refused: moduleOutsideWorkspace(module) };
		case "masked":
		case "refused":
			return { refused: secretFile(module) };
		default:
			return { refused: moduleNotText(module, unreadableReason(view)) };
	}
}

/** Refuses text that cannot round-trip through UTF-8. */
export function writableText(module: string, text: string): Refusal | null {
	return encodesLosslessly(text) ? null : textNotEncodable(module);
}

/** First line for shebang detection, or undefined if unreadable. */
export function readHead(root: string, module: string): string | undefined {
	return readWorkspaceHead(root, module);
}

/** Adapts text reads to the source reader. */
export function fromText(readFile: (module: string) => string | null): SourceReader {
	return (module) => {
		const text = readFile(module);
		if (text === null) return seal(module, { kind: "missing" });
		return seal(module, { kind: "text", text, lossless: encodesLosslessly(text) });
	};
}

/** Hash for text or refused views; null for non-text reads. */
export function hashOfView(view: AllowedView): string | null {
	return view.kind === "plain" || view.kind === "masked" || view.kind === "refused" ? view.hash : null;
}

/** Explains why non-text files are refused. */
export function unreadableReason(read: NoText & { kind: "binary" | "tooLarge" }): string {
	return read.kind === "binary"
		? "not text: a NUL byte within the first 8 KiB"
		: `${read.bytes} bytes, past the ${MAX_SOURCE_BYTES} byte limit for indexing`;
}
