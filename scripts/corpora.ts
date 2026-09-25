// Clones pinned corpora into temp/.
// Tests require local copies.
//
//   bun run corpora            # clone or move to the pins; refuses local edits
//   bun run corpora --reset    # and discard local edits

import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { git, gitOrNull } from "./child";

////////////////////////////////
//  Interfaces & Types

export interface Corpus {
	/** Name under `temp/`. */
	dir: string;
	url: string;
	commit: string;
	/** Reader-facing release label. */
	label: string;
}

////////////////////////////////
//  Constants

const ROOT = path.join(import.meta.dirname, "..");
export const TEMP_DIR = "temp";

export const CORPORA: Corpus[] = [
	{
		dir: "ripgrep",
		url: "https://github.com/BurntSushi/ripgrep.git",
		commit: "e89fff89ac9af12e8d4ce9d5fd07beb408ca730f",
		label: "15.2.0",
	},
	{
		dir: "json",
		url: "https://github.com/nlohmann/json.git",
		commit: "55f93686c01528224f448c19128836e7df245f72",
		label: "v3.12.0",
	},
	{
		dir: "libuv",
		url: "https://github.com/libuv/libuv.git",
		commit: "840404ce8ba7cc0204be52389a6cfff9f2c90fb6",
		label: "v1.53.0",
	},
	{
		dir: "bl602-ghidra",
		url: "https://github.com/lupyuen/bl602nutcracker1.git",
		commit: "e7e1584795365c028d6b13af543b94c299b9914c",
		label: "main, 2021-07",
	},
	{
		dir: "newtonsoft-json",
		url: "https://github.com/JamesNK/Newtonsoft.Json.git",
		commit: "4e13299d4b0ec96bd4df9954ef646bd2d1b5bf2a",
		label: "13.0.4",
	},
	{
		dir: "kotlinx-coroutines",
		url: "https://github.com/Kotlin/kotlinx.coroutines.git",
		commit: "8564f65764d3d05893cec026c6e94250e2b23874",
		label: "1.11.0",
	},
];

////////////////////////////////
//  Functions & Helpers

function headOf(dir: string): string | null {
	return gitOrNull(dir, ["rev-parse", "HEAD"]);
}

function hasCommit(dir: string, commit: string): boolean {
	return gitOrNull(dir, ["cat-file", "-e", `${commit}^{commit}`]) !== null;
}

/** Require an independent repository. */
function ownsRepo(dir: string): boolean {
	return gitOrNull(dir, ["rev-parse", "--show-toplevel"]) === realpathSync(dir);
}

/** Fetch pins; reset discards ignored files too. */
function fetchCorpus(corpus: Corpus, reset: boolean): "present" | "restored" | "fetched" {
	const dir = path.join(ROOT, TEMP_DIR, corpus.dir);
	if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
		throw new Error(`${dir} is a symlink; corpora are managed clones, so remove it and run again`);
	}
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		git(dir, ["init", "--quiet"]);
	} else if (!ownsRepo(dir)) {
		throw new Error(`${dir} exists and is not a git checkout; remove it and run again`);
	}
	// A run stopped between init and this point left no remote.
	if (gitOrNull(dir, ["remote", "get-url", "origin"]) !== corpus.url) {
		gitOrNull(dir, ["remote", "remove", "origin"]);
		git(dir, ["remote", "add", "origin", corpus.url]);
	}
	const clean = git(dir, ["status", "--porcelain", "--ignored"]) === "";
	if (headOf(dir) === corpus.commit && clean) return "present";
	if (!clean && !reset) throw new Error(`${dir} has local edits; run bun run corpora --reset to discard them`);
	const fetched = !hasCommit(dir, corpus.commit);
	if (fetched) git(dir, ["fetch", "--quiet", "--depth", "1", "origin", corpus.commit]);
	git(dir, ["checkout", "--quiet", "--force", "--detach", corpus.commit]);
	git(dir, ["clean", "-fdqx"]);
	if (headOf(dir) !== corpus.commit) throw new Error(`${corpus.commit} is not a commit; pin the commit, not a tag`);
	return fetched ? "fetched" : "restored";
}

////////////////////////////////
//  Main

if (import.meta.main) {
	const reset = process.argv.includes("--reset");
	const failed: string[] = [];
	for (const corpus of CORPORA) {
		try {
			console.log(`${corpus.dir} (${corpus.label}): ${fetchCorpus(corpus, reset)}`);
		} catch (error) {
			failed.push(corpus.dir);
			console.error(`${corpus.dir}: ${error instanceof Error ? error.message : error}`);
		}
	}
	if (failed.length > 0) {
		console.error(`\ncorpora FAILED: ${failed.join(", ")}`);
		process.exit(1);
	}
}
