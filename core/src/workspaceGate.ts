// Serializes everything that writes the workspace or the index.
//
// The daemon answers requests concurrently and the watcher reindexes on its own schedule, so
// before this a refactor step, a warm scan and a watcher batch could interleave inside one file.
// Readers run together because they only need to not see the middle of a multi-file write.
//
// Acquisition order is the linearization point: a step takes its number, rechecks its hashes and
// writes inside one exclusive hold, so two callers racing to mutate the same file cannot both
// decide their preconditions hold.

////////////////////////////////
//  Interfaces & Types

interface Waiter {
	exclusive: boolean;
	admit: () => void;
}

export interface GateStats {
	/** Readers currently running. */
	readers: number;
	writing: boolean;
	waiting: number;
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

	/** Runs alone. Nothing else reads or writes until it settles. */
	exclusive<T>(work: () => Promise<T>): Promise<T> {
		return this.acquire(true, work);
	}

	/** Runs alongside other readers, never during a write. */
	shared<T>(work: () => Promise<T>): Promise<T> {
		return this.acquire(false, work);
	}

	stats(): GateStats {
		return { readers: this.readers, writing: this.writing, waiting: this.waiting.length };
	}

	private async acquire<T>(exclusive: boolean, work: () => Promise<T>): Promise<T> {
		await new Promise<void>((admit) => {
			this.waiting.push({ exclusive, admit });
			this.pump();
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
				next.admit();
				return;
			}

			if (this.writing) return;
			this.waiting.shift();
			this.readers++;
			next.admit();
		}
	}
}
