// A test's view of a rejected promise, awaited through `.then`: `expect(promise).rejects` stalls
// bun's event loop while I/O is pending, so replies the test waits on land seconds late.

////////////////////////////////
//  Functions & Helpers

/** What `promise` rejects with; throws when it resolves instead. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	const settled = await promise.then(
		() => ({ rejected: false as const }),
		(reason: unknown) => ({ rejected: true as const, reason }),
	);
	if (!settled.rejected) throw new Error("expected a rejection, but the promise resolved");
	return settled.reason;
}

/** `rejection` as a function that throws it, for `toThrow`. */
export async function rethrown(promise: Promise<unknown>): Promise<() => never> {
	const reason = await rejection(promise);
	return () => {
		throw reason;
	};
}
