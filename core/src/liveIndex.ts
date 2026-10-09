// Keeping a running index current as files change.
//
// The watcher coalesces a burst into one batch; this owns what happens next. Batches are applied
// one at a time, because two overlapping re-indexes of the same file race on the same store rows,
// and a burst landing mid-apply is ordinary rather than rare.

import { defined } from "@nyaa-lexicon/protocol";
import type { Clock, TimerHandle } from "./clock.js";
import type { IndexOutcome } from "./indexer.js";
import { coalesce, type FileEvent } from "./invalidation.js";
import type { LexiconService } from "./service.js";
import { BatchFailed, lostRetryMs } from "./store.js";
import type { SweepReport } from "./subjects.js";
import { readEvent, watchWorkspace } from "./watcher.js";

////////////////////////////////
//  Interfaces & Types

export interface LiveIndexOptions {
	/** Its gate is held for the whole batch, so a reindex cannot land between one step's files. */
	service: LexiconService;
	workspaceRoot: string;
	debounceMs?: number;
	maxWaitMs?: number;
	/** The one time source, shared with the store and the service, so the sweep timer and the debounce agree. */
	clock: Clock;
	/** Runs once the watcher is up. Batches wait for it; a rejection stops the watcher. */
	warm?: () => Promise<void>;
	onApplied?: (outcomes: IndexOutcome[]) => void;
	onSwept?: (report: SweepReport) => void;
	/** Called instead of throwing, since the watcher callback has no caller to catch anything. */
	onError?: (error: unknown) => void;
	/** Read before every batch, and inside one at each file boundary. A daemon on its way out takes
	 * no new batch and abandons the one it holds rather than holding the gate for its whole run. */
	stopping?: () => boolean;
}

////////////////////////////////
//  Constants

/** An idle workspace has no scans, so orphans age and are deleted on this timer. */
export const KNOWLEDGE_SWEEP_EVERY_MS = 60 * 60 * 1000;

export { LOST_RETRY_MS } from "./store.js";

export interface LiveIndex {
	stop: () => void;
	/** Feeds an event as if the filesystem reported it. The seam the tests drive. */
	inject: (relative: string) => void;
	/** Resolves once every batch queued so far has been applied. A held batch is queued by `warmed`. */
	settled: () => Promise<void>;
	/** Settles as `warm` did, once what it held is queued. The caller that hands a `warm` in awaits this. */
	warmed: Promise<void>;
}

export interface HeldBatches {
	push: (events: FileEvent[]) => void;
	/** Releases what is held as one batch once `scan` settles; at once with none. Settles as `scan` did. */
	until: (scan: Promise<void> | undefined) => Promise<void>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Watch a workspace and fold every change back into the index.
 *
 * A failed batch is reported and dropped rather than rethrown: an unhandled rejection inside the
 * watcher callback would take the whole daemon down over one unreadable file. One whose writes the
 * store lost is applied again on a backoff, and so is a warm scan, so the session repairs itself once
 * the store takes writes again.
 */
export function startLiveIndex(options: LiveIndexOptions): LiveIndex {
	let stopped = false;
	let timer: TimerHandle | null = null;
	let retry: TimerHandle | null = null;
	const lost = new Set<string>();
	let losses = 0;

	// Paths, not events: each is read from disk at the retry, so a file that came back or went since
	// is taken as it is now, never as the lost event saw it.
	const retryLost = (events: FileEvent[]) => {
		for (const event of events) lost.add(event.module);
		if (retry !== null || stopped) return;
		retry = options.clock.setTimer(() => {
			retry = null;
			const again = [...lost].map((module) => readEvent(options.workspaceRoot, module));
			lost.clear();
			if (!stopped) queue.push(again);
		}, lostRetryMs(losses++));
	};

	// Skipped before the gate is even asked for, so a batch that arrives after the daemon was asked
	// to stop never queues behind its teardown.
	const apply = async (events: Parameters<LexiconService["applyBatch"]>[0]) => {
		if (options.stopping?.() === true) return [];
		try {
			const outcomes = await options.service.gate.exclusive(() =>
				options.service.applyBatch(events, options.stopping),
			);
			losses = 0;
			return outcomes;
		} catch (error) {
			if (error instanceof BatchFailed) retryLost(events);
			throw error;
		}
	};

	const warmKept = async (warm: () => Promise<void>) => {
		for (let tries = 0; ; tries++) {
			try {
				return await warm();
			} catch (error) {
				if (!(error instanceof BatchFailed) || stopped) throw error;
				options.onError?.(error);
				await options.clock.sleep(lostRetryMs(tries));
			}
		}
	};

	const queue = serializeBatches(apply, options.onApplied, options.onError);

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (timer !== null) options.clock.clearTimer(timer);
		if (retry !== null) options.clock.clearTimer(retry);
		watcher.stop();
	};

	// Held from birth, and only the watcher pushes, so nothing reaches the scan's loop.
	const held = holdBatches(queue.push, stop);
	const watcher = watchWorkspace({
		workspaceRoot: options.workspaceRoot,
		onBatch: held.push,
		// The index's own scope, so an ignored directory's churn is never read.
		scope: options.service.watchScope(),
		...defined({ debounceMs: options.debounceMs, maxWaitMs: options.maxWaitMs }),
		clock: options.clock,
	});
	// Watching first, then the scan, so its every read is under the watcher.
	const warmed = held.until(options.warm === undefined ? undefined : warmKept(options.warm));

	// Queued behind any batch in flight and under the same gate, so a sweep never overlaps a batch;
	// re-armed after each run, so it never overlaps itself.
	const sweep = () => options.service.gate.exclusive(async () => options.service.sweepKnowledge());
	const arm = () => {
		timer = options.clock.setTimer(() => {
			queue
				.run(async () => {
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
		stop,
		inject: watcher.inject,
		settled: queue.settled,
		warmed,
	};
}

/** Holds batches until the scan settles, coalesced per module, then releases them as one. A rejection drops what follows. */
export function holdBatches(push: (events: FileEvent[]) => void, onRefused: () => void): HeldBatches {
	let state: { kind: "holding"; events: FileEvent[] } | { kind: "released" } | { kind: "refused" } = {
		kind: "holding",
		events: [],
	};

	const release = () => {
		if (state.kind !== "holding") return;
		const { events } = state;
		state = { kind: "released" };
		if (events.length > 0) push(events);
	};

	return {
		push: (events) => {
			if (state.kind === "released") push(events);
			else if (state.kind === "holding") state.events = coalesce([...state.events, ...events]);
		},
		until: (scan) => {
			if (scan === undefined) {
				release();
				return Promise.resolve();
			}
			return scan.then(release, (error) => {
				state = { kind: "refused" };
				onRefused();
				throw error;
			});
		},
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
