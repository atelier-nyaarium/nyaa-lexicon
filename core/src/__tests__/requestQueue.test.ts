import { describe, expect, it } from "bun:test";
import { RequestQueue } from "../requestQueue";

////////////////////////////////
//  Helpers

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

////////////////////////////////
//  Tests

describe("serializing work", () => {
	it("returns each caller its own result", async () => {
		const queue = new RequestQueue();
		await expect(Promise.all([queue.run(async () => 1), queue.run(async () => 2)])).resolves.toEqual([1, 2]);
	});

	it("does not start the second request until the first settles", async () => {
		const queue = new RequestQueue();
		const first = deferred<string>();
		const order: string[] = [];

		const a = queue.run(async () => {
			order.push("a-start");
			return first.promise;
		});
		const b = queue.run(async () => {
			order.push("b-start");
			return "b";
		});

		await tick();
		expect(order).toEqual(["a-start"]);

		first.resolve("a");
		await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
		expect(order).toEqual(["a-start", "b-start"]);
	});

	it("runs work in the order it was queued", async () => {
		const queue = new RequestQueue();
		const seen: number[] = [];
		await Promise.all([1, 2, 3].map((n) => queue.run(async () => void seen.push(n))));
		expect(seen).toEqual([1, 2, 3]);
	});
});

describe("a failure settles its own caller only", () => {
	it("rejects the failing request and still runs the next", async () => {
		const queue = new RequestQueue();
		const failing = queue.run(async () => {
			throw new Error("boom");
		});
		const following = queue.run(async () => "fine");

		await expect(failing).rejects.toThrow("boom");
		await expect(following).resolves.toBe("fine");
	});

	it("keeps serving after a failure rather than wedging the queue", async () => {
		const queue = new RequestQueue();
		await expect(
			queue.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow();
		await expect(queue.run(async () => "still here")).resolves.toBe("still here");
		expect(queue.stats()).toEqual({ pending: 0, running: false });
	});
});

describe("closing when the provider dies", () => {
	it("rejects everything waiting, rather than leaving callers to time out one by one", async () => {
		const queue = new RequestQueue();
		const blocker = deferred<string>();
		const running = queue.run(() => blocker.promise);
		const waiting = queue.run(async () => "never");

		queue.close(new Error("provider exited"));

		await expect(waiting).rejects.toThrow("provider exited");
		blocker.resolve("done");
		await expect(running).resolves.toBe("done");
	});

	it("refuses new work while closed", async () => {
		const queue = new RequestQueue();
		queue.close(new Error("provider exited"));
		await expect(queue.run(async () => 1)).rejects.toThrow("provider exited");
	});

	it("serves again once reopened, so a restart reuses the queue", async () => {
		const queue = new RequestQueue();
		queue.close(new Error("provider exited"));
		queue.reopen();
		await expect(queue.run(async () => "back")).resolves.toBe("back");
	});
});

describe("stats", () => {
	it("reports what is waiting behind what is running", async () => {
		const queue = new RequestQueue();
		const blocker = deferred<string>();
		const running = queue.run(() => blocker.promise);
		void queue.run(async () => "second");

		await tick();
		expect(queue.stats()).toEqual({ pending: 1, running: true });

		blocker.resolve("done");
		await running;
		await tick();
		expect(queue.stats()).toEqual({ pending: 0, running: false });
	});
});
