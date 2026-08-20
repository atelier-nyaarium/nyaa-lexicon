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
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { callDaemon, findDaemon, lockHolderAlive } from "./client.js";
import type { DaemonLock } from "./lockFile.js";
import { currentHost, workspacePaths } from "./paths.js";
import { lexiconRoot } from "./providers.js";

////////////////////////////////
//  Interfaces & Types

/** How the spawned daemon died, if it has. The lock-wait reads this so "did not publish a lock"
 * can say "exited with code 3" instead (issue #7 was undiagnosable without it). */
export interface SpawnWatch {
	death: () => string | null;
}

export interface EnsureDaemonOptions {
	workspaceRoot: string;
	/** How long to wait for a spawned daemon to publish its lock. */
	timeoutMs?: number;
	/** Injected so a test never starts a real process. */
	start?: (command: string[]) => SpawnWatch | undefined | void;
	look?: () => ReturnType<typeof findDaemon>;
	wait?: (ms: number) => Promise<void>;
	/** Injected so a test never signals a real process. */
	stop?: (pid: number) => void;
	/** Whether the lock's holder still lives as itself. Injected for the same reason. */
	alive?: (holder: { pid: number; pidStart?: string | undefined }) => boolean;
	/** Asks the outgoing daemon whether anything is in flight. Injected for the same reason. */
	ask?: (lock: DaemonLock, method: string) => Promise<unknown>;
}

export type EnsureResult = { connected: true; lock: DaemonLock } | { connected: false; reason: string };

////////////////////////////////
//  Constants

/** The daemon publishes its lock before its first scan, so this waits on startup, not on indexing. */
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

/** Rotated once past this, keeping one predecessor. Enough for weeks of a healthy daemon. */
const LOG_ROTATE_BYTES = 1024 * 1024;

////////////////////////////////
//  Functions & Helpers

/** One log per workspace, capped by rotation, or null when it cannot be opened. */
function openLog(logFile: string): number | null {
	try {
		mkdirSync(path.dirname(logFile), { recursive: true });
		if (statSync(logFile).size > LOG_ROTATE_BYTES) {
			rmSync(`${logFile}.old`, { force: true });
			renameSync(logFile, `${logFile}.old`);
		}
	} catch {
		// Absent log or failed rotation both mean: append to whatever opens.
	}
	try {
		return openSync(logFile, "a");
	} catch {
		return null;
	}
}

/**
 * Start a daemon that outlives whoever started it.
 *
 * Detached on purpose: the daemon serves every session that finds its lock, so tying its life to
 * the first session killed it under the second. The questions detaching opens - a stale lock, two
 * writers racing on one index - are answered by the daemon's exclusive lock claim, not here.
 *
 * Its stdio lands in the workspace's daemon.log, so a crash has a record instead of a mute
 * lock-wait timeout. The child handle is watched, never awaited, so its death during our wait is
 * reportable while its life stays its own.
 */
export function spawnDaemonProcess(command: string[], logFile: string): SpawnWatch | undefined {
	const [executable, ...args] = command;
	if (executable === undefined) return undefined;

	const log = openLog(logFile);
	const child = spawn(executable, args, {
		stdio: ["ignore", log ?? "ignore", log ?? "ignore"],
		detached: true,
	});
	if (log !== null) closeSync(log);

	let death: string | null = null;
	child.once("exit", (code, signal) => {
		death = signal !== null ? `died on ${signal}` : `exited with code ${code}`;
	});
	child.once("error", (error) => {
		death = `could not start: ${error.message}`;
	});
	child.unref();
	return { death: () => death };
}

/** The bundle, run on the shipping runtime. Absent in a source checkout that was never built. */
export function daemonCommand(workspaceRoot: string, root = lexiconRoot()): string[] | null {
	const bundle = path.join(root, "dist", "daemon.js");
	try {
		// A directory or dangling symlink wearing the name is not a program.
		return statSync(bundle).isFile() ? [process.execPath, bundle, workspaceRoot] : null;
	} catch {
		return null;
	}
}

/**
 * Which bundle a daemon is running, closely enough to notice a rebuild.
 *
 * The version moves once a release; a rebuild inside one leaves a daemon serving older code. Size
 * and mtime cost one stat, where hashing the bundle on every lookup would not. Null when unbuilt.
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
 * An open transaction holds the only copy of the images its undo would restore. Anything but a
 * clear no leaves it running, since an unclear answer must never read as consent.
 */
async function retire(
	lock: DaemonLock,
	ask: (lock: DaemonLock, method: string) => Promise<unknown>,
	stop: (pid: number) => void,
	alive: (holder: { pid: number; pidStart?: string | undefined }) => boolean,
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

	// Re-judged at the last moment: the pid may have been reused since the lock was read, and a
	// signal sent on the old number lands on whoever wears it now.
	if (!alive(lock)) return { retired: true };
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
 * A daemon serving ANOTHER workspace is reported rather than touched. One serving ours on a dialect
 * we cannot use is retired instead, since every session reaching it is equally stuck.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureResult> {
	const look = options.look ?? (() => findDaemon(options.workspaceRoot));
	const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const stop = options.stop ?? ((pid) => process.kill(pid, "SIGTERM"));
	const alive = options.alive ?? lockHolderAlive;
	const ask = options.ask ?? ((lock, method) => callDaemon(lock, method, {}));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const decision = look();
	if (decision.action === "connect") return { connected: true, lock: decision.lock };

	if (decision.action === "replace") {
		if (decision.cause === "otherWorkspace") return { connected: false, reason: decision.reason };

		const retired = await retire(decision.lock, ask, stop, alive);
		if (!retired.retired) return { connected: false, reason: `${decision.reason}, and ${retired.reason}` };

		// Its lock goes on the way out, so the wait below is for OUR daemon rather than a race against
		// the corpse of the one just stopped.
		let released = false;
		for (let waited = 0; waited < timeoutMs && !released; waited += POLL_MS) {
			const next = look();
			// Someone else already replaced it with a daemon we can use.
			if (next.action === "connect") return { connected: true, lock: next.lock };
			released = next.action === "spawn";
			if (!released) await wait(POLL_MS);
		}
		// Spawning over an unreleased lock hands the newcomer a claim it must lose, then reports
		// the resulting confusion as ours. Refusing names the actual holdout.
		if (!released) {
			return {
				connected: false,
				reason: `pid ${decision.lock.pid} was asked to stop but still holds the lock after ${timeoutMs}ms`,
			};
		}
	}

	const command = daemonCommand(options.workspaceRoot);
	if (command === null) return { connected: false, reason: "no built daemon to start; run the build first" };
	const logFile = workspacePaths(currentHost(), options.workspaceRoot).logFile;
	const watch = (options.start ?? ((argv) => spawnDaemonProcess(argv, logFile)))(command);

	for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
		await wait(POLL_MS);
		const next = look();
		if (next.action === "connect") return { connected: true, lock: next.lock };
		const death = watch?.death() ?? null;
		if (death !== null) {
			return { connected: false, reason: `the daemon ${death} during startup; its log is ${logFile}` };
		}
	}
	return { connected: false, reason: `daemon did not publish a lock within ${timeoutMs}ms; its log is ${logFile}` };
}
