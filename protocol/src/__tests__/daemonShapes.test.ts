import { describe, expect, it } from "bun:test";
import { TransactionStatusSchema } from "../daemonShapes.js";

////////////////////////////////
//  Tests

describe("transaction status", () => {
	it("requires drift and editor provenance lists", () => {
		const base = { open: false, steps: [], tracked: [], issues: [] };
		expect(TransactionStatusSchema.safeParse(base).success).toBe(false);
		expect(
			TransactionStatusSchema.parse({
				...base,
				drifted: [{ module: "src/file.ts", contentHash: "a".repeat(32) }],
				edited: [],
			}),
		).toMatchObject({
			drifted: [{ module: "src/file.ts", contentHash: "a".repeat(32) }],
			edited: [],
		});
	});
});
