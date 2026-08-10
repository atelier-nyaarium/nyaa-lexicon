// Getting a daemon, rather than only noticing there isn't one.
//
// `decideFromLock` has always returned `spawn` with a reason, and nothing acted on it: every client
// checked for `connect` and silently fell back to indexing in its own process. A named decision
// nothing carries out reads as handled and is not.
//
// The daemon is shared and outlives whoever spawned it: its lock claim resolves parallel starts
// (the loser exits before touching the store), and callers ensure one per request, so a client
// that finds the daemon gone simply starts another.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { findDaemon } from "./client.js";
import type { DaemonLock } from "./lockFile.js";
import { lexiconRoot } from "./providers.js";

////////////////////////////////
//  Interfaces & Types

export interface EnsureDaemonOptions {
	workspaceRoot: string;
	/** How long to wait for a spawned daemon to publish its lock. */
	timeoutMs?: number;
	/** Injected so a test never starts a real process. */
	start?: (command: string[]) => void;
	look?: () => ReturnType<typeof findDaemon>;
	wait?: (ms: number) => Promise<void>;
}

export type EnsureResult = { connected: true; lock: DaemonLock } | { connected: false; reason: string };

////////////////////////////////
//  Constants

/** The daemon publishes its lock before its first scan, so this waits on startup, not on indexing. */
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

////////////////////////////////
//  Functions & Helpers

/**
 * Start a daemon that outlives whoever started it.
 *
 * Detached on purpose: the daemon serves every session that finds its lock, so tying its life to
 * the first session killed it under the second. The questions detaching opens - a stale lock, two
 * writers racing on one index - are answered by the daemon's exclusive lock claim, not here.
 */
function startChild(command: string[]): void {
	const [executable, ...args] = command;
	if (executable === undefined) return;

	spawn(executable, args, { stdio: "ignore", detached: true }).unref();
}

/** The bundle, run on the shipping runtime. Absent in a source checkout that was never built. */
export function daemonCommand(workspaceRoot: string, root = lexiconRoot()): string[] | null {
	const bundle = path.join(root, "dist", "daemon.js");
	return existsSync(bundle) ? [process.execPath, bundle, workspaceRoot] : null;
}

/**
 * Connect to the workspace's daemon, starting one if there is none.
 *
 * A `replace` decision is reported rather than acted on: it means the lock names another workspace
 * or an incompatible version, and killing a daemon another session is using is not a call a client
 * gets to make on its own.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureResult> {
	const look = options.look ?? (() => findDaemon(options.workspaceRoot));
	const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const decision = look();
	if (decision.action === "connect") return { connected: true, lock: decision.lock };
	if (decision.action === "replace") return { connected: false, reason: decision.reason };

	const command = daemonCommand(options.workspaceRoot);
	if (command === null) return { connected: false, reason: "no built daemon to start; run the build first" };
	(options.start ?? startChild)(command);

	for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
		await wait(POLL_MS);
		const next = look();
		if (next.action === "connect") return { connected: true, lock: next.lock };
	}
	return { connected: false, reason: `daemon did not publish a lock within ${timeoutMs}ms` };
}
