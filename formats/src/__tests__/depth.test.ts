import { describe, expect, it } from "vitest";
import { isTooDeep } from "../depth.js";

describe("recognizing a recursion limit", () => {
	it("accepts the stack exhaustion a deep structure produces", () => {
		function forever(n: number): number {
			return forever(n + 1);
		}
		let caught: unknown;
		try {
			forever(0);
		} catch (failure) {
			caught = failure;
		}
		expect(isTooDeep(caught)).toBe(true);
	});

	it("refuses another RangeError, so a real bug is not reported as depth", () => {
		let caught: unknown;
		try {
			new Array(-1);
		} catch (failure) {
			caught = failure;
		}
		expect(caught).toBeInstanceOf(RangeError);
		expect(isTooDeep(caught)).toBe(false);
	});

	it("refuses anything that is not a RangeError", () => {
		expect(isTooDeep(new TypeError("call stack"))).toBe(false);
		expect(isTooDeep(undefined)).toBe(false);
	});
});
