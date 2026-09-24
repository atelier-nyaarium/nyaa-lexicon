// Getting a daemon, rather than only noticing there isn't one: every `decideFromLock` verdict is
// carried out here, so no client falls back to indexing in its own process.
//
// The daemon is shared and outlives whoever spawned it: its lock claim resolves parallel starts
// (the loser exits before touching the store), and callers ensure one per request, so a client
// that finds the daemon gone simply starts another.

import { type DaemonLock, defined } from "@nyaa-lexicon/protocol";
import { unlessAborted } from "./deadline.js";
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
import { DaemonError, NotInstalled } from "./errors.js";
import type { LockDecision } from "./lock.js";
import { currentHost, workspacePaths } from "./paths.js";
import { runtimeProblem } from "./runtime.js";
import { notifyWaiting } from "./transport.js";

////////////////////////////////
//  Interfaces & Types

/** The one time seam here. Any clock with a `sleep` fits; a test's never waits on the wall. */
export interface Sleeper {
	sleep(ms: number): Promise<void>;
}

/**
 * Where a daemon is spawned from and what a found lock is judged against, or why no install is
 * known. With none, a daemon serving this client is ridden and none is spawned or retired.
 */
export type InstallSource = DaemonSource | NotInstalled | (() => DaemonSource | NotInstalled);

export interface EnsureDaemonOptions {
	workspaceRoot: string;
	source: InstallSource;
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
	onWaiting?: Parameters<typeof notifyWaiting>[0];
	/** Whether the lock's holder still lives as itself. Injected for the same reason. */
	alive?: (holder: { pid: number; pidStart?: string | undefined }) => boolean;
	/** Asks the outgoing daemon whether anything is in flight. Injected for the same reason. */
	ask?: (lock: DaemonLock, method: string) => Promise<unknown>;
	/** The caller's own bun, for daemons it spawns. */
	bundledBun?: string;
	/** Attach never retires, waits or spawns; unusable locks yield `notRunning`. */
	mode?: EnsureMode;
	/** Abort with the signal's reason; no later ask, signal or spawn occurs. */
	signal?: AbortSignal;
}

export type EnsureMode = "attach" | "start";

export type EnsureReason =
	| "otherWorkspace"
	| "notRunning"
	| "noBunRuntime"
	| "unbuilt"
	| "spawnFailed"
	| "timeout"
	| "notInstalled";
export type EnsureResult =
	| { connected: true; lock: DaemonLock }
	| { connected: false; reason: Exclude<EnsureReason, "notInstalled">; detail: string }
	| { connected: false; reason: "notInstalled"; detail: string; root: string | undefined };

/**
 * The one reading of a refusal as a session error: no install and nothing live to ride is
 * `NotInstalled`, no daemon to start is `spawnFailed`, and an empty attach is
 * `notRunning`; other failures remain daemon errors.
 */
export function ensureFailure(
	result: Extract<EnsureResult, { connected: false }>,
	context = "",
): DaemonError | NotInstalled {
	if (result.reason === "notInstalled") return new NotInstalled(`${context}${result.detail}`, result.root);
	if (result.reason === "notRunning") return new DaemonError(`${context}${result.detail}`, "notRunning");
	const spawn = result.reason === "spawnFailed" || result.reason === "unbuilt" || result.reason === "noBunRuntime";
	return new DaemonError(`${context}${result.detail}`, spawn ? "spawnFailed" : "daemon");
}

function attached(decision: LockDecision): EnsureResult {
	if (decision.action === "connect") return { connected: true, lock: decision.lock };
	if (decision.action === "replace" && decision.cause === "otherWorkspace")
		return { connected: false, reason: "otherWorkspace", detail: decision.reason };
	return { connected: false, reason: "notRunning", detail: decision.reason };
}

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
 * we cannot use is retired instead, since every session reaching it is equally stuck. With no
 * install known, a daemon serving this client is ridden and anything else is `notInstalled`.
 *
 * Abort stops later work; sent shutdowns and spawned daemons cannot be recalled.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureResult> {
	const { signal } = options;
	signal?.throwIfAborted();
	// Once per invocation: the install is judged here and held; every poll below re-reads the LOCK.
	const install = typeof options.source === "function" ? options.source() : options.source;
	const known = install instanceof NotInstalled ? null : install;
	const look = options.look ?? (() => findDaemon(options.workspaceRoot, known, currentHost(), options.stateDir));
	if (options.mode === "attach") return attached(look());

	const wait = (ms: number) => unlessAborted((options.clock ?? systemSleeper).sleep(ms), signal);
	const stop = options.stop ?? ((pid) => process.kill(pid, "SIGTERM"));
	const alive = options.alive ?? lockHolderAlive;
	// The daemon being retired is behind this major by definition, so the retirement conversation accepts it.
	const ask =
		options.ask ?? ((lock, method) => callDaemon(lock, method, {}, { acceptOlder: true, ...defined({ signal }) }));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const startedAt = Date.now();
	// One shared budget: an ask spent inside `retire` and every poll below all draw against it, so
	// a slow ask leaves the poll less time rather than each getting a fresh `timeoutMs`.
	const deadline = startedAt + timeoutMs;
	let waitingNotified = false;

	/** Looks until the outgoing daemon's lock stops naming it, or the shared deadline passes. */
	async function awaitRelease(): Promise<LockDecision> {
		for (;;) {
			const next = look();
			if (next.action !== "replace" || Date.now() >= deadline) return next;
			await wait(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
		}
	}

	/** Looks until a delete in flight clears, or the elapsed budget ends; nothing is asked or signalled. */
	async function awaitDeleteClear(): Promise<LockDecision> {
		let elapsed = 0;
		for (;;) {
			const next = look();
			if (next.action !== "awaitDelete" || elapsed >= timeoutMs) return next;
			const step = Math.min(POLL_MS, timeoutMs - elapsed);
			await wait(step);
			elapsed += step;
		}
	}

	let decision = look();
	if (decision.action === "awaitDelete") decision = await awaitDeleteClear();

	if (decision.action === "connect") return { connected: true, lock: decision.lock };

	if (decision.action === "awaitDelete") {
		return {
			connected: false,
			reason: "timeout",
			detail: `${decision.reason}, and it still holds the lock after ${timeoutMs}ms`,
		};
	}

	// No install means no build to spawn or to put in a retired daemon's place, so only riding is left.
	if (install instanceof NotInstalled) {
		if (decision.action === "replace" && decision.cause === "otherWorkspace")
			return { connected: false, reason: "otherWorkspace", detail: decision.reason };
		return {
			connected: false,
			reason: "notInstalled",
			detail: `${install.message}, and ${decision.reason}`,
			root: install.root,
		};
	}

	if (decision.action === "replace") {
		if (decision.cause === "otherWorkspace")
			return { connected: false, reason: "otherWorkspace", detail: decision.reason };

		const retired = await retire(decision.lock, {
			ask,
			stop,
			alive,
			released: async () => (await awaitRelease()).action !== "replace",
			deadline,
			sleep: wait,
			...defined({ signal }),
		});
		if (!retired.retired) {
			return {
				connected: false,
				reason: retired.cause === "timeout" ? "timeout" : "spawnFailed",
				detail: `${decision.reason}, and ${retired.reason}`,
			};
		}

		// Its lock goes on the way out, so the wait below is for OUR daemon rather than a race against
		// the corpse of the one just stopped.
		let next = await awaitRelease();
		// A delete may have claimed the slot while we waited; that is never a daemon to spawn over.
		if (next.action === "awaitDelete") next = await awaitDeleteClear();
		// Someone else already replaced it with a daemon we can use.
		if (next.action === "connect") return { connected: true, lock: next.lock };
		if (next.action === "awaitDelete") {
			return {
				connected: false,
				reason: "timeout",
				detail: `${next.reason}, and it still holds the lock after ${timeoutMs}ms`,
			};
		}
		// Spawning over an unreleased lock hands the newcomer a claim it must lose, then reports
		// the resulting confusion as ours. Refusing names the actual holdout.
		if (next.action === "replace") {
			return {
				connected: false,
				reason: "timeout",
				detail: `pid ${decision.lock.pid} was asked to stop but still holds the lock after ${timeoutMs}ms`,
			};
		}
	}

	const command = await unlessAborted(
		daemonCommand(install.root, options.workspaceRoot, options.stateDir, currentHost(), options.bundledBun),
		signal,
	);
	if (command.kind === "unbuilt")
		return { connected: false, reason: "unbuilt", detail: "no built daemon to start; run the build first" };
	if (command.kind === "noBunRuntime")
		return { connected: false, reason: "noBunRuntime", detail: runtimeProblem(command.runtime) };
	const logFile = workspacePaths(currentHost(), options.workspaceRoot, options.stateDir).logFile;
	signal?.throwIfAborted();
	const watch = (options.start ?? ((argv) => spawnDaemonProcess(argv, logFile)))(command.command);

	for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
		if (!waitingNotified) {
			waitingNotified = true;
			notifyWaiting(options.onWaiting, {
				waitingFor: "daemon startup",
				retryInMs: POLL_MS,
				elapsedMs: Date.now() - startedAt,
			});
		}
		await wait(POLL_MS);
		const next = look();
		if (next.action === "connect") return { connected: true, lock: next.lock };
		const death = watch?.death() ?? null;
		if (death !== null) {
			return {
				connected: false,
				reason: "spawnFailed",
				detail: `the daemon ${death} during startup; its log is ${logFile}`,
			};
		}
	}
	return {
		connected: false,
		reason: "timeout",
		detail: `daemon did not publish a lock within ${timeoutMs}ms; its log is ${logFile}`,
	};
}
