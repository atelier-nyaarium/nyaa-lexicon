// What produced the facts, so the index can tell when that changed.
//
// Content-addressed invalidation decides a file event against the file's own hash, which is right
// for the half of the problem it covers. Extraction is a function of the file AND the code that
// reads it, so a provider that changes how it classifies leaves every stored fact stale while no
// file has changed, and a rescan correctly skips all of them. Measured: correcting the TypeScript
// provider to report a type alias as `interface` rather than `typeParameter` left a running daemon
// answering the old kind through a full rescan, because the file it described never moved.
//
// The fingerprint covers the PROVIDERS, which extract, and the PROTOCOL, which owns the fact id
// grammar and the schemas facts are written against. It deliberately does NOT cover the core's own
// query code: that is read-side, computed per question, and nothing it does is stored.

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Constants

/** Directories whose source decides what gets STORED. */
const FINGERPRINTED = ["providers", "protocol"];

const SOURCE_EXTENSIONS = [".ts", ".py", ".gd", ".json"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".tsbuild", "__tests__", "tmp", ".git"]);

/** Deep enough for any real source layout, and a stop for a symlink loop. */
const MAX_DEPTH = 10;

////////////////////////////////
//  Functions & Helpers

/** Every source file whose content could change what a provider reports, in a stable order. */
function sourceFiles(root: string): string[] {
	const found: string[] = [];

	const walk = (directory: string, depth: number) => {
		if (depth > MAX_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
				continue;
			}
			if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(full);
		}
	};

	for (const directory of FINGERPRINTED) walk(path.join(root, directory), 0);
	return found;
}

/**
 * A hash of the code that writes facts, or null when that code is not on disk to be read.
 *
 * Null is a real answer and means the check is skipped, not that everything matches. An install
 * shape with no provider source present would otherwise rebuild its index on every start, which
 * trades a stale answer for a permanently slow one.
 *
 * Paths are included alongside contents, so adding a provider changes the fingerprint even if the
 * new file happens to duplicate an existing one.
 */
export function indexerFingerprint(root: string): string | null {
	const files = sourceFiles(root);
	if (files.length === 0) return null;

	const digest = createHash("sha256");
	for (const file of files) {
		try {
			digest.update(path.relative(root, file));
			digest.update(readFileSync(file));
		} catch {
			// An unreadable file is skipped rather than fatal: a fingerprint over most of the source
			// still detects the edits this exists to catch.
		}
	}
	return digest.digest("hex").slice(0, 32);
}
