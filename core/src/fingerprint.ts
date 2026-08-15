// Store compatibility policy.

import { readFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Functions & Helpers

/**
 * Returns the store's writing major.
 * Null skips compatibility checks.
 */
export function storeCompatibilityKey(root: string): string | null {
	let version: unknown;
	try {
		version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown }).version;
	} catch {
		return null;
	}
	if (typeof version !== "string") return null;
	// Whole semver only. A partial match would read "1.x" as major 1 and claim compatibility.
	const major = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim())?.[1];
	return major === undefined ? null : major;
}
