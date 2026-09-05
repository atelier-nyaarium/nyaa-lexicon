// The only races in core. Each mints its own second arm, so nothing raced outlives the call: a
// reaction left on a long-lived promise is retained until that promise settles.

import type { Clock, TimerHandle } from "./clock.js";

////////////////////////////////
//  Functions & Helpers

/** Rejects, naming `what`, when `work` has not settled within `ms`. */
export function withTimeout<T>(clock: Clock, work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: TimerHandle;
	const bounded = new Promise<T>((_, reject) => {
		timer = clock.setTimer(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([work, bounded]).finally(() => clock.clearTimer(timer));
}

/** Returns when `work` settles or `ms` elapses, whichever is first. `work` runs on regardless. */
export async function withinBudget(clock: Clock, work: Promise<unknown>, ms: number): Promise<void> {
	let handle: TimerHandle | null = null;
	const budget = new Promise<void>((resolve) => {
		handle = clock.setTimer(resolve, ms);
	});
	try {
		await Promise.race([work, budget]);
	} finally {
		if (handle !== null) clock.clearTimer(handle);
	}
}
