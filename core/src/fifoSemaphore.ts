/** Bounded slots; a release hands its slot straight to the oldest waiter. */
export class FifoSemaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
	}

	async acquire(): Promise<() => void> {
		if (this.active < this.capacity && this.waiters.length === 0) {
			this.active++;
		} else {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next === undefined) this.active--;
			else next();
		};
	}
}
