// Keep text and byte hashes distinct.

import { createHash } from "node:crypto";

////////////////////////////////
//  Constants

/** Hex characters kept: 128 bits, enough to never collide inside one workspace. */
const HASH_LENGTH = 32;

////////////////////////////////
//  Functions & Helpers

/**
 * The first 32 hex characters of the sha256 of the file's UTF-8 DECODED text. A BOM and CRLF are
 * part of the text; the result equals a hash of the raw bytes exactly when they were valid UTF-8.
 */
export function hashContent(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

/** Preserve distinctions lost by UTF-8 decoding. */
export function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH);
}
