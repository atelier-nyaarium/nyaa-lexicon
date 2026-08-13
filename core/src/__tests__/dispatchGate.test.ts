import { describe, expect, it } from "vitest";
import { createDispatch } from "../dispatch";
import type { LexiconService } from "../service";
import type { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Helpers

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Records when each call starts and ends, so overlap is visible rather than inferred. */
function tracingService(log: string[]) {
	const traced = async (name: string) => {
		log.push(`${name}:start`);
		await tick();
		log.push(`${name}:end`);
		return { module: name, action: "indexed" };
	};

	return {
		indexFile: () => traced("indexFile"),
		symbolSource: () => ({ found: false, reason: "stub" }),
	} as unknown as LexiconService;
}

function stubTransactions(log: string[]): TransactionManager {
	return {
		status: () => ({ open: false, steps: [], tracked: [], issues: [] }),
		track: async () => {
			log.push("track:start");
			await tick();
			log.push("track:end");
			return { tracked: true };
		},
	} as unknown as TransactionManager;
}

////////////////////////////////
//  Tests

describe("gating daemon mutations", () => {
	// The daemon answers frames concurrently, so without the gate two writes could interleave
	// inside the same file.
	it("never overlaps two mutations, whatever order they arrive in", async () => {
		const log: string[] = [];
		const dispatch = createDispatch(tracingService(log), {
			gate: new WorkspaceGate(),
			transactions: stubTransactions(log),
		});

		await Promise.all([
			dispatch("refactorTrack", { module: "a.ts" }),
			dispatch("indexFile", { module: "a.ts", contentHash: "h" }),
		]);

		expect(log).toEqual(["track:start", "track:end", "indexFile:start", "indexFile:end"]);
	});

	// Without a gate the service is driven directly, which is what a test harness does.
	it("still answers when built without refactor support", async () => {
		const log: string[] = [];
		const dispatch = createDispatch(tracingService(log));

		await dispatch("indexFile", { module: "a.ts", contentHash: "h" });
		expect(log).toEqual(["indexFile:start", "indexFile:end"]);
	});

	it("refuses a refactor call when the daemon has no journal", async () => {
		const dispatch = createDispatch(tracingService([]));
		await expect(dispatch("refactorStart", {})).rejects.toThrow(/without refactor support/);
	});

	it("rejects an unknown method rather than answering nothing", async () => {
		const dispatch = createDispatch(tracingService([]));
		await expect(dispatch("noSuchMethod", {})).rejects.toThrow(/unknown method/);
	});
});
