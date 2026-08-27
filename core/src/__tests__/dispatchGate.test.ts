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

describe("the tree-first tier", () => {
	// One list. A method added to the shortcut without extending this test, or removed from it
	// without shrinking this test, fails here rather than drifting silently.
	const TIER_ONE = ["describe", "typeHierarchy", "callHierarchy", "findReferences", "typeOf", "factsFor"] as const;

	function treeTracingService(log: string[]) {
		const answer = (name: string) => () => {
			log.push(name);
			return null;
		};
		return {
			ensureTreeFor: async (symbolId: string) => {
				log.push(`tree:${symbolId}`);
			},
			describe: answer("describe"),
			typeHierarchy: answer("typeHierarchy"),
			callHierarchy: answer("callHierarchy"),
			findReferences: answer("findReferences"),
			typeOf: answer("typeOf"),
			factsFor: answer("factsFor"),
			symbolSource: answer("symbolSource"),
		} as unknown as LexiconService;
	}

	it.each(TIER_ONE)("full-parses the symbol's tree before answering %s", async (method) => {
		const log: string[] = [];
		const dispatch = createDispatch(treeTracingService(log));

		await dispatch(method, { symbolId: "lexicon ts src/a.ts X." });

		expect(log).toEqual(["tree:lexicon ts src/a.ts X.", method]);
	});

	it("does not tree-parse for a tier-3 symbol answer", async () => {
		const log: string[] = [];
		const dispatch = createDispatch(treeTracingService(log));

		await dispatch("symbolSource", { symbolId: "lexicon ts src/a.ts X." });

		expect(log).toEqual(["symbolSource"]);
	});

	it("accepts scope fields on the four search methods", async () => {
		const service = {
			ensureTreeFor: async () => {},
			findReferences: (_symbolId: string, _limit: number | undefined, within: string | undefined) => ({ within }),
			findLiterals: (query: unknown) => query,
			findComments: (query: unknown) => query,
			searchSymbols: (_text: string, options: unknown) => options,
		} as unknown as LexiconService;
		const dispatch = createDispatch(service);

		expect(await dispatch("findReferences", { symbolId: "lexicon ts a.ts X.", within: "X" })).toEqual({
			within: "X",
		});
		expect(await dispatch("findLiterals", { value: "warning", key: "severity", within: "Config" })).toMatchObject({
			key: "severity",
			within: "Config",
		});
		expect(await dispatch("findComments", { text: "warning", within: "Config" })).toEqual({
			text: "warning",
			within: "Config",
		});
		expect(await dispatch("searchSymbols", { text: "Config", within: "Config" })).toMatchObject({
			within: "Config",
		});
	});
});
