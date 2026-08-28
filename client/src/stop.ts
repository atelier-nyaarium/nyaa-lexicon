// Stopping a daemon on purpose: ask it, then wait for its lock to go.
//
// The ask is what makes it graceful; the lock vanishing is what makes it done. One definition of
// "stopped", shared by the session and the management tool.

import { readFileSync } from "node:fs";
import { type DaemonLock, DaemonLockSchema } from "@nyaa-lexicon/protocol";
import { callDaemon } from "./discover.js";
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

////////////////////////////////
//  Constants

/** The daemon removes its lock first thing on the way out, so this waits on its settle, not its work. */
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

////////////////////////////////
//  Functions & Helpers

/** Whether the file still names this daemon. Absent, unreadable and another's all read as gone. */
function stillHeld(lockFile: string, token: string): boolean {
	try {
		const parsed = DaemonLockSchema.safeParse(JSON.parse(readFileSync(lockFile, "utf8")));
		return parsed.success && parsed.data.token === token;
	} catch {
		return false;
	}
}

/**
 * Ask the daemon behind `lock` to stop, and return once `lockFile` no longer names it.
 *
 * A daemon already gone cannot be asked; its lock going is still the answer that counts, so the
 * ask's failure is only reported when the lock outlives the wait too.
 */
export async function shutdownDaemon(lock: DaemonLock, lockFile: string, wait: ShutdownWait = {}): Promise<void> {
	const timeoutMs = wait.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = (ms: number) =>
		wait.clock === undefined ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : wait.clock.sleep(ms);

	let refusal: string | null = null;
	try {
		await callDaemon(lock, "shutdown", {});
	} catch (error) {
		refusal = error instanceof Error ? error.message : String(error);
	}

	for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
		if (!stillHeld(lockFile, lock.token)) return;
		await sleep(POLL_MS);
	}
	throw new DaemonError(
		refusal === null
			? `pid ${lock.pid} was asked to stop but still holds ${lockFile} after ${timeoutMs}ms`
			: `pid ${lock.pid} could not be asked to stop (${refusal}) and still holds ${lockFile}`,
		"daemon",
	);
}
