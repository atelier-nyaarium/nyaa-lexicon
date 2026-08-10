// When a daemon with no clients left should stop.
//
// Its own module, not a timer in daemon.ts, because a rule tested by waiting is untested: a 150ms
// test passed just as happily against a 30 minute timer. The clock is injected, so every case
// here is decided rather than awaited.

////////////////////////////////
//  Interfaces & Types

export interface LingerOptions {
	/** How long a client-less daemon waits before stopping. */
	afterMs: number;
	/** What to run when it fires. */
	stop: () => void;
	/** Injected so tests decide rather than wait. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface Linger {
	/** Call with the current client count on every connect and disconnect. */
	observe: (connections: number) => void;
	/** True while the countdown is running. */
	armed: () => boolean;
	/** Stop watching without firing. For a daemon shutting down for another reason. */
	cancel: () => void;
}

////////////////////////////////
//  Constants

/** Long enough that a session pausing to think does not pay for a cold index on its next question. */
export const DEFAULT_LINGER_MS = 30 * 60 * 1000;

////////////////////////////////
//  Functions & Helpers

/** Runs only while nobody is connected. Re-arming restarts the FULL wait and clears any prior timer. */
export function lingerWhileEmpty(options: LingerOptions): Linger {
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

	let handle: unknown = null;
	let cancelled = false;

	function disarm(): void {
		if (handle === null) return;
		clearTimer(handle);
		handle = null;
	}

	return {
		observe: (connections) => {
			if (cancelled) return;
			disarm();
			if (connections > 0) return;
			handle = setTimer(() => {
				handle = null;
				options.stop();
			}, options.afterMs);
		},
		armed: () => handle !== null,
		cancel: () => {
			cancelled = true;
			disarm();
		},
	};
}
