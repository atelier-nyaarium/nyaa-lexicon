import { describe, expect, it, mock } from "bun:test";
import type { DaemonChannel } from "@nyaa-lexicon/client";
import type { LexiconService, StoredDeclaration } from "@nyaa-lexicon/core";
import { daemonReads, deferredReads, type LexiconReads, localReads } from "../reads";

////////////////////////////////
//  Helpers

function reads(overrides: Partial<LexiconReads> = {}): LexiconReads {
	return {
		declarationsIn: async () => [],
		declarationOf: async () => null,
		describe: async () => null,
		findReferences: async (symbolId) => ({ symbolId, references: [], total: 0, truncated: false, tier: "bound" }),
		typeOf: async () => ({ status: "unknown", reason: "NotImplemented" }),
		typeHierarchy: async (symbolId) => ({
			symbolId,
			supertypes: [],
			subtypes: [],
			ancestors: [],
			unboundSupertypes: [],
		}),
		callHierarchy: async (symbolId) => ({ symbolId, incoming: [], outgoing: [] }),
		recallAnswers: async () => [],
		prepareRename: async (symbolId, newName) => ({
			symbolId,
			oldName: "old",
			newName,
			files: [],
			occurrences: 0,
			blockers: [],
			warnings: [],
		}),
		renameEdits: async (symbolId, newName) => ({
			ok: false,
			plan: {
				symbolId,
				oldName: "old",
				newName,
				files: [],
				occurrences: 0,
				blockers: [],
				warnings: [],
			},
			reason: "not under test",
		}),
		transactionOpen: async () => false,
		...overrides,
	};
}

////////////////////////////////
//  Tests

describe("deferred reads", () => {
	it("resolves lazily once and forwards concurrent questions unchanged", async () => {
		const declarationsIn = mock(async (_module: string) => [] as StoredDeclaration[]);
		const declarationOf = mock(async (_symbolId: string) => null);
		const findReferences = mock(async (symbolId: string, limit?: number) => ({
			symbolId,
			references: [],
			total: limit ?? 0,
			truncated: false,
			tier: "bound" as const,
		}));
		const renameEdits = mock(async (symbolId: string, newName: string) => ({
			ok: false as const,
			plan: {
				symbolId,
				oldName: "old",
				newName,
				files: [],
				occurrences: 0,
				blockers: [],
				warnings: [],
			},
			reason: "blocked",
		}));
		const transactionOpen = mock(async () => true);
		const resolved = reads({ declarationsIn, declarationOf, findReferences, renameEdits, transactionOpen });

		let release!: (value: LexiconReads) => void;
		const pending = new Promise<LexiconReads>((resolve) => {
			release = resolve;
		});
		const resolve = mock(() => pending);
		const deferred = deferredReads(resolve);

		expect(resolve).not.toHaveBeenCalled();
		const first = deferred.declarationsIn("src/file.ts");
		expect(resolve).toHaveBeenCalledTimes(1);
		const questions = [
			first,
			deferred.declarationOf("symbol:item"),
			deferred.findReferences("symbol:item", 17),
			deferred.renameEdits("symbol:item", "renamed"),
			deferred.transactionOpen(),
		];

		expect(resolve).toHaveBeenCalledTimes(1);
		release(resolved);
		const [declarations, declaration, references, rename, transaction] = await Promise.all(questions);

		expect(declarations).toEqual([]);
		expect(declaration).toBeNull();
		expect(references).toEqual({
			symbolId: "symbol:item",
			references: [],
			total: 17,
			truncated: false,
			tier: "bound",
		});
		expect(rename).toMatchObject({ ok: false, reason: "blocked" });
		expect(transaction).toBe(true);
		expect(declarationsIn).toHaveBeenCalledWith("src/file.ts");
		expect(declarationOf).toHaveBeenCalledWith("symbol:item");
		expect(findReferences).toHaveBeenCalledWith("symbol:item", 17);
		expect(renameEdits).toHaveBeenCalledWith("symbol:item", "renamed");
		expect(transactionOpen).toHaveBeenCalledTimes(1);
	});
});

describe("daemon reads", () => {
	it("uses the daemon wire methods and parameter shapes", async () => {
		const askImplementation: DaemonChannel["ask"] = async <T>(method: string, _params?: unknown) => {
			return (method === "refactorStatus" ? { open: true } : undefined) as T;
		};
		const ask = mock(askImplementation);
		const channel = { ask, close: mock() } as unknown as DaemonChannel;
		const daemon = daemonReads(channel);

		await Promise.all([
			daemon.declarationsIn("src/file.ts"),
			daemon.declarationOf("symbol:item"),
			daemon.describe("symbol:item"),
			daemon.findReferences("symbol:item", 17),
			daemon.typeOf("symbol:item"),
			daemon.typeHierarchy("symbol:item"),
			daemon.callHierarchy("symbol:item"),
			daemon.recallAnswers("symbol:item"),
			daemon.prepareRename("symbol:item", "renamed"),
			daemon.renameEdits("symbol:item", "renamed"),
			daemon.transactionOpen(),
		]);

		expect(ask.mock.calls).toEqual([
			["declarationsIn", { module: "src/file.ts" }],
			["declarationOf", { symbolId: "symbol:item" }],
			["describe", { symbolId: "symbol:item" }],
			["findReferences", { symbolId: "symbol:item", limit: 17 }],
			["typeOf", { symbolId: "symbol:item" }],
			["typeHierarchy", { symbolId: "symbol:item" }],
			["callHierarchy", { symbolId: "symbol:item" }],
			["recallAnswer", { symbolId: "symbol:item" }],
			["prepareRename", { symbolId: "symbol:item", newName: "renamed" }],
			["renameEdits", { symbolId: "symbol:item", newName: "renamed" }],
			["refactorStatus", {}],
		]);
	});
});

describe("local reads", () => {
	it("forwards a call and awaits its result", async () => {
		let release!: (value: StoredDeclaration[]) => void;
		const pending = new Promise<StoredDeclaration[]>((resolve) => {
			release = resolve;
		});
		const declarationsIn = mock(() => pending);
		const service = { declarationsIn } as unknown as LexiconService;
		const local = localReads(service);

		const result = local.declarationsIn("src/file.ts");
		expect(declarationsIn).toHaveBeenCalledWith("src/file.ts");
		release([]);
		expect(await result).toEqual([]);
	});
});
