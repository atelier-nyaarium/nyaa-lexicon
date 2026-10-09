import { describe, expect, it } from "bun:test";
import { FifoSemaphore } from "../fifoSemaphore.js";

/** Runs every queued microtask and no timer, so only a timer-free wakeup is seen. */
async function drain(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

describe("FIFO semaphore", () => {
	it("holds four slots and hands each release to the oldest waiter without a timer", async () => {
		const slots = new FifoSemaphore(4);
		const order: string[] = [];
		const take = (id: string) =>
			slots.acquire().then((release) => {
				order.push(id);
				return release;
			});
		const held = ["a", "b", "c", "d", "e", "f"].map(take);
		await drain();
		expect(order).toEqual(["a", "b", "c", "d"]);

		const first = await held[0]!;
		first();
		const late = take("g");
		await drain();
		expect(order).toEqual(["a", "b", "c", "d", "e"]);

		first();
		(await held[1]!)();
		await drain();
		expect(order).toEqual(["a", "b", "c", "d", "e", "f"]);

		(await held[2]!)();
		await drain();
		expect(order).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
		for (const release of [...held.slice(3), late]) (await release)();
	});
});
