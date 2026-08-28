import { describe, expect, it } from "bun:test";
import { BUN_FLOOR, refuseRuntime, runtimeVerdict } from "../runtime";

describe("runtimeVerdict", () => {
	it("accepts bun at the floor and above it", () => {
		expect(runtimeVerdict({ bun: BUN_FLOOR })).toEqual({ kind: "bun", version: BUN_FLOOR });
		expect(runtimeVerdict({ bun: "1.4.7" })).toEqual({ kind: "bun", version: "1.4.7" });
		expect(runtimeVerdict({ bun: "2.0.0" })).toEqual({ kind: "bun", version: "2.0.0" });
	});

	it("names the floor for a bun below it, a prerelease of the floor included", () => {
		expect(runtimeVerdict({ bun: "1.3.9" })).toEqual({ kind: "belowFloor", version: "1.3.9", floor: BUN_FLOOR });
		expect(runtimeVerdict({ bun: `${BUN_FLOOR}-canary.12` })).toEqual({
			kind: "belowFloor",
			version: `${BUN_FLOOR}-canary.12`,
			floor: BUN_FLOOR,
		});
		expect(runtimeVerdict({ bun: "1.4.1-canary.3" })).toEqual({ kind: "bun", version: "1.4.1-canary.3" });
		expect(runtimeVerdict({ bun: `${BUN_FLOOR}+7` })).toEqual({ kind: "bun", version: `${BUN_FLOOR}+7` });
	});

	it("names the runtime when it is not bun at all, or claims a version that is not one", () => {
		expect(runtimeVerdict({ node: "22.5.1" })).toEqual({ kind: "notBun", runtime: "node 22.5.1" });
		expect(runtimeVerdict({})).toEqual({ kind: "notBun", runtime: "node unknown" });
		expect(runtimeVerdict({ bun: "garbage" })).toEqual({ kind: "notBun", runtime: "bun garbage" });
	});

	it("judges the process it runs in", () => {
		expect(runtimeVerdict().kind).toBe("bun");
	});
});

describe("refuseRuntime", () => {
	it("is silent on an accepted bun", () => {
		expect(refuseRuntime("the lexicon daemon", { bun: BUN_FLOOR })).toBeNull();
		expect(refuseRuntime("the lexicon daemon")).toBeNull();
	});

	it("says what was launched, what it needs and what it got", () => {
		expect(refuseRuntime("the lexicon daemon", { bun: "1.3.9" })).toBe(
			`the lexicon daemon needs bun ${BUN_FLOOR} or newer; this is bun 1.3.9`,
		);
		expect(refuseRuntime("the lexicon daemon", { node: "20.1.0" })).toBe(
			`the lexicon daemon runs on bun ${BUN_FLOOR} or newer; this is node 20.1.0`,
		);
	});
});
