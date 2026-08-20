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
	/** Asked at fire time. A reason re-arms instead of stopping: issue #7 was a daemon
	 * exiting under a running rename because only connections were counted. */
	holdWhile?: () => string | null;
	/** Told each time a hold re-arms. */
	onHeld?: (reason: string) => void;
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

	function arm(): void {
		handle = setTimer(() => {
			handle = null;
			if (cancelled) return;
			const held = options.holdWhile?.() ?? null;
			if (held !== null) {
				options.onHeld?.(held);
				// Re-checked: onHeld may itself have cancelled.
				if (!cancelled) arm();
				return;
			}
			options.stop();
		}, options.afterMs);
	}

	return {
		observe: (connections) => {
			if (cancelled) return;
			disarm();
			if (connections > 0) return;
			arm();
		},
		armed: () => handle !== null,
		cancel: () => {
			cancelled = true;
			disarm();
		},
	};
}
