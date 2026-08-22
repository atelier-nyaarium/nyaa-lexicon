// Time and timers, behind one seam, so a test decides instead of waiting.

////////////////////////////////
//  Interfaces & Types

declare const TIMER: unique symbol;

/** Opaque; only the clock that armed it can read it. */
export type TimerHandle = { readonly [TIMER]: true };

export interface Clock {
	/** Milliseconds since the epoch. */
	now(): number;
	/** Runs `fn` after `ms`. Never holds the process open: a pending timer is not work. */
	setTimer(fn: () => void, ms: number): TimerHandle;
	clearTimer(handle: TimerHandle): void;
	/** Resolves after `ms`. Holds the process open, since a caller is waiting on it. */
	sleep(ms: number): Promise<void>;
}

////////////////////////////////
//  Constants

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimer: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle as unknown as TimerHandle;
	},
	clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
