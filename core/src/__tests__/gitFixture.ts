// Async git calls for test fixtures, so a hung fixture setup cannot busy-wait the test runner the
// way a synchronous exec can lose a child's exit under load.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Initializes a fresh, quiet git repository at `root`. */
export async function gitInit(root: string): Promise<void> {
	await run("git", ["init", "-q"], { cwd: root });
}

/** Sets a key in the repository's own `.git/config`. */
export async function gitConfig(root: string, key: string, value: string): Promise<void> {
	await run("git", ["config", key, value], { cwd: root });
}

/** Stages paths at `root`, e.g. `gitAdd(root, "-A")` or `gitAdd(root, "src/a.ts")`. */
export async function gitAdd(root: string, ...paths: string[]): Promise<void> {
	await run("git", ["add", ...paths], { cwd: root });
}

/** Commits what is staged at `root`, with a fixed identity so no host's git config is needed. */
export async function gitCommit(root: string, message: string): Promise<void> {
	await run(
		"git",
		["-c", "user.name=lexicon-test", "-c", "user.email=lexicon-test@example.com", "commit", "-q", "-m", message],
		{
			cwd: root,
		},
	);
}

/**
 * Adds `source`, a real committed local repository, as a submodule of `root` at `at`.
 *
 * `protocol.file.allow=always` overrides modern git's default refusal of a local-path submodule
 * (CVE-2022-39253), safe here since both repositories are fixtures this run built. `--force` adds
 * even a path an ignore pattern matches, since naming a submodule explicitly is the same override
 * an explicit include already gets from the scope reader.
 */
export async function gitSubmoduleAdd(root: string, source: string, at: string): Promise<void> {
	await run("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "--force", source, at], {
		cwd: root,
	});
}

/** Clones `source` into `at` without checking out its submodules, so a gitlink there stays uninitialized. */
export async function gitClone(source: string, at: string): Promise<void> {
	await run("git", ["clone", "-q", "--no-recurse-submodules", source, at]);
}
