// Stopping a daemon on purpose: ask it, then wait for its lock to go.
//
// The ask is what makes it graceful; the lock vanishing is what makes it done. One definition of
// "stopped", shared by the session and the management tool.

import { readFileSync } from "node:fs";
import { type DaemonLock, parseDaemonLock } from "@nyaa-lexicon/protocol";
import { type DaemonRef, refersTo } from "./daemonRef.js";
import { beforeDeadline } from "./deadline.js";
import { callDaemon, stoppingRefusal } from "./discover.js";
import type { Sleeper } from "./ensure.js";
import { DaemonError } from "./errors.js";

////////////////////////////////
//  Interfaces & Types

export interface ShutdownWait {
	/** How long the lock may outlive the ask. */
	timeoutMs?: number;
	/** Injected so a test never waits on the wall. */
	clock?: Sleeper;
}

/**
 * How a stop request settled: gone, still on its way out, or never reached at all.
 *
 * `stopping` is not a failure: the ask landed, or the daemon had already been asked by someone
 * else, and its lock outliving the wait says only that its own work has not settled yet.
 *
 * `stopped`'s `detail` is set only when a fresh daemon already claimed the lock while this one
 * waited, so a caller never reads plain success as "nothing serves this project now".
 */
export type ShutdownOutcome =
	| { outcome: "stopped"; detail?: string }
	| { outcome: "stopping"; detail: string }
	| { outcome: "refused"; detail: string };

////////////////////////////////
//  Constants

/** The daemon removes its lock first thing on the way out, so this waits on its settle, not its work. */
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

////////////////////////////////
//  Functions & Helpers

function lockOnDisk(lockFile: string): DaemonLock | null {
	try {
		return parseDaemonLock(readFileSync(lockFile, "utf8"));
	} catch {
		return null;
	}
}

/**
 * What the lock file says right now, against the token being retired: still held, or gone with
 * whichever fresh daemon (never a delete's placeholder) may have already claimed it.
 */
function lockNow(lockFile: string, token: string): { held: boolean; replacedBy: DaemonLock | null } {
	const parsed = lockOnDisk(lockFile);
	if (parsed === null) return { held: false, replacedBy: null };
	if (parsed.token === token) return { held: true, replacedBy: null };
	return { held: false, replacedBy: parsed.role === "delete" ? null : parsed };
}

/**
 * Ask the daemon behind `lock` to stop, and report whether its lock cleared, is still clearing, or
 * could not be asked at all.
 *
 * A daemon already gone cannot be asked; its lock going is still the answer that counts, so the
 * ask's failure is only judged once the lock outlives the wait too. A refusal saying the daemon is
 * already on its way out, asked by someone else, still counts as clearing rather than a refusal.
 *
 * The ask and the wait behind it share one deadline: what the ask spends, the wait does not get.
 */
export async function requestShutdown(
	lock: DaemonLock,
	lockFile: string,
	wait: ShutdownWait = {},
): Promise<ShutdownOutcome> {
	const timeoutMs = wait.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = (ms: number) =>
		wait.clock === undefined ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : wait.clock.sleep(ms);
	const deadline = Date.now() + timeoutMs;

	let refusal: string | null = null;
	let stopping = false;
	try {
		await beforeDeadline(callDaemon(lock, "shutdown", {}), deadline, sleep, "shutdown");
	} catch (error) {
		refusal = error instanceof Error ? error.message : String(error);
		stopping = stoppingRefusal(error);
	}

	for (; Date.now() < deadline; ) {
		const state = lockNow(lockFile, lock.token);
		if (!state.held) {
			return state.replacedBy === null
				? { outcome: "stopped" }
				: { outcome: "stopped", detail: `pid ${state.replacedBy.pid} now serves it` };
		}
		await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
	}

	if (refusal === null || stopping) {
		return {
			outcome: "stopping",
			detail: `pid ${lock.pid} was asked to stop but still holds ${lockFile} after ${timeoutMs}ms`,
		};
	}
	return {
		outcome: "refused",
		detail: `pid ${lock.pid} could not be asked to stop (${refusal}) and still holds ${lockFile}`,
	};
}

/** As `requestShutdown`, but a lock outliving the wait is a `DaemonError`, stopping or not. */
export async function shutdownDaemon(lock: DaemonLock, lockFile: string, wait: ShutdownWait = {}): Promise<void> {
	const result = await requestShutdown(lock, lockFile, wait);
	if (result.outcome !== "stopped") throw new DaemonError(result.detail, "daemon");
}

/** Stops only `from`; absent or replaced daemons are left alone. */
export async function shutdownRef(from: DaemonRef, lockFile: string, wait: ShutdownWait = {}): Promise<void> {
	const current = lockOnDisk(lockFile);
	if (current === null || !refersTo(from, current)) return;
	await shutdownDaemon(current, lockFile, wait);
}
