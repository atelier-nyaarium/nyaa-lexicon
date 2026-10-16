// Records git operations.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemClock } from "../clock";
import { runGit } from "../fileScope";
import type { GitEvidenceHost } from "../gitEvidence";

////////////////////////////////
//  Interfaces & Types

export interface CountingHost {
	host: GitEvidenceHost;
	/** Git arguments, ordered. */
	spawns: string[][];
	/** Absolute directory reads. */
	reads: string[];
	/** Git commands and stats, ordered. */
	events: string[];
}

////////////////////////////////
//  Functions & Helpers

/** Creates a canonical temp directory. */
export function tempDir(label: string, roots: string[]): string {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), `lexicon-${label}-`)));
	roots.push(root);
	return root;
}

export function write(root: string, module: string, text = "x\n"): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** Uses real git with supplied home. */
export function countingHost(home: string): CountingHost {
	const spawns: string[][] = [];
	const reads: string[] = [];
	const events: string[] = [];
	const host: GitEvidenceHost = {
		git: (cwd, args) => {
			spawns.push([...args]);
			events.push(`git ${args[0]}`);
			return runGit(systemClock, cwd, [...args]);
		},
		fs: {
			readdir: (directory) => {
				reads.push(directory);
				return readdirSync(directory, { withFileTypes: true });
			},
			stat: (file) => {
				events.push(`stat ${file}`);
				const stat = statSync(file, { throwIfNoEntry: false });
				return stat === undefined ? null : { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
			},
			readText: (file) => {
				try {
					return readFileSync(file, "utf8");
				} catch {
					return null;
				}
			},
			realpath: (file) => realpathSync.native(file),
		},
		env: { HOME: home },
	};
	return { host, spawns, reads, events };
}
