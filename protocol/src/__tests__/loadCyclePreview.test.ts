import { describe, expect, it } from "bun:test";
import {
	ArrangePreviewSchema,
	JudgeLoadCycleAnswerSchema,
	JudgeLoadCycleRequestSchema,
	unjudgedLoadCycle,
} from "../index.js";

describe("load-cycle preview protocol", () => {
	it("scopes full and partial judgments to the prepared overlay", () => {
		const request = JudgeLoadCycleRequestSchema.parse({
			preview: "preview-id",
			members: [{ module: "a.ts", contentHash: "hash" }],
			entries: ["a.ts"],
		});
		expect(unjudgedLoadCycle(request).preview).toBe("preview-id");
		expect(JudgeLoadCycleAnswerSchema.parse({ preview: "preview-id", partial: "slice-id" })).toEqual({
			preview: "preview-id",
			partial: "slice-id",
		});
	});

	it("accepts completed cycle results on successful arrangement previews", () => {
		const answer = ArrangePreviewSchema.parse({
			ok: true,
			files: [],
			issues: [],
			formatted: true,
			placed: [],
			loadCycles: [
				{
					modules: ["a.ts"],
					verdict: "unknown",
					entries: ["a.ts"],
					crossingCount: 0,
					crossings: [],
					bad: [],
					unknowns: [{ reason: "evidence" }],
				},
			],
		});
		expect(answer.ok && answer.loadCycles?.[0]?.unknowns).toEqual([{ reason: "evidence" }]);
	});
});
