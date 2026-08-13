import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	callDaemon,
	createDispatch,
	findDaemon,
	IndexStore,
	LexiconService,
	type PlatformEnv,
	ProviderSupervisor,
	type RunningDaemon,
	startDaemon,
} from "@nyaa-lexicon/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeSymbol, findReferences, resolveImport, type ToolBackend } from "../tools";

////////////////////////////////
//  Helpers

const REFERENCE = path.join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"protocol",
	"src",
	"conformance",
	"referenceProvider.ts",
);

let dir: string;
let host: PlatformEnv;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let daemon: RunningDaemon;
let files: Map<string, string>;

/** Exactly what main.ts builds, but pointed at a test state dir. */
function backendOverDaemon(workspaceRoot: string): ToolBackend {
	async function ask<T>(method: string, params: unknown): Promise<T> {
		const decision = findDaemon(workspaceRoot, host);
		if (decision.action !== "connect") throw new Error(`no indexer running (${decision.action})`);
		return (await callDaemon(decision.lock, method, params)) as T;
	}
	return {
		findByName: (name, module) => ask("findByName", { name, module }),
		describe: (symbolId) => ask("describe", { symbolId }),
		findReferences: (symbolId, limit) => ask("findReferences", { symbolId, limit }),
		resolveImport: (fromModule, specifier) => ask("resolveImport", { fromModule, specifier }),
		typeOf: (symbolId) => ask("typeOf", { symbolId }),
		indexStatus: () => ask("indexStatus", {}),
		symbolSource: (address) => ask("symbolSource", address),
		refactorStart: () => ask("refactorStart", {}),
		refactorStatus: () => ask("refactorStatus", {}),
		refactorTrack: (module) => ask("refactorTrack", { module }),
		refactorUndo: () => ask("refactorUndo", {}),
		refactorRevert: () => ask("refactorRevert", {}),
		refactorCommit: (force) => ask("refactorCommit", { force }),
		refactorReplace: (args) => ask("refactorReplace", args),
		refactorRename: (symbolId, newName) => ask("refactorRename", { symbolId, newName }),
		refactorMove: (symbolId, toModule) => ask("refactorMove", { symbolId, toModule }),
		findLiterals: (query) => ask("findLiterals", query),
		coChangedWith: (module, limit) => ask("coChangedWith", { module, limit }),
		searchSymbols: (text, options) => ask("searchSymbols", { text, ...options }),
		outlineModule: (module) => ask("outlineModule", { module }),
		findImports: (query) => ask("findImports", query),
		hubs: (limit) => ask("hubs", { limit }),
		overview: () => ask("overview", {}),
		fileHistory: (module) => ask("fileHistory", { module }),
		factsFor: (symbolId, limit) => ask("factsFor", { symbolId, limit }),
		commitsMentioning: (name, limit) => ask("commitsMentioning", { name, limit }),
		recordAnswer: (symbolId, question, prose, citations, options) =>
			ask("recordAnswer", { symbolId, question, prose, citations, ...options }),
		recallAnswer: (symbolId, question) => ask("recallAnswer", { symbolId, question }),
		recallAnswers: (symbolId) => ask("recallAnswer", { symbolId }),
		invalidateAnswer: (symbolId, reason, question, by) =>
			ask("invalidateAnswer", { symbolId, reason, question, by }),
		reaffirmAnswer: (symbolId, question, options) => ask("reaffirmAnswer", { symbolId, question, ...options }),
		knowledgeGaps: (root, question, limit) => ask("knowledgeGaps", { root, question, limit }),
	};
}

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-e2e-"));
	host = { platform: "linux", env: { XDG_STATE_HOME: dir }, home: dir };
	files = new Map();

	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: ["bun", "run", REFERENCE], timeoutMs: 15_000 }, dir);

	const service = new LexiconService(store, supervisor, (module) => files.get(module) ?? null);
	const outcome = await startDaemon({
		workspaceRoot: dir,
		handle: createDispatch(service),
		host,
	});
	if (!outcome.claimed) throw new Error(outcome.reason);
	daemon = outcome.daemon;

	files.set("cart.ref", "export class Cart {}\nexport function add() {}\n");
	await callDaemon(daemon.lock, "indexFile", { module: "cart.ref", contentHash: "h1" });
});

afterEach(async () => {
	await daemon?.stop();
	supervisor?.stopAll();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a tool call reaching a real provider through a real daemon", () => {
	it("describes a symbol that a provider process actually parsed", async () => {
		const result = await describeSymbol(backendOverDaemon(dir), { name: "Cart" });

		expect(result.isError).toBeUndefined();
	}, 30_000);

	it("reports a symbol nothing references as such, not as a failure", async () => {
		const result = await findReferences(backendOverDaemon(dir), { name: "add" });

		expect(result.isError).toBeUndefined();
	}, 30_000);

	it("carries a provider's honest NotImplemented all the way to the agent", async () => {
		const result = await resolveImport(backendOverDaemon(dir), { fromModule: "cart.ref", specifier: "./item" });

		expect(result.isError).toBeUndefined();
	}, 30_000);

	it("says a name is not indexed rather than answering emptily", async () => {
		const result = await describeSymbol(backendOverDaemon(dir), { name: "Ghost" });

		expect(result.isError).toBe(true);
	}, 30_000);

	it("reflects a re-index, so an edit is visible without restarting anything", async () => {
		files.set("cart.ref", "export class Cart {}\nexport class Basket {}\n");
		await callDaemon(daemon.lock, "indexFile", { module: "cart.ref", contentHash: "h2" });

		const added = await describeSymbol(backendOverDaemon(dir), { name: "Basket" });
		expect(added.isError).toBeUndefined();

		// The removed symbol is gone, not merely shadowed by the new one.
		const removed = await describeSymbol(backendOverDaemon(dir), { name: "add" });
		expect(removed.isError).toBe(true);
	}, 30_000);

	it("carries the knowledge flow through the daemon: record, doubt, carry, and clear", async () => {
		const backend = backendOverDaemon(dir);
		const [cart] = await backend.findByName("Cart", undefined);
		const symbolId = cart?.symbolId as string;
		const facts = await backend.factsFor(symbolId, undefined);
		const declaration = facts?.facts.find((fact) => fact.kind === "declaration")?.factId as string;

		const recorded = await backend.recordAnswer(symbolId, "describe", "Holds checkout state.", [declaration]);
		expect(recorded.recorded).toBe(true);

		const doubted = await backend.invalidateAnswer(symbolId, "checkout was rewritten", "describe", "e2e");
		expect(doubted.doubted).toHaveLength(1);

		const recalled = await backend.recallAnswer(symbolId, "describe");
		expect(recalled?.answer.doubt?.reason).toBe("checkout was rewritten");

		// A re-record that never cites the doubt carries it; citing it clears it.
		const blind = await backend.recordAnswer(symbolId, "describe", "Rewritten blind.", [declaration]);
		expect(blind.recorded && blind.doubtCarried?.reason).toBe("checkout was rewritten");
		const token = (await backend.recallAnswer(symbolId, "describe"))?.answer.doubt?.factId as string;
		const cleared = await backend.reaffirmAnswer(symbolId, "describe", { resolvesDoubt: token });
		expect(cleared.recorded).toBe(true);
		expect((await backend.recallAnswer(symbolId, "describe"))?.answer.doubt).toBeUndefined();
	}, 30_000);

	it("refuses a caller that cannot find the daemon, rather than answering from nothing", async () => {
		await daemon.stop();
		await expect(describeSymbol(backendOverDaemon(dir), { name: "Cart" })).rejects.toThrow();
	}, 30_000);
});
