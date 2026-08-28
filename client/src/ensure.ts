// Getting a daemon, rather than only noticing there isn't one.
//
// `decideFromLock` has always returned `spawn` with a reason, and nothing acted on it: every client
// checked for `connect` and silently fell back to indexing in its own process. A named decision
// nothing carries out reads as handled and is not.
//
// The daemon is shared and outlives whoever spawned it: its lock claim resolves parallel starts
// (the loser exits before touching the store), and callers ensure one per request, so a client
// that finds the daemon gone simply starts another.

import type { DaemonLock } from "@nyaa-lexicon/protocol";
import {
	callDaemon,
	type DaemonSource,
	daemonCommand,
	findDaemon,
	lockHolderAlive,
	retire,
	type SpawnWatch,
	spawnDaemonProcess,
} from "./discover.js";
import type { LockDecision } from "./lock.js";
import { currentHost, workspacePaths } from "./paths.js";

////////////////////////////////
//  Interfaces & Types

/** The one time seam here. Any clock with a `sleep` fits; a test's never waits on the wall. */
export interface Sleeper {
	sleep(ms: number): Promise<void>;
}

export interface EnsureDaemonOptions {
	workspaceRoot: string;
	/** Where a daemon is spawned from, and what a found lock is judged against. */
	source: DaemonSource;
	/** A store directory of the caller's choosing; the default is derived from the workspace. */
	stateDir?: string;
	/** How long to wait for a spawned daemon to publish its lock. */
	timeoutMs?: number;
	/** Injected so a test never starts a real process. */
	start?: (command: string[]) => SpawnWatch | undefined | void;
	look?: () => LockDecision;
	/** Injected so a test never waits on the wall. */
	clock?: Sleeper;
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

const systemSleeper: Sleeper = {
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

////////////////////////////////
//  Functions & Helpers

/**
 * Connect to the workspace's daemon, starting one if there is none.
 *
 * A daemon serving ANOTHER workspace is reported rather than touched. One serving ours on a dialect
 * we cannot use is retired instead, since every session reaching it is equally stuck.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureResult> {
	const look =
		options.look ?? (() => findDaemon(options.workspaceRoot, options.source, currentHost(), options.stateDir));
	const wait = (ms: number) => (options.clock ?? systemSleeper).sleep(ms);
	const stop = options.stop ?? ((pid) => process.kill(pid, "SIGTERM"));
	const alive = options.alive ?? lockHolderAlive;
	const ask = options.ask ?? ((lock, method) => callDaemon(lock, method, {}));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	/** Looks until the outgoing daemon's lock stops naming it, or the budget ends. */
	async function awaitRelease(): Promise<LockDecision> {
		for (let waited = 0; ; waited += POLL_MS) {
			const next = look();
			if (next.action !== "replace" || waited >= timeoutMs) return next;
			await wait(POLL_MS);
		}
	}

	const decision = look();
	if (decision.action === "connect") return { connected: true, lock: decision.lock };

	if (decision.action === "replace") {
		if (decision.cause === "otherWorkspace") return { connected: false, reason: decision.reason };

		const retired = await retire(decision.lock, {
			ask,
			stop,
			alive,
			released: async () => (await awaitRelease()).action !== "replace",
		});
		if (!retired.retired) return { connected: false, reason: `${decision.reason}, and ${retired.reason}` };

		// Its lock goes on the way out, so the wait below is for OUR daemon rather than a race against
		// the corpse of the one just stopped.
		const next = await awaitRelease();
		// Someone else already replaced it with a daemon we can use.
		if (next.action === "connect") return { connected: true, lock: next.lock };
		// Spawning over an unreleased lock hands the newcomer a claim it must lose, then reports
		// the resulting confusion as ours. Refusing names the actual holdout.
		if (next.action === "replace") {
			return {
				connected: false,
				reason: `pid ${decision.lock.pid} was asked to stop but still holds the lock after ${timeoutMs}ms`,
			};
		}
	}

	const command = daemonCommand(options.source.root, options.workspaceRoot, options.stateDir);
	if (command === null) return { connected: false, reason: "no built daemon to start; run the build first" };
	const logFile = workspacePaths(currentHost(), options.workspaceRoot, options.stateDir).logFile;
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
