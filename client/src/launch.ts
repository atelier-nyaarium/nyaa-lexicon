// The SOLE owner of how lexicon starts bun. Its own settings files, no `.env`, no auto-install: the
// folder a process starts in, often the indexed repo, never runs code inside it.

import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type PlatformEnv, stateRoot } from "./paths.js";
import type { BunExecutable } from "./runtime.js";

////////////////////////////////
//  Constants

/** Replaces the starting folder's `bunfig.toml`. The plugin's committed copy must match. */
export const RUNTIME_BUNFIG = "# Lexicon's own bun settings, so an indexed repo's bunfig.toml never applies.\n";

/** Replaces the starting folder's `tsconfig.json`. The plugin's committed copy must match. */
export const RUNTIME_TSCONFIG = "{}\n";

/** Files, not a directory: every directory under the state root is read as a store. */
const BUNFIG_FILE = "runtime.bunfig.toml";
const TSCONFIG_FILE = "runtime.tsconfig.json";

////////////////////////////////
//  Functions & Helpers

/** Writes `text` unless a regular file already holds exactly it; a symlink is replaced, never followed. */
function ensureFile(file: string, text: string): void {
	try {
		if (lstatSync(file).isFile() && readFileSync(file, "utf8") === text) return;
	} catch {}
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, file);
}

/** The argv prefix for every bun process Lexicon starts. */
export function bunCommand(runtime: Extract<BunExecutable, { kind: "bun" }>, host: PlatformEnv): string[] {
	const root = stateRoot(host);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const config = path.join(root, BUNFIG_FILE);
	const tsconfig = path.join(root, TSCONFIG_FILE);
	ensureFile(config, RUNTIME_BUNFIG);
	ensureFile(tsconfig, RUNTIME_TSCONFIG);
	return [
		runtime.executable,
		`--config=${config}`,
		`--tsconfig-override=${tsconfig}`,
		"--no-env-file",
		"--no-install",
	];
}
