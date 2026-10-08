// Background discovery, one export per slice: history read outside the gate, scoring under a shared
// read admitted within a short wait, the write under a short exclusive hold; a busy gate defers the slice.

import type { IndexOutcome } from "@nyaa-lexicon/protocol";
import type { Clock, TimerHandle } from "./clock.js";
import type { QueuedExport } from "./relationDiscovery.js";
import type { Discovery } from "./relations.js";
import type { LexiconService } from "./service.js";
import type { Timings } from "./timings.js";
import { GateBusy } from "./workspaceGate.js";

////////////////////////////////
//  Interfaces & Types

export interface RelationWorkOptions {
	service: LexiconService;
	clock: Clock;
	timings?: Timings | undefined;
	stopping?: () => boolean;
	onError?: (error: unknown) => void;
}

export interface RelationWork {
	/** Called after indexing and upgrades complete; starts discovery and its queued work. */
	ready: () => Promise<void>;
	/** Queues changed exports and removes forgotten modules from discovery. */
	applied: (outcomes: readonly IndexOutcome[]) => void;
	stop: () => void;
	/** Resolves once nothing waits in the queue, or work stopped. */
	idle: () => Promise<void>;
}

////////////////////////////////
//  Constants

/** How long a slice waits to be admitted before it defers. */
const SLICE_WAIT_MS = 250;

/** Delay between slices in milliseconds. */
const SLICE_GAP_MS = 200;

/** After a busy gate or a failure. */
const RETRY_MS = 5_000;

/** A failed start's retry delay doubles up to this. */
const START_RETRY_MAX_MS = 10 * 60_000;

/** Newest commits whose files a store's first start samples. */
const SAMPLE_COMMITS = 20;

/** Stale suggestions and faded feedback are tidied this often. */
const TIDY_EVERY_MS = 60 * 60 * 1000;

////////////////////////////////
//  Functions & Helpers

export function startRelationWork(options: RelationWorkOptions): RelationWork {
	const { service, clock } = options;
	let ready = false;
	/** `ready` called, not yet started. */
	let starting = false;
	let stopped = false;
	let running = false;
	/** Batches whose exports are still being noticed. */
	let noticing = 0;
	let timer: TimerHandle | null = null;
	let tidy: TimerHandle | null = null;
	let restart: TimerHandle | null = null;
	let failedStarts = 0;
	let waiters: Array<() => void> = [];

	const quiet = () => {
		const settled = waiters;
		waiters = [];
		for (const resolve of settled) resolve();
	};

	/** Nothing running, armed or being noticed. */
	const resting = () => !running && timer === null && noticing === 0;

	const schedule = (delay: number) => {
		if (stopped || !ready || running || timer !== null) return;
		timer = clock.setTimer(() => {
			timer = null;
			void slice();
		}, delay);
	};

	const discover = (symbolId: string, history: Awaited<ReturnType<LexiconService["relationHistory"]>>) => {
		try {
			return service.relations.discover(symbolId, history);
		} catch (error) {
			// One export that cannot be scored leaves the queue rather than blocking it.
			options.onError?.(error);
			return null;
		}
	};

	async function slice(): Promise<void> {
		if (stopped || options.stopping?.() === true) return;
		running = true;
		let next = SLICE_GAP_MS;
		try {
			const history = await service.relationHistory();
			const found = await service.gate
				.within(SLICE_WAIT_MS)
				.shared(async (): Promise<{ queued: QueuedExport; found: Discovery | null } | null> => {
					const queued = service.discovery.next();
					if (queued === null) return null;
					const work = async () => discover(queued.symbolId, history);
					const result =
						options.timings === undefined
							? await work()
							: await options.timings.time("relationDiscovery", {}, work);
					return { queued, found: result };
				});
			if (found === null) {
				running = false;
				if (resting()) quiet();
				return;
			}
			await service.gate.exclusive(async () => service.discovery.settle(found.queued, found.found));
		} catch (error) {
			if (!(error instanceof GateBusy)) options.onError?.(error);
			next = RETRY_MS;
		}
		running = false;
		schedule(next);
	}

	/** Starts discovery; a failure stays `starting`, still observing batches, and retries with backoff. */
	async function begin(): Promise<void> {
		let started = false;
		try {
			const recent = await service.recentlyChanged(SAMPLE_COMMITS);
			started = await service.gate.exclusive(async () => {
				if (stopped) return false;
				service.discovery.start(recent);
				try {
					service.relations.tidy();
				} catch (error) {
					// The start stands; the next tidy runs on schedule.
					options.onError?.(error);
				}
				return true;
			});
		} catch (error) {
			options.onError?.(error);
		}
		if (stopped) return;
		if (!started) {
			restart = clock.setTimer(
				() => {
					restart = null;
					void begin();
				},
				Math.min(START_RETRY_MAX_MS, RETRY_MS * 2 ** failedStarts++),
			);
			return;
		}
		starting = false;
		ready = true;
		armTidy();
		schedule(0);
	}

	const armTidy = () => {
		if (stopped) return;
		tidy = clock.setTimer(() => {
			void service.gate
				.exclusive(async () => service.relations.tidy())
				.catch((error) => options.onError?.(error))
				.finally(() => {
					if (!stopped) armTidy();
				});
		}, TIDY_EVERY_MS);
	};

	return {
		ready: async () => {
			if (ready || starting || stopped) return;
			starting = true;
			await begin();
		},
		applied: (outcomes) => {
			// Batches before `ready` belong to the quiet seed; those while it reads history are observed.
			if (stopped || (!ready && !starting)) return;
			const indexed = outcomes.filter((outcome) => outcome.action === "indexed").map((outcome) => outcome.module);
			const forgotten = outcomes
				.filter((outcome) => outcome.action === "forgotten")
				.map((outcome) => outcome.module);
			if (indexed.length === 0 && forgotten.length === 0) return;
			noticing++;
			void service.gate
				.exclusive(async () => service.discovery.observe(indexed, forgotten))
				.catch((error) => options.onError?.(error))
				.finally(() => {
					noticing--;
					schedule(0);
					if (resting()) quiet();
				});
		},
		stop: () => {
			stopped = true;
			for (const armed of [timer, tidy, restart]) if (armed !== null) clock.clearTimer(armed);
			timer = null;
			tidy = null;
			restart = null;
			quiet();
		},
		idle: () =>
			stopped || (ready && resting())
				? Promise.resolve()
				: new Promise<void>((resolve) => {
						waiters.push(resolve);
					}),
	};
}
