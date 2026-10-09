// The only races in core. Each mints its own second arm, so nothing raced outlives the call: a
// reaction left on a long-lived promise is retained until that promise settles.

import type { Clock, TimerHandle } from "./clock.js";

////////////////////////////////
//  Interfaces & Types

/** A budget ran out, as opposed to the work failing. */
export class DeadlineError extends Error {}

////////////////////////////////
//  Functions & Helpers

/**
 * Rejects, naming `what`, when `work` has not settled within `ms`. Each time the budget runs out,
 * `extend` may grant more milliseconds, or name the error to reject with instead.
 */
export function withTimeout<T>(
	clock: Clock,
	work: Promise<T>,
	ms: number,
	what: string,
	extend: () => number | Error | null = () => null,
): Promise<T> {
	let timer: TimerHandle;
	const bounded = new Promise<T>((_, reject) => {
		const expire = () => {
			const more = extend();
			if (typeof more === "number") timer = clock.setTimer(expire, more);
			else reject(more ?? new DeadlineError(`${what} timed out after ${ms}ms`));
		};
		timer = clock.setTimer(expire, ms);
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
