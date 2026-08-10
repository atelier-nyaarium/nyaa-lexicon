// What the repository's history says about which files belong together.
//
// The one fact class here that comes from neither the parser nor the filesystem.
// `docs/knowledge-layer.md` calls git co-change the strongest non-graph signal, and the reason is
// that the relationships a mature codebase actually has are mostly not structural: inverse
// function pairs, a residue test enforcing an invariant by grep, twins held in sync by a fixture,
// two constants that must never diverge. No graph edge connects any of those, and every one of
// them gets fixed in the same commit.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

////////////////////////////////
//  Interfaces & Types

/** Lines touched in one file by one commit. Both zero for a binary file, which git cannot count. */
export interface FileChange {
	path: string;
	added: number;
	deleted: number;
}

export interface Commit {
	hash: string;
	/** Author time, unix seconds. */
	at: number;
	/** Full message, subject and body. What a search for a symbol name reads. */
	message: string;
	changes: FileChange[];
}

/** A commit whose message names a symbol, which is where a rationale usually is if it is anywhere. */
export interface Mention {
	hash: string;
	at: number;
	/** First line only. A body can be pages, and the subject is what a list wants. */
	subject: string;
	/** Files it touched, so a mention of a common word is judgeable rather than merely present. */
	files: number;
}

/**
 * What history says about one file on its own, as opposed to what it says about a pair.
 *
 * Two of the four things `docs/knowledge-layer.md` asks of this fact class. Churn is lines rather
 * than commits, because a file appearing in forty commits that each moved one line is a different
 * file from one rewritten twice, and a commit count cannot tell them apart.
 */
export interface FileHistory {
	module: string;
	/** Commits touching it, within the window read. */
	commits: number;
	linesAdded: number;
	linesDeleted: number;
	/** Author time of the oldest and newest commit touching it, unix seconds. */
	firstSeen: number | null;
	lastTouched: number | null;
	/**
	 * Whether the oldest commit read also touched this file.
	 *
	 * When true, `firstSeen` is a floor rather than a date: the file was already there, and the
	 * window simply ran out. Reporting an age from a truncated window as if it were the real one is
	 * how a young-looking number gets attached to the oldest file in the repository.
	 */
	truncated: boolean;
}

export interface CoChange {
	module: string;
	/** Commits touching both files. */
	together: number;
	/** Commits touching the queried file at all, so `together` can be read as a proportion. */
	outOf: number;
}

export interface HistoryReport {
	/** Commits actually read. Fewer than asked for is normal in a young repository. */
	commits: number;
	/** Commits ignored for touching too many files, and the threshold that did it. */
	skippedWideCommits: number;
	widthLimit: number;
}

////////////////////////////////
//  Constants

/** How far back to read. Deep enough to be a signal, shallow enough to stay a second. */
export const DEFAULT_DEPTH = 1000;

/**
 * Commits touching more than this are dropped.
 *
 * A formatter run, a licence header sweep or a mass rename touches hundreds of files that have
 * nothing to do with each other, and each one contributes its file count SQUARED in pairs. Left in,
 * they drown every real signal and cost more than all the real commits combined.
 */
export const DEFAULT_WIDTH_LIMIT = 40;

/** Terminates a commit message, which is multi-line and free-form, before the numstat rows. */
const MESSAGE_END = String.fromCharCode(1);

export const DEFAULT_MENTION_LIMIT = 20;

/**
 * Shorter names are not searched at all.
 *
 * A two-character name matches prose constantly, and a list of commits that merely contain the
 * letters is worse than no list, because it reads as evidence.
 */
const MIN_MENTION_LENGTH = 3;

////////////////////////////////
//  Functions & Helpers

/**
 * Commits, what they touched and how much, newest first.
 *
 * Merges are excluded: a merge commit's file list is the union of both sides, so it reports files
 * as changing together when they changed on separate branches for unrelated reasons.
 *
 * Renames are not followed, which makes a rename read as a delete plus an add. Following them would
 * have git rewrite paths inline in the numstat line, and a path that arrives spelled two ways is
 * worse than one that arrives as two facts.
 */
export async function readHistory(workspaceRoot: string, depth = DEFAULT_DEPTH): Promise<Commit[]> {
	// Asked before running git, since git answers a non-repository by writing `fatal:` to our own
	// stderr, which reads as the daemon dying.
	if (!existsSync(path.join(workspaceRoot, ".git"))) return [];

	// The message is free-form and multi-line, so it needs its own terminator before the numstat rows
	// rather than a line count nobody can rely on.
	const { stdout } = await run(
		"git",
		["log", "--no-merges", "--no-renames", "--numstat", `--format=%x00%H %at%n%B${MESSAGE_END}`, `-n${depth}`],
		{ cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024 },
	);

	const commits: Commit[] = [];
	for (const block of stdout.split("\0")) {
		if (block.trim() === "") continue;
		const [head = "", tail = ""] = block.split(MESSAGE_END);

		const newline = head.indexOf("\n");
		const header = newline === -1 ? head : head.slice(0, newline);
		const message = newline === -1 ? "" : head.slice(newline + 1);

		const [hash, at] = header.split(" ");
		if (hash === undefined || hash === "") continue;

		const changes: FileChange[] = [];
		for (const row of tail.split("\n")) {
			// added, deleted, path. A binary file reports both counts as a dash rather than a number.
			const [added, deleted, ...rest] = row.split("\t");
			const path = rest.join("\t");
			if (path === undefined || path === "") continue;
			changes.push({ path, added: countOf(added), deleted: countOf(deleted) });
		}

		commits.push({ hash, at: Number(at ?? 0), message: message.trim(), changes });
	}
	return commits;
}

/**
 * Commits whose message names this symbol, newest first.
 *
 * The fact class `docs/knowledge-layer.md` calls commit messages naming the symbol, and the only
 * tier-1 source of RATIONALE rather than structure. A reference says a symbol is used; a commit
 * message saying "stop caching this, it served a stale token" says why it looks the way it does.
 *
 * Matched on a word boundary, so `add` does not match `address`. Case-sensitive, because a symbol
 * name is, and a case-insensitive match on a short name is mostly prose.
 */
export function commitsMentioning(name: string, commits: Commit[], limit = DEFAULT_MENTION_LIMIT): Mention[] {
	if (name.length < MIN_MENTION_LENGTH) return [];

	const word = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`);
	const found: Mention[] = [];
	for (const commit of commits) {
		if (!word.test(commit.message)) continue;
		found.push({
			hash: commit.hash,
			at: commit.at,
			subject: commit.message.split("\n")[0] ?? "",
			files: commit.changes.length,
		});
		if (found.length >= limit) break;
	}
	return found;
}

function countOf(field: string | undefined): number {
	const value = Number(field);
	return Number.isFinite(value) ? value : 0;
}

/** Paths one commit touched. The shape co-change reads, separate from how much each one moved. */
export function filesOf(commit: Commit): string[] {
	return commit.changes.map((change) => change.path);
}

/**
 * Churn and age for one file.
 *
 * Counted over the same commits co-change reads, so one history read answers all three questions.
 * Sweeps are NOT dropped here: a formatter run genuinely touched this file, and while that tells
 * you nothing about which files belong together it is a real edit to this one.
 */
export function fileHistoryFor(module: string, commits: Commit[]): FileHistory {
	let count = 0;
	let linesAdded = 0;
	let linesDeleted = 0;
	let firstSeen: number | null = null;
	let lastTouched: number | null = null;

	for (const commit of commits) {
		const change = commit.changes.find((entry) => entry.path === module);
		if (change === undefined) continue;

		count++;
		linesAdded += change.added;
		linesDeleted += change.deleted;
		// Newest first, so the last one seen is the oldest.
		lastTouched ??= commit.at;
		firstSeen = commit.at;
	}

	const oldest = commits.at(-1);
	const truncated = oldest !== undefined && oldest.changes.some((entry) => entry.path === module);

	return { module, commits: count, linesAdded, linesDeleted, firstSeen, lastTouched, truncated };
}

/**
 * Files that changed alongside this one, most often first.
 *
 * Counted over commits rather than over pairs, so a file touched in ten commits with another can
 * never score above ten however many times either appears.
 */
export function coChangesFor(
	module: string,
	commits: Commit[],
	widthLimit = DEFAULT_WIDTH_LIMIT,
): { partners: CoChange[]; report: HistoryReport } {
	const together = new Map<string, number>();
	let outOf = 0;
	let skippedWideCommits = 0;

	for (const commit of commits) {
		const files = filesOf(commit);
		if (files.length > widthLimit) {
			skippedWideCommits++;
			continue;
		}
		if (!files.includes(module)) continue;

		outOf++;
		for (const file of files) {
			if (file === module) continue;
			together.set(file, (together.get(file) ?? 0) + 1);
		}
	}

	const partners = [...together.entries()]
		.map(([partner, count]) => ({ module: partner, together: count, outOf }))
		.sort((a, b) => b.together - a.together || a.module.localeCompare(b.module));

	return { partners, report: { commits: commits.length, skippedWideCommits, widthLimit } };
}
