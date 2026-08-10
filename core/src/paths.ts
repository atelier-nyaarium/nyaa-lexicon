// The SOLE owner of where daemon state lives.
//
// No call site builds a state path. POSIX and Windows disagree on the convention, and a resolver
// per call site is how one of them ends up POSIX-shaped and unnoticed until a Windows consumer
// reports that nothing persists.

import { createHash } from "node:crypto";
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

/**
 * A stable directory name for one workspace.
 *
 * Hashed rather than derived from the path text: a workspace path contains separators, spaces and
 * casing that differ per host, and the basename alone collides the moment two checkouts share a
 * name. The basename is kept as a prefix only so the directory is recognizable by eye.
 */
export function workspaceKey(workspaceRoot: string): string {
	const normalized = path.resolve(workspaceRoot).replace(/\\/g, "/");
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	const name = path.basename(normalized).replace(/[^A-Za-z0-9._-]/g, "-") || "workspace";
	return `${name}-${digest}`;
}

/** Everything one workspace's daemon owns, derived in one place from one root. */
export function workspacePaths(host: PlatformEnv, workspaceRoot: string) {
	const dir = path.join(stateRoot(host), workspaceKey(workspaceRoot));
	return {
		dir,
		/** Where a client finds a running daemon, or learns there is none. */
		lockFile: path.join(dir, "daemon.json"),
		index: path.join(dir, "index.sqlite"),
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
