import { describe, expect, it } from "bun:test";
import { createDispatch } from "../dispatch";
import type { CommentQuery, LiteralQuery } from "../indexReads";
import type { LexiconService } from "../service";
import type { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";
import { TREE_FIRST } from "./dispatchTiers";

////////////////////////////////
//  Helpers

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const SYMBOL = "lexicon ts src/a.ts X.";

// Dispatch parses every answer, so each stub answers the least its response schema accepts.
const EMPTY_PAGE = { count: { kind: "exact", count: 0 }, total: 0, truncated: false } as const;

const NO_REFERENCES = { symbolId: SYMBOL, references: [], total: 0, truncated: false, tier: "bound" } as const;

/** A service owns its gate, and dispatch reads it from there, so every stub carries a real one. */
function asService(stub: object): LexiconService {
	return { gate: new WorkspaceGate(), ...stub } as unknown as LexiconService;
}

/** Records when each call starts and ends, so overlap is visible rather than inferred. */
function tracingService(log: string[]) {
	const traced = async (name: string) => {
		log.push(`${name}:start`);
		await tick();
		log.push(`${name}:end`);
		return { module: name, action: "indexed" };
	};

	return asService({
		indexFile: () => traced("indexFile"),
		symbolSource: () => ({ found: false, reason: "stub" }),
	});
}

function stubTransactions(log: string[]): TransactionManager {
	return {
		status: () => ({ open: false, steps: [], tracked: [], drifted: [], edited: [], issues: [] }),
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
		const dispatch = createDispatch(tracingService(log), { transactions: stubTransactions(log) });

		await Promise.all([
			dispatch("refactorTrack", { module: "a.ts" }),
			dispatch("indexFile", { module: "a.ts", contentHash: "h" }),
		]);

		expect(log).toEqual(["track:start", "track:end", "indexFile:start", "indexFile:end"]);
	});

	// No journal to guard, and the gate is the service's either way.
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
		const dispatch = createDispatch(asService({ cacheStats: () => ({ hits: "many", misses: 0, entries: 0 }) }));
		await expect(dispatch("cacheStats", {})).rejects.toThrow(/hits/);
	});
});

describe("the tree-first tier", () => {
	function treeTracingService(log: string[]) {
		const traced =
			<T>(name: string, value: T) =>
			(): T => {
				log.push(name);
				return value;
			};
		return asService({
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
			usesFrom: traced("usesFrom", NO_REFERENCES),
			typeOf: traced("typeOf", { status: "unknown", reason: "NotImplemented" }),
			factsFor: traced("factsFor", null),
			symbolSource: traced("symbolSource", { found: false, reason: "stub" }),
		});
	}

	// The residue pins this list against `dispatch.ts`.
	it.each([...TREE_FIRST])("full-parses the symbol's tree before answering %s", async (method) => {
		if (typeof method !== "string") throw new Error("method name missing");
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
		const service = asService({
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
		});
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
