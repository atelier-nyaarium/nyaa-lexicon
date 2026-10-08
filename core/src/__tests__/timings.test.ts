import { describe, expect, it } from "bun:test";
import { rethrown } from "@nyaa-lexicon/protocol/rejection";
import { TIMING_RING, Timings } from "../timings";
import { fakeClock } from "./fakeClock";

describe("sparse timings", () => {
	it("keeps a stage's first call, one in a few after it and every slow one, while counting them all", () => {
		const timings = new Timings(fakeClock());
		for (let call = 0; call < 40; call++) timings.record("parseFacts", 5, { text: 100 });
		const before = timings.recorded();
		timings.record("parseFacts", 900, { text: 50_000 });
		timings.record("moduleFacts", 1);

		const { calls, stages } = timings.recorded();
		expect(stages).toEqual([
			{ stage: "parseFacts", count: 41, slow: 1 },
			{ stage: "moduleFacts", count: 1, slow: 0 },
		]);
		expect(calls.map((call) => [call.stage, call.ms])).toEqual([
			["parseFacts", 5],
			["parseFacts", 5],
			["parseFacts", 5],
			["parseFacts", 900],
			["moduleFacts", 1],
		]);
		expect(calls[3]?.sizes).toEqual({ text: 50_000 });
		expect(before.stages).toEqual([{ stage: "parseFacts", count: 40, slow: 0 }]);
	});

	it("holds a bounded ring, dropping the oldest", () => {
		const timings = new Timings(fakeClock());
		for (let call = 0; call < TIMING_RING + 5; call++) timings.record("slow", 300 + call);

		const { calls } = timings.recorded();
		expect(calls).toHaveLength(TIMING_RING);
		expect(calls[0]?.ms).toBe(305);
	});

	it("times work whether it answers or throws", async () => {
		const timings = new Timings(fakeClock());
		expect(await timings.time("answered", {}, async () => 7)).toBe(7);
		const thrown = timings.time("thrown", {}, async () => {
			throw new Error("refused");
		});
		expect(await rethrown(thrown)).toThrow("refused");

		expect(timings.recorded().stages.map((stage) => stage.stage)).toEqual(["answered", "thrown"]);
	});
});
