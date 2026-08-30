// Keeping a running index current as files change.
//
// The watcher coalesces a burst into one batch; this owns what happens next. Batches are applied
// one at a time, because two overlapping re-indexes of the same file race on the same store rows,
// and a burst landing mid-apply is ordinary rather than rare.

import type { Clock, TimerHandle } from "./clock.js";
import type { IndexOutcome } from "./indexer.js";
import type { FileEvent } from "./invalidation.js";
import type { LexiconService } from "./service.js";
import type { SweepReport } from "./subjects.js";
import { watchWorkspace } from "./watcher.js";

////////////////////////////////
//  Interfaces & Types

export interface LiveIndexOptions {
	service: LexiconService;
	workspaceRoot: string;
	/**
	 * Held for the whole batch, so a reindex cannot land between the files of one refactor step.
	 *
	 * Absent in tests that drive the watcher alone. In the daemon it is the same gate every
	 * mutation takes, which is what makes the two orderable at all.
	 */
	gate?: { exclusive: <T>(work: () => Promise<T>) => Promise<T> };
	debounceMs?: number;
	/** The one time source, shared with the store and the service, so the sweep timer and the debounce agree. */
	clock: Clock;
	onApplied?: (outcomes: IndexOutcome[]) => void;
	onSwept?: (report: SweepReport) => void;
	/** Called instead of throwing, since the watcher callback has no caller to catch anything. */
	onError?: (error: unknown) => void;
}

////////////////////////////////
//  Constants

/** An idle workspace has no scans, so orphans age and are deleted on this timer. */
export const KNOWLEDGE_SWEEP_EVERY_MS = 60 * 60 * 1000;

export interface LiveIndex {
	stop: () => void;
	/** Feeds an event as if the filesystem reported it. The seam the tests drive. */
	inject: (relative: string) => void;
	/** Resolves once every batch queued so far has been applied. */
	settled: () => Promise<void>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Watch a workspace and fold every change back into the index.
 *
 * A failed batch is reported and dropped rather than rethrown: an unhandled rejection inside the
 * watcher callback would take the whole daemon down over one unreadable file.
 */
export function startLiveIndex(options: LiveIndexOptions): LiveIndex {
	const apply = (events: Parameters<LexiconService["applyBatch"]>[0]) =>
		options.gate
			? options.gate.exclusive(() => options.service.applyBatch(events))
			: options.service.applyBatch(events);

	const queue = serializeBatches(apply, options.onApplied, options.onError);

	const watcher = watchWorkspace({
		workspaceRoot: options.workspaceRoot,
		onBatch: queue.push,
		...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
		clock: options.clock,
	});

	// Queued behind any batch in flight and under the same gate, so a sweep never overlaps a batch,
	// gate or not; re-armed after each run, so it never overlaps itself.
	const sweep = () =>
		options.gate
			? options.gate.exclusive(async () => options.service.sweepKnowledge())
			: Promise.resolve(options.service.sweepKnowledge());
	let stopped = false;
	let timer: TimerHandle | null = null;
	const arm = () => {
		timer = options.clock.setTimer(() => {
			queue
				.run(async () => {
					// Queued behind a batch when stop() landed: never started.
					// Queued behind a batch when stop() landed: never started.
					if (stopped) return;
					const report = await sweep();
					options.onSwept?.(report);
				})
				.finally(() => {
					if (!stopped) arm();
				});
		}, KNOWLEDGE_SWEEP_EVERY_MS);
	};
	arm();

	return {
		stop: () => {
			stopped = true;
			if (timer !== null) options.clock.clearTimer(timer);
			watcher.stop();
		},
		inject: watcher.inject,
		settled: queue.settled,
	};
}

/**
 * Apply batches one at a time, and never throw at a caller that cannot catch.
 *
 * Separated from the watcher because this is the part with the interesting behavior, and testing it
 * through a real filesystem would make a queue's correctness depend on inotify timing.
 */
export function serializeBatches(
	apply: (events: FileEvent[]) => Promise<IndexOutcome[]>,
	onApplied?: (outcomes: IndexOutcome[]) => void,
	onError?: (error: unknown) => void,
): {
	push: (events: FileEvent[]) => void;
	run: (work: () => Promise<void>) => Promise<void>;
	settled: () => Promise<void>;
} {
	let tail: Promise<void> = Promise.resolve();

	/** Appends to the one tail, so nothing here runs beside anything else here. */
	const run = (work: () => Promise<void>): Promise<void> => {
		tail = tail.then(async () => {
			try {
				await work();
			} catch (error) {
				onError?.(error);
			}
		});
		return tail;
	};

	return {
		push: (events) =>
			void run(async () => {
				// Applied first, THEN reported. `onApplied?.(await apply(events))` short-circuits its
				// own argument when nobody is listening, so the index would silently never update.
				const outcomes = await apply(events);
				onApplied?.(outcomes);
			}),
		run,
		// Awaits the CURRENT tail, so a batch pushed after this call is not covered by it.
		settled: () => tail,
	};
}
