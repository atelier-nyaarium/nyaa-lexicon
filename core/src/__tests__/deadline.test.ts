import { describe, expect, it } from "bun:test";
import { withinBudget, withTimeout } from "../deadline";
import { fakeClock } from "./fakeClock";

////////////////////////////////
//  Tests

describe("withTimeout", () => {
	it("returns the answer and disarms the timer when work settles first", async () => {
		const clock = fakeClock();
		await expect(withTimeout(clock, Promise.resolve(1), 100, "ask")).resolves.toBe(1);
		expect(clock.pending()).toBe(0);
	});

	it("rejects naming the call when the deadline passes first", async () => {
		const clock = fakeClock();
		const bounded = withTimeout(clock, new Promise<never>(() => {}), 100, "ask");
		clock.advance(100);
		await expect(bounded).rejects.toThrow("ask timed out after 100ms");
	});
});

describe("withinBudget", () => {
	it("returns when work settles first, and disarms the timer", async () => {
		const clock = fakeClock();
		await withinBudget(clock, Promise.resolve("done"), 100);
		expect(clock.pending()).toBe(0);
	});

	it("returns at the budget while the work runs on", async () => {
		const clock = fakeClock();
		let finished = false;
		const work = new Promise<void>((resolve) => {
			clock.setTimer(() => {
				finished = true;
				resolve();
			}, 500);
		});

		const budgeted = withinBudget(clock, work, 100);
		clock.advance(100);
		await budgeted;
		expect(finished).toBe(false);

		clock.advance(400);
		await work;
		expect(finished).toBe(true);
	});
});
