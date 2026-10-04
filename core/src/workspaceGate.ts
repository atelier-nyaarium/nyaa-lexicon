// Serializes everything that writes the workspace or the index.
//
// The daemon answers requests concurrently and the watcher reindexes on its own schedule, so
// before this a refactor step, a warm scan and a watcher batch could interleave inside one file.
// Readers run together because they only need to not see the middle of a multi-file write.
//
// Acquisition order is the linearization point: a step takes its number, rechecks its hashes and
// writes inside one exclusive hold, so two callers racing to mutate the same file cannot both
// decide their preconditions hold.

import { type Clock, systemClock, type TimerHandle } from "./clock.js";
import { withinBudget } from "./deadline.js";

////////////////////////////////
//  Interfaces & Types

/** A read sharing one gate-wait budget between its pre-work and its entry. */
export interface BoundedRead {
	ahead(work: Promise<unknown>): Promise<void>;
	shared<T>(work: () => Promise<T>): Promise<T>;
}

interface Waiter {
	exclusive: boolean;
	/** Set before the waiter resumes. */
	admitted: boolean;
	admit: () => void;
}

export interface GateStats {
	/** Readers currently running. */
	readers: number;
	writing: boolean;
	waiting: number;
}

/** A bounded read that expired before admission; it left the queue and never runs. */
export class GateBusy extends Error {
	constructor(readonly waitMs: number) {
		super(
			`the workspace is busy with an index write; this read waited ${waitMs}ms and did not run. Ask again later`,
		);
		this.name = "GateBusy";
	}
}

////////////////////////////////
//  Class

/**
 * One per workspace. FIFO, so a steady stream of readers cannot starve a writer.
 *
 * Holds nothing across its own boundary: work that needs the gate takes it at the outermost
 * public entry point, and anything it calls runs already held. A nested acquire would deadlock
 * against the caller that is still holding it, which is why the private paths are spelled
 * `...UnderGate` rather than acquiring defensively.
 */
export class WorkspaceGate {
	private readers = 0;
	private writing = false;
	private readonly waiting: Waiter[] = [];

	constructor(private readonly clock: Clock = systemClock) {}

	/** Runs alone. Nothing else reads or writes until it settles. */
	exclusive<T>(work: () => Promise<T>): Promise<T> {
		return this.acquire(true, work);
	}

	/** Runs alongside other readers, never during a write. */
	shared<T>(work: () => Promise<T>): Promise<T> {
		return this.acquire(false, work);
	}

	/** `shared`, unless not admitted within `waitMs`: then it never runs and rejects with `GateBusy`. */
	sharedWithin<T>(waitMs: number, work: () => Promise<T>): Promise<T> {
		return this.acquire(false, work, waitMs);
	}

	/**
	 * One budget across a read's pre-work and its entry. `ahead` waits on pre-work only while the
	 * budget lasts and lets it run on; `shared` gets what is left.
	 */
	within(waitMs: number): BoundedRead {
		const deadline = this.clock.now() + waitMs;
		const left = () => Math.max(0, deadline - this.clock.now());
		return {
			ahead: (work) => withinBudget(this.clock, work, left()),
			shared: (work) => this.sharedWithin(left(), work),
		};
	}

	stats(): GateStats {
		return { readers: this.readers, writing: this.writing, waiting: this.waiting.length };
	}

	private async acquire<T>(exclusive: boolean, work: () => Promise<T>, waitMs?: number): Promise<T> {
		await new Promise<void>((admit, refuse) => {
			let timer: TimerHandle | null = null;
			const waiter: Waiter = {
				exclusive,
				admitted: false,
				admit: () => {
					if (timer !== null) this.clock.clearTimer(timer);
					admit();
				},
			};
			this.waiting.push(waiter);
			this.pump();
			if (waiter.admitted || waitMs === undefined) return;
			// Admission removes the waiter before resuming it.
			const withdraw = () => {
				const at = this.waiting.indexOf(waiter);
				if (at === -1) return;
				this.waiting.splice(at, 1);
				refuse(new GateBusy(waitMs));
				this.pump();
			};
			if (waitMs === 0) withdraw();
			else timer = this.clock.setTimer(withdraw, waitMs);
		});

		try {
			return await work();
		} finally {
			if (exclusive) this.writing = false;
			else this.readers--;
			this.pump();
		}
	}

	/**
	 * Admits from the front only, so a reader arriving behind a waiting writer waits its turn.
	 *
	 * Admitting any ready reader instead would let a steady read load hold the gate open forever
	 * while a refactor step never runs.
	 *
	 * The hold is counted HERE rather than in `acquire`, because resolving a promise resumes its
	 * awaiter in a later microtask: a pump running in between would otherwise still see the gate
	 * free and admit someone who conflicts.
	 */
	private pump(): void {
		while (this.waiting.length > 0) {
			const next = this.waiting[0] as Waiter;

			if (next.exclusive) {
				if (this.writing || this.readers > 0) return;
				this.waiting.shift();
				this.writing = true;
				next.admitted = true;
				next.admit();
				return;
			}

			if (this.writing) return;
			this.waiting.shift();
			this.readers++;
			next.admitted = true;
			next.admit();
		}
	}
}
