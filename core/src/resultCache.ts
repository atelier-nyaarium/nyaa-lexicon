// Answers kept only while the facts they were drawn from still hold.
//
// Keyed by the question AND a generation counter that the index bumps whenever it changes. That is
// content-addressing one level up: invalidation is a comparison rather than a decision about which
// entries a given edit could possibly have touched, and getting that decision wrong is how a cache
// serves a confidently stale answer.
//
// Whole-index rather than per-file on purpose. A per-file key needs to know which files an answer
// consulted, and a reverse lookup consults all of them, so the precise version is both harder and
// barely narrower.

////////////////////////////////
//  Interfaces & Types

export interface CacheStats {
	hits: number;
	misses: number;
	entries: number;
	generation: number;
}

////////////////////////////////
//  Constants

/** Bounded so a long session cannot grow one without limit. Oldest key evicted first. */
const DEFAULT_CAPACITY = 500;

////////////////////////////////
//  Class

export class ResultCache {
	private entries = new Map<string, unknown>();
	private generation = 0;
	private hits = 0;
	private misses = 0;

	constructor(private readonly capacity = DEFAULT_CAPACITY) {}

	/** Everything held becomes unreachable at once. Called whenever the index changes at all. */
	invalidate(): void {
		this.generation++;
		this.entries.clear();
	}

	/**
	 * The cached answer, or the computed one stored under this generation.
	 *
	 * Only complete answers are stored: a thrown compute leaves nothing behind, so a transient
	 * provider failure cannot be remembered as an answer.
	 */
	async through<T>(key: string, compute: () => Promise<T>): Promise<T> {
		const full = `${this.generation} ${key}`;
		if (this.entries.has(full)) {
			this.hits++;
			return this.entries.get(full) as T;
		}

		this.misses++;
		const answer = await compute();
		if (this.entries.size >= this.capacity) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		this.entries.set(full, answer);
		return answer;
	}

	stats(): CacheStats {
		return { hits: this.hits, misses: this.misses, entries: this.entries.size, generation: this.generation };
	}
}
