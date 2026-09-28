import { describe, expect, it } from "bun:test";
import { InnermostSweep } from "../innermost.js";

describe("the innermost interval sweep", () => {
	it("answers the shortest half-open interval holding each rising offset, the earlier of two equal ones", () => {
		const sweep = new InnermostSweep([
			{ start: 0, end: 100, value: "file" },
			{ start: 10, end: 40, value: "outer" },
			{ start: 20, end: 30, value: "first" },
			{ start: 20, end: 30, value: "second" },
			{ start: 50, end: 60, value: "later" },
		]);
		expect([5, 15, 20, 29, 30, 39, 40, 55, 60, 100].map((offset) => sweep.at(offset))).toEqual([
			"file",
			"outer",
			"first",
			"first",
			"outer",
			"outer",
			"file",
			"later",
			"file",
			undefined,
		]);
	});

	it("refuses an offset lower than one it answered", () => {
		const sweep = new InnermostSweep([{ start: 0, end: 10, value: 1 }]);
		sweep.at(5);
		expect(() => sweep.at(4)).toThrow();
	});
});
