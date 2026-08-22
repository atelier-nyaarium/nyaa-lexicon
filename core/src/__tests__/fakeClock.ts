import type { Clock, TimerHandle } from "../clock";

////////////////////////////////
//  Interfaces & Types

export interface FakeClock extends Clock {
	/** Moves time forward, firing every timer due in time order, including ones armed while firing. */
	advance(ms: number): void;
	pending(): number;
}

////////////////////////////////
//  Functions & Helpers

/** The one test clock. `sleep` advances, so nothing awaited here waits on the wall. */
export function fakeClock(start = 1_000_000): FakeClock {
	const timers = new Map<number, { fn: () => void; at: number }>();
	let now = start;
	let nextId = 1;

	function advance(ms: number): void {
		const until = now + ms;
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, timer]) => timer.at <= until)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (due === undefined) break;
			timers.delete(due[0]);
			now = due[1].at;
			due[1].fn();
		}
		now = until;
	}

	return {
		now: () => now,
		setTimer: (fn, ms) => {
			const id = nextId++;
			timers.set(id, { fn, at: now + ms });
			return id as unknown as TimerHandle;
		},
		clearTimer: (handle) => {
			timers.delete(handle as unknown as number);
		},
		sleep: async (ms) => {
			advance(ms);
		},
		advance,
		pending: () => timers.size,
	};
}
