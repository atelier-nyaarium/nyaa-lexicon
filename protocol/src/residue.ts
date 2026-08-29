// Sweeping source for a residue test: traversal and comment stripping only. Every rule stays in
// the test that enforces it, with the roots and skips it chose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

////////////////////////////////
//  Functions & Helpers

/** Every `.ts` under `dir`, never entering a directory named in `skip`. A missing root sweeps nothing. */
export function sourceFiles(dir: string, skip: Iterable<string>): string[] {
	const skipped = new Set(skip);
	const found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (skipped.has(entry)) continue;
			found.push(...sourceFiles(full, skipped));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(full);
	}
	return found;
}

/**
 * A swept file's text, or null when it is gone.
 *
 * Listing and reading are two moments. A file written and removed by a test running in parallel
 * exists for the first and not the second, and a sweep that reads it directly dies on ENOENT with a
 * message about the wrong thing. A path that no longer exists holds no violation.
 */
export function readSwept(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** Comments only. Strings survive: a rule's token inside one is exactly what a sweep looks for. */
export function codeOnly(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}
