// Keeping a running index current as files change.
//
// The watcher coalesces a burst into one batch; this owns what happens next. Batches are applied
// one at a time, because two overlapping re-indexes of the same file race on the same store rows,
// and a burst landing mid-apply is ordinary rather than rare.

import type { FileEvent } from "./invalidation.js";
import type { IndexOutcome, LexiconService } from "./service.js";
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
	onApplied?: (outcomes: IndexOutcome[]) => void;
	/** Called instead of throwing, since the watcher callback has no caller to catch anything. */
	onError?: (error: unknown) => void;
}

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
	});

	return { stop: watcher.stop, inject: watcher.inject, settled: queue.settled };
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
): { push: (events: FileEvent[]) => void; settled: () => Promise<void> } {
	let tail: Promise<void> = Promise.resolve();

	return {
		push: (events) => {
			tail = tail.then(async () => {
				try {
					// Applied first, THEN reported. `onApplied?.(await apply(events))` short-circuits its
					// own argument when nobody is listening, so the index would silently never update.
					const outcomes = await apply(events);
					onApplied?.(outcomes);
				} catch (error) {
					onError?.(error);
				}
			});
		},
		// Awaits the CURRENT tail, so a batch pushed after this call is not covered by it.
		settled: () => tail,
	};
}
