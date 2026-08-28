// The SOLE owner of where daemon state lives.
//
// No call site builds a state path. POSIX and Windows disagree on the convention, and a resolver
// per call site is how one of them ends up POSIX-shaped and unnoticed until a Windows consumer
// reports that nothing persists.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** Injected so the resolver is testable for a platform the test is not running on. */
export interface PlatformEnv {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	home: string;
}

////////////////////////////////
//  Constants

const APP_DIR = "nyaa-lexicon";

////////////////////////////////
//  Functions & Helpers

/** `%LOCALAPPDATA%` on Windows, `XDG_STATE_HOME` elsewhere, each with its documented fallback. */
export function stateRoot(host: PlatformEnv): string {
	if (host.platform === "win32") {
		const local = host.env["LOCALAPPDATA"];
		const base = local && local !== "" ? local : path.join(host.home, "AppData", "Local");
		return path.join(base, APP_DIR);
	}

	const xdg = host.env["XDG_STATE_HOME"];
	const base = xdg && xdg !== "" ? xdg : path.join(host.home, ".local", "state");
	return path.join(base, APP_DIR);
}

/** The one path a workspace has on disk: symlinks followed, case as the filesystem reports it, never folded. */
export function canonicalRoot(workspaceRoot: string): string {
	const resolved = path.resolve(workspaceRoot);
	try {
		return realpathSync.native(resolved);
	} catch (error) {
		// A root that does not exist yet resolves textually; any other failure is the caller's to see.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return resolved;
		throw error;
	}
}

/**
 * A stable directory name for one workspace.
 *
 * Hashed rather than derived from the path text: a workspace path contains separators, spaces and
 * casing that differ per host, and the basename alone collides the moment two checkouts share a
 * name. The basename is kept as a prefix only so the directory is recognizable by eye.
 */
export function workspaceKey(workspaceRoot: string): string {
	const normalized = canonicalRoot(workspaceRoot).replace(/\\/g, "/");
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	const name = path.basename(normalized).replace(/[^A-Za-z0-9._-]/g, "-") || "workspace";
	return `${name}-${digest}`;
}

/** Everything one workspace's daemon owns, derived in one place from one root. A custom directory
 * IS the store's identity: two workspaces given one directory share one store. */
export function workspacePaths(host: PlatformEnv, workspaceRoot: string, stateDir?: string) {
	return storePaths(stateDir ?? path.join(stateRoot(host), workspaceKey(workspaceRoot)));
}

/** The same paths from a store's directory, for a reader holding the directory and not the root. */
export function storePaths(directory: string) {
	return {
		dir: directory,
		/** Where a client finds a running daemon, or learns there is none. */
		lockFile: path.join(directory, "daemon.json"),
		index: path.join(directory, "index.sqlite"),
		/** The daemon's own words. It runs detached, so this is the only place they land. */
		logFile: path.join(directory, "daemon.log"),
		/** The bounded memory collection. Rewritten whole, never appended. */
		diagnosticsFile: path.join(directory, "diagnostics.json"),
		/** Crash reports and the daemon's high-water report, pruned to a few. */
		reportsDir: path.join(directory, "reports"),
	};
}

/** The live host, for production call sites. */
export function currentHost(): PlatformEnv {
	return {
		platform: process.platform,
		env: process.env,
		home: process.env["HOME"] ?? process.env["USERPROFILE"] ?? process.cwd(),
	};
}
