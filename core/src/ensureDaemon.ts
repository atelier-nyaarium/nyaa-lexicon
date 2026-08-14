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
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { callDaemon, findDaemon } from "./client.js";
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
	/** Injected so a test never signals a real process. */
	stop?: (pid: number) => void;
	/** Asks the outgoing daemon whether anything is in flight. Injected for the same reason. */
	ask?: (lock: DaemonLock, method: string) => Promise<unknown>;
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
 * Which bundle a daemon is running, closely enough to notice a rebuild.
 *
 * The version alone is not enough, and that gap has already cost a false verification here: a
 * developer rebuilds twenty times at one version, and every rebuild leaves a daemon serving the
 * previous code while the lock still says the version matches. Size and modification time change on
 * every build and cost one stat, where hashing four megabytes on every lookup would not.
 *
 * Null when the bundle cannot be read, which is a source checkout that was never built. Absent on
 * both sides compares equal, so nothing here breaks a workspace with no bundle at all.
 */
export function bundleStamp(root = lexiconRoot()): string | null {
	try {
		const found = statSync(path.join(root, "dist", "daemon.js"));
		return `${found.size}:${Math.trunc(found.mtimeMs)}`;
	} catch {
		return null;
	}
}

/**
 * Retire a daemon that cannot serve us, but only on positive evidence that nothing is in flight.
 *
 * The gate is one question, asked of the outgoing daemon: is a refactor transaction open? That
 * transaction holds the only copy of the images its undo would restore, and killing the process
 * loses them, which is the single thing the journal exists to prevent.
 *
 * Anything other than a clear "no" leaves it running. A daemon too old to answer, or wedged and not
 * answering at all, is exactly the daemon whose state we cannot reason about, so an unclear answer
 * must not read as consent. The manual path through stop_project_daemon stays for those.
 */
async function retire(
	lock: DaemonLock,
	ask: (lock: DaemonLock, method: string) => Promise<unknown>,
	stop: (pid: number) => void,
): Promise<{ retired: true } | { retired: false; reason: string }> {
	let status: unknown;
	try {
		status = await ask(lock, "refactorStatus");
	} catch (error) {
		return { retired: false, reason: `it would not say whether a refactor is open: ${errorText(error)}` };
	}

	const open = (status as { open?: unknown } | null)?.open;
	if (open !== false) {
		return {
			retired: false,
			reason:
				open === true ? "a refactor transaction is open on it" : "it did not answer whether a refactor is open",
		};
	}

	try {
		stop(lock.pid);
	} catch (error) {
		return { retired: false, reason: `pid ${lock.pid} could not be stopped: ${errorText(error)}` };
	}
	return { retired: true };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Connect to the workspace's daemon, starting one if there is none.
 *
 * A daemon serving ANOTHER workspace is reported rather than touched: it is answering correctly for
 * somebody else, and stopping it is not a call a client gets to make. One serving OUR workspace on a
 * dialect we cannot use is different. Every session reaching it is as stuck as we are, so retiring
 * it serves them rather than harming them, and their channels reconnect to the replacement on the
 * connection loss they already handle.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureResult> {
	const look = options.look ?? (() => findDaemon(options.workspaceRoot));
	const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const stop = options.stop ?? ((pid) => process.kill(pid, "SIGTERM"));
	const ask = options.ask ?? ((lock, method) => callDaemon(lock, method, {}));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const decision = look();
	if (decision.action === "connect") return { connected: true, lock: decision.lock };

	if (decision.action === "replace") {
		if (decision.cause === "otherWorkspace") return { connected: false, reason: decision.reason };

		const retired = await retire(decision.lock, ask, stop);
		if (!retired.retired) return { connected: false, reason: `${decision.reason}, and ${retired.reason}` };

		// Its lock goes on the way out, so the wait below is for OUR daemon rather than a race against
		// the corpse of the one just stopped.
		for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
			if (look().action === "spawn") break;
			await wait(POLL_MS);
		}
	}

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
