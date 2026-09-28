import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { callDaemon, findDaemon, type PlatformEnv } from "@nyaa-lexicon/client";
import {
	createDispatch,
	fromText,
	IndexStore,
	LexiconService,
	ownSource,
	ProviderSupervisor,
	type RunningDaemon,
	startDaemon,
} from "@nyaa-lexicon/core";
import {
	describeSymbol,
	doubtNote,
	findReferences,
	noteBacklinks,
	readNote,
	refactorPreview,
	resolveImport,
	symbolSource,
	type ToolBackend,
	typeOfSymbol,
	writeNote,
} from "../tools";

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
		const decision = findDaemon(workspaceRoot, ownSource(), host);
		if (decision.action !== "connect") throw new Error(`no indexer running (${decision.action})`);
		return (await callDaemon(decision.lock, method, params)) as T;
	}
	return {
		findByName: (name, module) => ask("findByName", { name, module }),
		describe: (symbolId) => ask("describe", { symbolId }),
		findReferences: (symbolId, limit) => ask("findReferences", { symbolId, limit }),
		resolveImport: (fromModule, specifier) => ask("resolveImport", { fromModule, specifier }),
		typeOf: (symbolId) => ask("typeOf", { symbolId }),
		declarationOf: (symbolId) => ask("declarationOf", { symbolId }),
		diagnoseSubject: (symbolId) => ask("diagnoseSubject", { symbolId }),
		indexStatus: (concerning) => ask("indexStatus", concerning === undefined ? {} : { concerning }),
		symbolSource: (address) => ask("symbolSource", address),
		refactorStart: () => ask("refactorStart", {}),
		refactorStatus: () => ask("refactorStatus", {}),
		prepareRename: (symbolId, newName) => ask("prepareRename", { symbolId, newName }),
		planMove: (symbolId, toModule) => ask("planMove", { symbolId, toModule }),
		refactorTrack: (module) => ask("refactorTrack", { module }),
		refactorUndo: () => ask("refactorUndo", {}),
		refactorRevert: (args) => ask("refactorRevert", args),
		refactorCommit: (force) => ask("refactorCommit", { force }),
		refactorReplace: (args) => ask("refactorReplace", args),
		refactorReplaceSpan: (args) => ask("refactorReplaceSpan", args),
		refactorInsert: (args) => ask("refactorInsert", args),
		refactorRename: (symbolId, newName) => ask("refactorRename", { symbolId, newName }),
		refactorMove: (symbolId, toModule) => ask("refactorMove", { symbolId, toModule }),
		findLiterals: (query) => ask("findLiterals", query),
		findComments: (query) => ask("findComments", query),
		findDocs: (query) => ask("findDocs", query),
		coChangedWith: (module, limit) => ask("coChangedWith", { module, limit }),
		searchSymbols: (query) => ask("searchSymbols", query),
		outlineModule: (module) => ask("outlineModule", { module }),
		fileNotes: (module) => ask("fileNotes", { module }),
		findImports: (query) => ask("findImports", query),
		hubs: (limit) => ask("hubs", { limit }),
		overview: () => ask("overview", {}),
		fileHistory: (module) => ask("fileHistory", { module }),
		commitsMentioning: (name, limit) => ask("commitsMentioning", { name, limit }),
		readNote: (symbolId) => ask("readNote", { symbolId }),
		writeNote: (request) => ask("writeNote", request),
		doubtNote: (symbolId, reason, expectedRevision, author) =>
			ask("doubtNote", { symbolId, reason, expectedRevision, author }),
		noteBacklinks: (target, limit) => ask("noteBacklinks", { symbolId: target, limit }),
	};
}

/** Minimal valid note. */
const NOTHING = { text: "Nothing.", expectedRevision: 0 };

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-e2e-"));
	host = { platform: "linux", env: { XDG_STATE_HOME: dir }, home: dir };
	files = new Map();

	store = IndexStore.open(path.join(dir, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: [process.execPath, "run", REFERENCE], timeoutMs: 15_000 }, dir);

	const service = new LexiconService(
		store,
		supervisor,
		fromText((module) => files.get(module) ?? null),
	);
	const outcome = await startDaemon({
		workspaceRoot: dir,
		handle: createDispatch(service),
		host,
	});
	if (!outcome.claimed) throw new Error(outcome.reason);
	daemon = outcome.daemon;

	files.set("cart.ref", "export class Cart {}\nexport function add() {}\n");
	await callDaemon(daemon.lock, "indexFile", { module: "cart.ref" });
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

	it("says the same thing about an id that names nothing as a writer would", async () => {
		const backend = backendOverDaemon(dir);
		const ghost = "lexicon reference cart.ref Ghost#";
		const diagnosis = await backend.diagnoseSubject(ghost);
		const result = await describeSymbol(backend, { symbolId: ghost });

		expect(diagnosis.kind).toBe("unminted");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain(JSON.stringify(diagnosis.reason).slice(1, -1));
		const refused = await backend.writeNote({ symbolId: ghost, ...NOTHING });
		if (refused.outcome !== "refused") throw new Error("expected a refusal");
		expect(refused.reason).toBe(diagnosis.reason);
	}, 30_000);

	it("says what a writer says for every outcome the daemon reaches, from every tool taking an id", async () => {
		const backend = backendOverDaemon(dir);
		const [cart] = await backend.findByName("Cart", undefined);
		const declaration = (await backend.declarationOf(cart?.symbolId as string))?.factId as string;

		// A note written about Item, whose file then vanishes, leaves its subject stranded.
		files.set("item.ref", "export class Item {}\n");
		await callDaemon(daemon.lock, "indexFile", { module: "item.ref" });
		const [item] = await backend.findByName("Item", undefined);
		const itemId = item?.symbolId as string;
		expect((await backend.writeNote({ symbolId: itemId, ...NOTHING, text: "An item." })).outcome).toBe("saved");
		files.delete("item.ref");
		await callDaemon(daemon.lock, "indexFile", { module: "item.ref" });

		const outcomes: Array<[string, string]> = [
			["factIdAsSubject", declaration],
			["unminted", "lexicon reference cart.ref Ghost#"],
			["unknown", "lexicon reference nowhere.ref Ghost#"],
			["stranded", itemId],
		];
		for (const [kind, symbolId] of outcomes) {
			const diagnosis = await backend.diagnoseSubject(symbolId);
			expect<string>(diagnosis.kind).toBe(kind);
			const refused = await backend.writeNote({ symbolId, ...NOTHING });
			expect(refused.outcome === "refused" ? refused.reason : refused.outcome).toBe(diagnosis.reason);

			const results = [
				await describeSymbol(backend, { symbolId }),
				await readNote(backend, { symbolId }),
				await writeNote(backend, { symbolId, ...NOTHING }),
				await doubtNote(backend, { symbolId, reason: "misleading", expectedRevision: 1 }),
				await noteBacklinks(backend, { symbolId }),
				await findReferences(backend, { symbolId }),
				await symbolSource(backend, { symbolId }),
				await typeOfSymbol(backend, { symbolId }),
				await refactorPreview(backend, { symbolId, newName: "Renamed" }),
			];
			for (const result of results) {
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result)).toContain(JSON.stringify(diagnosis.reason).slice(1, -1));
			}
		}
	}, 60_000);

	it("reflects a re-index, so an edit is visible without restarting anything", async () => {
		files.set("cart.ref", "export class Cart {}\nexport class Basket {}\n");
		await callDaemon(daemon.lock, "indexFile", { module: "cart.ref" });

		const added = await describeSymbol(backendOverDaemon(dir), { name: "Basket" });
		expect(added.isError).toBeUndefined();

		// The removed symbol is gone, not merely shadowed by the new one.
		const removed = await describeSymbol(backendOverDaemon(dir), { name: "add" });
		expect(removed.isError).toBe(true);
	}, 30_000);

	it("carries the note flow through the daemon: write, doubt, refuse, clear, and backlinks", async () => {
		const backend = backendOverDaemon(dir);
		const [cart] = await backend.findByName("Cart", undefined);
		const [add] = await backend.findByName("add", undefined);
		const cartId = cart?.symbolId as string;
		const symbolId = add?.symbolId as string;
		const note = { ...NOTHING, symbolId, text: "Adds one item to a [Cart](ref://cart.ref:Cart)." };

		expect((await writeNote(backend, note)).isError).toBeUndefined();
		expect(await backend.readNote(symbolId)).toMatchObject({
			revision: 1,
			links: [{ state: "ok", symbolId: cartId }],
		});

		expect(
			(await doubtNote(backend, { symbolId, reason: "it adds two", expectedRevision: 1 })).isError,
		).toBeUndefined();
		expect((await backend.readNote(symbolId))?.doubt?.reason).toBe("it adds two");

		expect((await writeNote(backend, note)).isError).toBe(true);
		const broken = await backend.writeNote({
			...note,
			text: "Adds to a [cart](ref://cart.ref:Ghost).",
			expectedRevision: 1,
		});
		expect(broken.outcome === "refused" && broken.refs?.[0]?.candidates).toContain("ref://cart.ref:Cart");

		const cleared = await backend.writeNote({ ...note, expectedRevision: 1 });
		expect(cleared.outcome === "saved" && cleared.note).toMatchObject({ revision: 2, doubt: null });
		expect((await backend.noteBacklinks(cartId)).notes.map((entry) => entry.symbolId)).toEqual([symbolId]);
	}, 30_000);

	it("refuses a caller that cannot find the daemon, rather than answering from nothing", async () => {
		await daemon.stop();
		await expect(describeSymbol(backendOverDaemon(dir), { name: "Cart" })).rejects.toThrow();
	}, 30_000);
});
