// Whether a newer build than the running one exists on disk, and where.
//
// Two layouts, two signals. A source checkout rebuilds dist/ in place, so the bundle stamp moves
// under the running daemon. A plugin cache installs each version into its own directory named
// exactly that version, so the running root never changes and the news is a newer sibling.

import path from "node:path";
import {
	bundleStamp,
	bundlesSettled,
	daemonCommand,
	INSTALL_SETTLE_MS,
	newerBuild,
	newestInstallBeside,
} from "@nyaa-lexicon/client";
import { type Clock, systemClock } from "./clock.js";

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
	clock?: Clock;
}

////////////////////////////////
//  Functions & Helpers

function settledBefore(options: DriftOptions): number {
	return (options.clock ?? systemClock).now() - (options.settleMs ?? INSTALL_SETTLE_MS);
}

/** Versioned-install layout only: the newest sibling that can actually serve. */
async function newerInstallRoot(options: DriftOptions): Promise<DriftSight | null> {
	// The layout's tell: the root directory is named exactly the running version.
	if (path.basename(options.root) !== options.version) return null;

	const newest = newestInstallBeside(options.root, settledBefore(options));
	if (newest === null || !newerBuild(newest.version, options.version)) return null;
	if ((await daemonCommand(newest.root, options.workspaceRoot)).kind !== "command") return null;
	return { root: newest.root, why: `${newest.version} is installed beside ${options.version}` };
}

/**
 * A newer build to hand over to, or null while this one is current.
 *
 * The sibling scan wins over the stamp: a rebuilt own bundle is the same version, a sibling is a
 * newer one.
 */
export async function driftedTo(options: DriftOptions): Promise<DriftSight | null> {
	const sibling = await newerInstallRoot(options);
	if (sibling !== null) return sibling;

	const now = bundleStamp(options.root);
	if (
		options.stampAtStart !== null &&
		now !== null &&
		now !== options.stampAtStart &&
		bundlesSettled(options.root, settledBefore(options))
	) {
		return { root: options.root, why: "the bundle changed on disk since this daemon started" };
	}
	return null;
}
