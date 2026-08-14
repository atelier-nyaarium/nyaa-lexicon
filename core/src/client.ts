// The thin client's half: find a daemon, or learn what to do instead.
//
// Every consumer goes through here, so the connect-replace-spawn rules live in one place rather
// than being reimplemented slightly differently by the MCP adapter and the editor adapter.

import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { bundleStamp } from "./ensureDaemon.js";
import type { DaemonLock, LockDecision } from "./lockFile.js";
import { decideFromLock } from "./lockFile.js";
import { currentHost, type PlatformEnv, workspacePaths } from "./paths.js";
import { requestOnce } from "./socketTransport.js";
import { BUILD_VERSION } from "./version.js";

////////////////////////////////
//  Functions & Helpers

/** True when a signal-zero probe reaches the process, which is how liveness is asked on POSIX. */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to someone else, which still counts as alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Reads the lock file and applies the rules. Absent and unreadable are both "no daemon". */
export function findDaemon(workspaceRoot: string, host: PlatformEnv = currentHost()): LockDecision {
	const paths = workspacePaths(host, workspaceRoot);
	let raw: string | null;
	try {
		raw = readFileSync(paths.lockFile, "utf8");
	} catch {
		raw = null;
	}

	return decideFromLock({
		raw,
		isAlive: processIsAlive,
		ourProtocolVersion: PROTOCOL_VERSION,
		ourBuildVersion: BUILD_VERSION,
		ourBundleStamp: bundleStamp(),
		workspaceRoot,
	});
}

////////////////////////////////
//  Calling

/**
 * One query against a running daemon: connect, authenticate, ask, close.
 *
 * For callers that ask one question and exit. A session that asks many questions holds a
 * persistent connection instead (`connectFrames`), because the open connection is what tells the
 * daemon the session exists.
 */
export async function callDaemon(lock: DaemonLock, method: string, params?: unknown): Promise<unknown> {
	return requestOnce(lock.port, lock.token, method, params);
}
