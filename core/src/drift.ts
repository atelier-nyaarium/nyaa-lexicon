// Whether a newer build than the running one exists on disk, and where.
//
// Two layouts, two signals. A source checkout rebuilds dist/ in place, so the bundle stamp moves
// under the running daemon. A plugin cache installs each version into its own directory named
// exactly that version, so the running root never changes and the news is a newer sibling.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { bundleStamp, daemonCommand } from "./ensureDaemon.js";
import { newerBuild } from "./lockFile.js";

////////////////////////////////
//  Interfaces & Types

export interface DriftSight {
	/** The lexicon root to hand over to. */
	root: string;
	why: string;
}

export interface DriftOptions {
	workspaceRoot: string;
	/** The running build's root and version. */
	root: string;
	version: string;
	/** The bundle stamp recorded at start, or null when there was none to record. */
	stampAtStart: string | null;
	/** How long a bundle must sit unmodified before it counts. Injected so tests decide. */
	settleMs?: number;
}

////////////////////////////////
//  Constants

/** A bundle younger than this may still be mid-write; handing over to it spawns half a program. */
const DEFAULT_SETTLE_MS = 3_000;

////////////////////////////////
//  Functions & Helpers

function settled(bundle: string, settleMs: number): boolean {
	try {
		return Date.now() - statSync(bundle).mtimeMs >= settleMs;
	} catch {
		return false;
	}
}

/** The version a root's own manifest claims, or null when it does not say. */
function manifestVersion(root: string): string | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
		const version = (parsed as { version?: unknown }).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

/** Versioned-install layout only: the newest sibling that can actually serve. */
function newerInstallRoot(options: DriftOptions): DriftSight | null {
	// The layout's tell: the root directory is named exactly the running version.
	if (path.basename(options.root) !== options.version) return null;
	const parent = path.dirname(options.root);
	const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return null;
	}

	let best: { root: string; version: string } | null = null;
	for (const entry of entries) {
		if (!newerBuild(entry, best?.version ?? options.version)) continue;
		const sibling = path.join(parent, entry);
		// Only a root with a runnable, settled bundle is a target.
		if (daemonCommand(options.workspaceRoot, sibling) === null) continue;
		if (!settled(path.join(sibling, "dist", "daemon.js"), settleMs)) continue;
		// The manifest must agree with the directory name. A bundle compiled as some OTHER version
		// writes that version into its lock, which clients then replace, which respawns the daemon
		// that hands over here again: a loop, cut by refusing the mismatched install.
		if (manifestVersion(sibling) !== entry) continue;
		best = { root: sibling, version: entry };
	}
	return best === null ? null : { root: best.root, why: `${best.version} is installed beside ${options.version}` };
}

/**
 * A newer build to hand over to, or null while this one is current.
 *
 * The sibling scan wins over the stamp: a rebuilt own bundle is the same version, a sibling is a
 * newer one.
 */
export function driftedTo(options: DriftOptions): DriftSight | null {
	const sibling = newerInstallRoot(options);
	if (sibling !== null) return sibling;

	const now = bundleStamp(options.root);
	if (
		options.stampAtStart !== null &&
		now !== null &&
		now !== options.stampAtStart &&
		settled(path.join(options.root, "dist", "daemon.js"), options.settleMs ?? DEFAULT_SETTLE_MS)
	) {
		return { root: options.root, why: "the bundle changed on disk since this daemon started" };
	}
	return null;
}
