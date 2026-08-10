import { describe, expect, it } from "vitest";
import type { FileEvent } from "../invalidation";
import { serializeBatches } from "../liveIndex";
import type { IndexOutcome } from "../service";

////////////////////////////////
//  Helpers

function change(module: string): FileEvent {
	return { kind: "changed", module, contentHash: `h-${module}` };
}

////////////////////////////////
//  Tests

describe("batch serialization", () => {
	it("never runs two batches at once, because both would race the same store rows", async () => {
		const log: string[] = [];
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The first batch parks on `held`. An unserialized queue would let the second one enter while
		// it waits, which is exactly the overlap that corrupts a shared store row.
		const queue = serializeBatches(async (events) => {
			const label = events.map((e) => e.module).join(",");
			log.push(`enter ${label}`);
			if (label === "src/a.ts") await held;
			log.push(`exit ${label}`);
			return [];
		});

		queue.push([change("src/a.ts")]);
		queue.push([change("src/b.ts")]);
		for (let tick = 0; tick < 8; tick++) await Promise.resolve();

		expect(log).toEqual(["enter src/a.ts"]);

		release();
		await queue.settled();
		expect(log).toEqual(["enter src/a.ts", "exit src/a.ts", "enter src/b.ts", "exit src/b.ts"]);
	});

	it("reports a failing batch instead of taking the daemon down with it", async () => {
		const errors: unknown[] = [];
		const applied: IndexOutcome[][] = [];
		const queue = serializeBatches(
			async (events) => {
				if (events[0]?.module === "src/bad.ts") throw new Error("provider died");
				return events.map((e) => ({ module: e.module, action: "indexed" as const }));
			},
			(outcomes) => applied.push(outcomes),
			(error) => errors.push(error),
		);

		queue.push([change("src/bad.ts")]);
		queue.push([change("src/good.ts")]);
		await queue.settled();

		// The queue survives the failure, which is the point: one unreadable file must not stop the
		// daemon from indexing everything after it.
		expect((errors[0] as Error).message).toBe("provider died");
		expect(applied.flat().map((o) => o.module)).toEqual(["src/good.ts"]);
	});

	it("applies a batch when nobody is listening, which an optional-call chain quietly skips", async () => {
		const seen: string[] = [];
		const queue = serializeBatches(async (events) => {
			seen.push(events[0]?.module ?? "");
			return [];
		});

		queue.push([change("src/a.ts")]);
		await queue.settled();

		// Written after `onApplied?.(await apply(events))` shipped: with no listener that short-circuits
		// its own argument, so the work never ran and a live index would silently stop updating.
		expect(seen).toEqual(["src/a.ts"]);
	});

	it("settles even when nothing was ever pushed", async () => {
		await expect(serializeBatches(async () => []).settled()).resolves.toBeUndefined();
	});
});
