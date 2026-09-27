import { describe, expect, it } from "bun:test";
import { isTooDeep, MAX_NESTING, NestingGauge } from "../depth.js";

function refusal(run: () => void): unknown {
	try {
		run();
	} catch (failure) {
		return failure;
	}
	return undefined;
}

describe("bounding nesting from a parser's own events", () => {
	it("allows the limit and refuses one past it", () => {
		const gauge = new NestingGauge();
		for (let open = 0; open < MAX_NESTING; open++) gauge.open();
		expect(isTooDeep(refusal(() => gauge.open()))).toBe(true);
	});

	it("ignores stray closers, and a reset closes everything", () => {
		const gauge = new NestingGauge(2);
		gauge.close();
		gauge.open();
		gauge.open();
		gauge.reset();
		gauge.open();
		gauge.open();
		expect(isTooDeep(refusal(() => gauge.open()))).toBe(true);
	});
});

describe("recognizing a recursion limit", () => {
	it("accepts the stack exhaustion a deep structure produces", () => {
		// Not a tail call: an engine with proper tail calls would loop forever instead of overflowing.
		function forever(n: number): number {
			return 1 + forever(n + 1);
		}
		expect(isTooDeep(refusal(() => forever(0)))).toBe(true);
	});

	it("refuses another RangeError, so a real bug is not reported as depth", () => {
		const caught = refusal(() => new Array(-1));
		expect(caught).toBeInstanceOf(RangeError);
		expect(isTooDeep(caught)).toBe(false);
	});

	it("refuses anything that is not a RangeError or a gauge's refusal", () => {
		expect(isTooDeep(new TypeError("call stack"))).toBe(false);
		expect(isTooDeep(new Error("nested too deeply to index"))).toBe(false);
		expect(isTooDeep(undefined)).toBe(false);
	});
});
