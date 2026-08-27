import { describe, expect, it } from "vitest";
import { createDispatch } from "../dispatch";
import type { CommentQuery, LiteralQuery } from "../indexReads";
import type { LexiconService } from "../service";
import type { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Helpers

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const SYMBOL = "lexicon ts src/a.ts X.";

// Dispatch parses every answer, so each stub answers the least its response schema accepts.
const EMPTY_PAGE = { count: { kind: "exact", count: 0 }, total: 0, truncated: false } as const;

const NO_REFERENCES = { symbolId: SYMBOL, references: [], total: 0, truncated: false, tier: "bound" } as const;

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

	// The answer side of the table: a malformed answer is an error to the caller, never a result.
	it("refuses a malformed answer instead of shipping it", async () => {
		const service = { cacheStats: () => ({ hits: "many", misses: 0, entries: 0 }) } as unknown as LexiconService;
		const dispatch = createDispatch(service);
		await expect(dispatch("cacheStats", {})).rejects.toThrow(/hits/);
	});
});

describe("the tree-first tier", () => {
	// One list. A method added to the shortcut without extending this test, or removed from it
	// without shrinking this test, fails here rather than drifting silently.
	const TIER_ONE = ["describe", "typeHierarchy", "callHierarchy", "findReferences", "typeOf", "factsFor"] as const;

	function treeTracingService(log: string[]) {
		const traced =
			<T>(name: string, value: T) =>
			(): T => {
				log.push(name);
				return value;
			};
		return {
			ensureTreeFor: async (symbolId: string) => {
				log.push(`tree:${symbolId}`);
			},
			describe: traced("describe", null),
			typeHierarchy: traced("typeHierarchy", {
				symbolId: SYMBOL,
				supertypes: [],
				subtypes: [],
				ancestors: [],
				unboundSupertypes: [],
			}),
			callHierarchy: traced("callHierarchy", { symbolId: SYMBOL, incoming: [], outgoing: [] }),
			findReferences: traced("findReferences", NO_REFERENCES),
			typeOf: traced("typeOf", { status: "unknown", reason: "NotImplemented" }),
			factsFor: traced("factsFor", null),
			symbolSource: traced("symbolSource", { found: false, reason: "stub" }),
		} as unknown as LexiconService;
	}

	it.each(TIER_ONE)("full-parses the symbol's tree before answering %s", async (method) => {
		const log: string[] = [];
		const dispatch = createDispatch(treeTracingService(log));

		await dispatch(method, { symbolId: SYMBOL });

		expect(log).toEqual([`tree:${SYMBOL}`, method]);
	});

	it("does not tree-parse for a tier-3 symbol answer", async () => {
		const log: string[] = [];
		const dispatch = createDispatch(treeTracingService(log));

		await dispatch("symbolSource", { symbolId: SYMBOL });

		expect(log).toEqual(["symbolSource"]);
	});

	// A literal or comment answer carries its query back, so the scope is read off the answer. A
	// reference or symbol answer has no query field, so the scope is recorded as the service saw it.
	it("accepts scope fields on the four search methods", async () => {
		const seen: { findReferences?: string | undefined; searchSymbols?: string | undefined } = {};
		const service = {
			ensureTreeFor: async () => {},
			findReferences: (_symbolId: string, _limit: number | undefined, within: string | undefined) => {
				seen.findReferences = within;
				return NO_REFERENCES;
			},
			findLiterals: (query: LiteralQuery) => ({ query, literals: [], ...EMPTY_PAGE }),
			findComments: (query: CommentQuery) => ({ query, comments: [], ...EMPTY_PAGE }),
			searchSymbols: (text: string, options: { within?: string | undefined }) => {
				seen.searchSymbols = options.within;
				return { text, symbols: [], ...EMPTY_PAGE };
			},
		} as unknown as LexiconService;
		const dispatch = createDispatch(service);

		await dispatch("findReferences", { symbolId: SYMBOL, within: "X" });
		expect(seen.findReferences).toBe("X");

		expect(await dispatch("findLiterals", { value: "warning", key: "severity", within: "Config" })).toMatchObject({
			query: { key: "severity", within: "Config" },
		});
		expect(await dispatch("findComments", { text: "warning", within: "Config" })).toMatchObject({
			query: { text: "warning", within: "Config" },
		});

		await dispatch("searchSymbols", { text: "Config", within: "Config" });
		expect(seen.searchSymbols).toBe("Config");
	});
});
