// The one owner of "build dist/, use it, put the committed dist/ back". The release build commits
// its dist/ instead, so it keeps its own rollback.

import { git, gitOrNull, run } from "./child";

////////////////////////////////
//  Constants

export const DIST_DIR = "dist";

////////////////////////////////
//  Functions & Helpers

/** Restore tracked output; clear generated files. */
export function restoreDist(checkout: string): void {
	if ((gitOrNull(checkout, ["ls-tree", "HEAD", "--", DIST_DIR]) ?? "") !== "") {
		git(checkout, ["checkout", "HEAD", "--", DIST_DIR]);
	}
	git(checkout, ["clean", "-fdqx", "--", DIST_DIR]);
}

/**
 * Builds each checkout's dist/, runs `use`, and restores every checkout it built. A dist/ that
 * differs from HEAD is refused first, since restoring would discard it.
 */
export function withBuiltDist<T>(checkouts: string[], use: () => T): T {
	const dirty = checkouts.filter((checkout) => git(checkout, ["status", "--porcelain", "--ignored", "--", DIST_DIR]));
	if (dirty.length > 0) {
		throw new Error(
			`${DIST_DIR}/ differs from HEAD in ${dirty.join(", ")}; it is build output, so restore it (git checkout HEAD -- ${DIST_DIR} && git clean -fdx -- ${DIST_DIR}) or commit it`,
		);
	}
	const touched: string[] = [];
	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		for (const checkout of checkouts) {
			touched.push(checkout);
			// Keep build logs off caller stdout.
			run(checkout, "bun", ["run", "build", "--build-only"], "stderr");
		}
		outcome = { ok: true, value: use() };
	} catch (error) {
		outcome = { ok: false, error };
	}
	const unrestored: string[] = [];
	for (const checkout of touched) {
		try {
			restoreDist(checkout);
		} catch (error) {
			unrestored.push(`${checkout}/${DIST_DIR}: ${error instanceof Error ? error.message : error}`);
		}
	}
	if (unrestored.length > 0) console.error(`could not restore:\n  ${unrestored.join("\n  ")}`);
	// A failed build or use keeps its own error.
	if (!outcome.ok) throw outcome.error;
	if (unrestored.length > 0) throw new Error(`could not restore ${unrestored.length} ${DIST_DIR}/`);
	return outcome.value;
}
