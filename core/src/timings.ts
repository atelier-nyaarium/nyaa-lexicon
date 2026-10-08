// Sparse timings of the daemon's work, toward judging where native code would pay: every slow
// call, and one in a few of the rest, per stage. Stage names and input sizes only, never code.

import { z } from "zod";
import type { Clock } from "./clock.js";

////////////////////////////////
//  Schemas

export const TimingSchema = z.object({
	at: z.number(),
	stage: z.string(),
	ms: z.number(),
	/** Input sizes, such as text lengths. */
	sizes: z.record(z.string(), z.number()),
});

/** A stage's tally since the daemon started, sampled or not. */
export const StageCountSchema = z.object({ stage: z.string(), count: z.number(), slow: z.number() });

export const TimingsSchema = z.object({ calls: z.array(TimingSchema), stages: z.array(StageCountSchema) });

export type Timing = z.infer<typeof TimingSchema>;
export type StageCount = z.infer<typeof StageCountSchema>;
export type Recorded = z.infer<typeof TimingsSchema>;

////////////////////////////////
//  Constants

/** A stage records one call in this many, and every slow one. */
const EVERY = 16;
/** Calls at least this long, in milliseconds, count as slow. */
const SLOW_MS = 250;

/** Days of sparse samples at a working pace. */
export const TIMING_RING = 1_000;

////////////////////////////////
//  Functions & Helpers

/** A request's sent text lengths, for its timing; never the text. */
export function textSizes(params: unknown): Record<string, number> {
	if (typeof params !== "object" || params === null) return {};
	const sizes: Record<string, number> = {};
	for (const [key, value] of Object.entries(params)) {
		// Ids and paths say nothing of the work's size.
		if (typeof value === "string" && /text$/i.test(key)) sizes[key] = value.length;
	}
	return sizes;
}

////////////////////////////////
//  Classes

export class Timings {
	private readonly ring: Timing[] = [];
	private readonly counts = new Map<string, StageCount>();

	constructor(private readonly clock: Clock) {}

	/** Counts the call, and keeps it when slow or the stage's one in `EVERY`. */
	record(stage: string, ms: number, sizes: Record<string, number> = {}): void {
		const tally = this.counts.get(stage) ?? { stage, count: 0, slow: 0 };
		tally.count += 1;
		if (ms >= SLOW_MS) tally.slow += 1;
		this.counts.set(stage, tally);
		// The first call too, so a rare stage still shows.
		if (ms < SLOW_MS && (tally.count - 1) % EVERY !== 0) return;
		this.ring.push({ at: this.clock.now(), stage, ms: Math.round(ms * 10) / 10, sizes });
		if (this.ring.length > TIMING_RING) this.ring.splice(0, this.ring.length - TIMING_RING);
	}

	/** Times `work`, thrown or not. */
	async time<T>(stage: string, sizes: Record<string, number>, work: () => Promise<T>): Promise<T> {
		const start = this.clock.now();
		try {
			return await work();
		} finally {
			this.record(stage, this.clock.now() - start, sizes);
		}
	}

	/** The kept calls, oldest first, and every stage's tally. */
	recorded(): Recorded {
		return { calls: [...this.ring], stages: [...this.counts.values()].map((tally) => ({ ...tally })) };
	}
}
