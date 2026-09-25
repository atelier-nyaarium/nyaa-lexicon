// Commits the working tree, untracked files and a fresh dist/ included, so a project pinning
// Lexicon as a submodule can try unreleased work. Nothing in the checkout changes.
//
//   bun run snapshot                       # stdout: {"ref","sha","subject"}
//   bun scripts/snapshot.ts <checkout>     # another checkout, as tests do

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, gitOrNull, outliveInterrupts } from "./child";
import { withBuiltDist } from "./dist";

////////////////////////////////
//  Interfaces & Types

export interface Snapshot {
	ref: string;
	sha: string;
	subject: string;
}

////////////////////////////////
//  Constants

const ROOT = path.join(import.meta.dirname, "..");
/** Keeps the newest snapshot fetchable. */
export const SNAPSHOT_REF = "refs/snapshots/dev";
/** Marks snapshots for consumer builds. */
export const SNAPSHOT_PREFIX = "Dev snapshot of ";

////////////////////////////////
//  Functions & Helpers

/** Scratch index preserves real staging. */
function commitWorkingTree(root: string): Snapshot {
	const scratch = mkdtempSync(path.join(tmpdir(), "lexicon-snapshot-"));
	const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
	try {
		// A copy keeps the stat cache, so unchanged files are not rehashed.
		copyFileSync(path.resolve(root, git(root, ["rev-parse", "--git-path", "index"])), env.GIT_INDEX_FILE);
		git(root, ["add", "--all"], env);
		const tree = git(root, ["write-tree"], env);
		const head = git(root, ["rev-parse", "HEAD"]);
		const branch = gitOrNull(root, ["symbolic-ref", "--short", "HEAD"]) ?? "a detached HEAD";
		const subject = `${SNAPSHOT_PREFIX}${head.slice(0, 7)} on ${branch}`;
		const sha = git(root, ["commit-tree", tree, "-p", head, "-m", subject]);
		git(root, ["update-ref", SNAPSHOT_REF, sha]);
		return { ref: SNAPSHOT_REF, sha, subject };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function snapshot(root: string): Snapshot {
	if (gitOrNull(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) === null) {
		throw new Error(`${root} has no commit to snapshot from`);
	}
	return withBuiltDist([root], () => commitWorkingTree(root));
}

////////////////////////////////
//  Main

if (import.meta.main) {
	outliveInterrupts();
	try {
		console.log(JSON.stringify(snapshot(process.argv[2] ?? ROOT)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
