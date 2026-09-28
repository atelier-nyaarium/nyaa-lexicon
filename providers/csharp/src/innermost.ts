// The innermost of a set of offset intervals holding each of a rising run of offsets.

////////////////////////////////
//  Interfaces & Types

/** Half-open: an offset at `end` is past it. */
export interface Interval<T> {
	start: number;
	end: number;
	value: T;
}

interface Entry<T> {
	interval: Interval<T>;
	/** Insertion order; the earlier of two equal lengths wins. */
	order: number;
}

////////////////////////////////
//  Classes

/** One sweep; `at` takes offsets in rising order, so the whole run costs O((n + q) log n). */
export class InnermostSweep<T> {
	private readonly pending: Entry<T>[];
	private readonly heap: Entry<T>[] = [];
	private next = 0;
	private last = Number.NEGATIVE_INFINITY;

	constructor(intervals: readonly Interval<T>[]) {
		this.pending = intervals
			.map((interval, order) => ({ interval, order }))
			.sort((left, right) => left.interval.start - right.interval.start || left.order - right.order);
	}

	/** Shortest interval holding `offset`; undefined when none does. */
	at(offset: number): T | undefined {
		if (offset < this.last) throw new Error("innermost sweep offsets must rise");
		this.last = offset;
		while (this.next < this.pending.length && (this.pending[this.next] as Entry<T>).interval.start <= offset) {
			this.push(this.pending[this.next] as Entry<T>);
			this.next++;
		}
		while (this.heap.length > 0 && (this.heap[0] as Entry<T>).interval.end <= offset) this.pop();
		return this.heap[0]?.interval.value;
	}

	private push(entry: Entry<T>): void {
		const heap = this.heap;
		heap.push(entry);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (!before(entry, heap[parent] as Entry<T>)) break;
			heap[index] = heap[parent] as Entry<T>;
			index = parent;
		}
		heap[index] = entry;
	}

	private pop(): void {
		const heap = this.heap;
		const tail = heap.pop() as Entry<T>;
		if (heap.length === 0) return;
		let index = 0;
		for (;;) {
			const left = index * 2 + 1;
			if (left >= heap.length) break;
			const right = left + 1;
			const child = right < heap.length && before(heap[right] as Entry<T>, heap[left] as Entry<T>) ? right : left;
			if (!before(heap[child] as Entry<T>, tail)) break;
			heap[index] = heap[child] as Entry<T>;
			index = child;
		}
		heap[index] = tail;
	}
}

////////////////////////////////
//  Functions & Helpers

function before<T>(left: Entry<T>, right: Entry<T>): boolean {
	const leftLength = left.interval.end - left.interval.start;
	const rightLength = right.interval.end - right.interval.start;
	return leftLength < rightLength || (leftLength === rightLength && left.order < right.order);
}
