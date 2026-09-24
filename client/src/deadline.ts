// One shared race between an ask and the wait behind it, so both spend the same budget instead of
// each getting a fresh one. An abort ends either race early.

import type { Sleeper } from "./ensure.js";

////////////////////////////////
//  Functions & Helpers

/** Settles with `work`, or rejects naming `what` once `deadline` (epoch ms) passes first. The
 * losing arm is swallowed rather than left to report as an unhandled rejection later. */
export function beforeDeadline<T>(
	work: Promise<T>,
	deadline: number,
	sleep: Sleeper["sleep"],
	what: string,
): Promise<T> {
	const timeout = sleep(Math.max(0, deadline - Date.now())).then((): never => {
		throw new Error(`${what} timed out`);
	});
	timeout.catch(() => {});
	return Promise.race([work, timeout]);
}

/** Settles with `work`, or rejects with the signal's reason once it aborts first. */
export function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	work.catch(() => {});
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
