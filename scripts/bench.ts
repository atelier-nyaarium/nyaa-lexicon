// Times cold indexing through built dist/.
// Default input: Lexicon's source at HEAD, checked out apart, so every sample reads the same bytes.
//
//   bun run bench                       # the working tree's build
//   bun run bench --against <ref>       # and <ref>'s; fails on a slowdown past 20% or fewer files
//   bun run bench --repo <dir> --runs 3

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

interface Sample {
	ms: number;
	files: number;
	symbols: number;
}

interface Side {
	label: string;
	checkout: string;
}

////////////////////////////////
//  Constants

const ROOT = path.join(import.meta.dirname, "..");
const DIST_DIR = "dist";
const THRESHOLD = 0.2;
const RESULT_LINE = /^(\d+) files, (\d+) symbols, (\d+)ms$/m;

////////////////////////////////
//  Functions & Helpers

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Cleanup keeps going past one failed step. */
function tryGit(cwd: string, args: string[]): void {
	try {
		git(cwd, args);
	} catch (error) {
		console.error(`cleanup: git ${args.join(" ")} in ${cwd}: ${error instanceof Error ? error.message : error}`);
	}
}

function run(cwd: string, command: string, args: string[]): void {
	execFileSync(command, args, { cwd, stdio: "inherit" });
}

function option(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at === -1 ? undefined : argv[at + 1];
}

function sample(checkout: string, input: string): Sample {
	const output = execFileSync("bun", [path.join(checkout, DIST_DIR, "index-workspace.js"), input], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	const match = RESULT_LINE.exec(output);
	if (match === null) throw new Error(`no result line from ${checkout}'s index:\n${output.slice(-2000)}`);
	return { files: Number(match[1]), symbols: Number(match[2]), ms: Number(match[3]) };
}

/** Even runs favor faster. */
function median(samples: Sample[]): Sample {
	return [...samples].sort((a, b) => a.ms - b.ms)[Math.floor((samples.length - 1) / 2)]!;
}

/** Alternates samples and restores each `dist/`. */
function measure(sides: Side[], input: string, runs: number): Sample[] {
	try {
		for (const side of sides) run(side.checkout, "bun", ["run", "build", "--build-only"]);
		const samples = sides.map((): Sample[] => []);
		for (let round = 0; round < runs; round++) {
			const order = sides.map((_, at) => at);
			if (round % 2 === 1) order.reverse();
			for (const at of order) samples[at]!.push(sample(sides[at]!.checkout, input));
		}
		return samples.map(median);
	} finally {
		for (const side of sides) {
			tryGit(side.checkout, ["checkout", "HEAD", "--", DIST_DIR]);
			tryGit(side.checkout, ["clean", "-fdq", "--", DIST_DIR]);
		}
	}
}

function describe(label: string, at: Sample): string {
	return `${label}: ${(at.ms / 1000).toFixed(1)} s, ${at.files} files, ${at.symbols} symbols`;
}

/** Detached worktree, always removed. */
function withWorktree<T>(ref: string, use: (dir: string) => T): T {
	const dir = mkdtempSync(path.join(tmpdir(), "lexicon-bench-"));
	let added = false;
	try {
		git(ROOT, ["worktree", "add", "--quiet", "--detach", dir, ref]);
		added = true;
		return use(dir);
	} finally {
		if (added) tryGit(ROOT, ["worktree", "remove", "--force", dir]);
		rmSync(dir, { recursive: true, force: true });
		tryGit(ROOT, ["worktree", "prune"]);
	}
}

////////////////////////////////
//  Main

function main(argv: string[]): void {
	// Ctrl-C stops the child; the parent lives on to clean up.
	process.on("SIGINT", () => {});
	const against = option(argv, "--against");
	const repo = option(argv, "--repo");
	const runs = Number(option(argv, "--runs") ?? "1");
	const current: Side = { label: "working tree", checkout: ROOT };

	const bench = (input: string): string | null => {
		if (against === undefined) {
			const [alone] = measure([current], input, runs);
			console.log(`\n${describe(current.label, alone!)}`);
			return null;
		}
		return withWorktree(against, (tree) => {
			run(tree, "bun", ["install", "--frozen-lockfile"]);
			const [now, base] = measure([current, { label: against, checkout: tree }], input, runs);
			const ratio = now!.ms / base!.ms;
			console.log(`\n${describe(current.label, now!)}\n${describe(against, base!)}`);
			console.log(`ratio ${ratio.toFixed(2)}, threshold ${(1 + THRESHOLD).toFixed(2)}`);
			if (now!.files < base!.files) return `indexed ${now!.files} files where ${against} indexed ${base!.files}`;
			return ratio <= 1 + THRESHOLD ? null : "slower than the threshold allows";
		});
	};

	const failure = repo === undefined ? withWorktree("HEAD", bench) : bench(path.resolve(repo));
	if (failure !== null) {
		console.error(`\nbench FAILED: ${failure}`);
		process.exit(1);
	}
}

if (import.meta.main) main(process.argv.slice(2));
