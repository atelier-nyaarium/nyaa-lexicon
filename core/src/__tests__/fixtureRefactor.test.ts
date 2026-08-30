// The journaled rebind, driven through the daemon's own handlers against a provider that moves.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RefactorUndoResult } from "@nyaa-lexicon/protocol";
import { createDispatch } from "../dispatch";
import { lexiconRoot } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Helpers

const FIXTURE = path.join(lexiconRoot(), "protocol", "src", "conformance", "fixtureProvider.ts");

const CART = "lexicon reference a.ref Cart#";
const MOVED = "lexicon reference b.ref Cart#";
const RENAMED = "lexicon reference a.ref Basket#";

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let service: LexiconService;
let dispatch: ReturnType<typeof createDispatch>;

function put(module: string, text: string): void {
	writeFileSync(path.join(root, module), text);
}

function read(module: string): string | null {
	const full = path.join(root, module);
	return existsSync(full) ? readFileSync(full, "utf8") : null;
}

async function record(symbolId: string, prose: string): Promise<void> {
	const cited = store.declaration(symbolId)?.factId as string;
	const outcome = await service.recordAnswer(symbolId, "describe", prose, [cited]);
	if (!outcome.recorded) throw new Error(outcome.reason);
}

function journaledRebinds(): number {
	return (store.journal((db) => db.prepare("SELECT COUNT(*) AS n FROM refactor_rebinds").get()) as { n: number }).n;
}

function statusOf(symbolId: string) {
	return store.subjects.stateOf(symbolId, () => null);
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-fixture-refactor-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	await supervisor.start({ command: [process.execPath, "run", FIXTURE], timeoutMs: 30_000 }, root);
	service = new LexiconService(store, supervisor, sourceReader(root), root);
	dispatch = createDispatch(service, {
		gate: new WorkspaceGate(),
		transactions: new TransactionManager(store, root),
	});
	put("a.ref", "export class Cart {}\n");
	await service.indexFile("a.ref");
	await record(CART, "A shopping cart.");
	await dispatch("refactorStart", {});
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a move through the daemon's handlers", () => {
	it("rebinds the subject with the move as evidence, and its answer recalls at the new address", async () => {
		const outcome = await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		expect(outcome).toMatchObject({ moved: true, toModule: "b.ref", migrated: { answers: 1, gaps: 0 } });
		expect(read("b.ref")).toBe("export class Cart\n");
		expect(read("a.ref")).toBe(" {}\n");
		expect(store.declaration(CART)).toBeNull();
		expect(store.answer(MOVED, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(MOVED)).toMatchObject({ fromSymbolId: CART });
		expect(await dispatch("diagnoseSubject", { symbolId: CART })).toMatchObject({
			kind: "moved",
			forwardedTo: MOVED,
		});
		expect(statusOf(MOVED)).toMatchObject({ state: "bound", evidence: "journalMove", resolves: true });
		expect(statusOf(CART)).toMatchObject({ state: "none", forwardedTo: MOVED, evidence: "journalMove" });
		expect(journaledRebinds()).toBe(1);
		expect(await dispatch("refactorStatus", {})).toMatchObject({ steps: [{ stepNo: 1, phase: "finalized" }] });
	});

	// The fixture declares neither references nor imports, so nothing found this file's importer.
	it("says importers were never looked for when the provider reports no references", async () => {
		put("c.ref", 'import { Cart } from "./a";\n');
		await service.indexFile("c.ref");

		const outcome = await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		expect(outcome).toMatchObject({
			moved: true,
			issues: expect.arrayContaining([expect.objectContaining({ kind: "ImportersUnchecked", module: "a.ref" })]),
		});
		expect(read("c.ref")).toBe('import { Cart } from "./a";\n');
	});

	it("is put back by undo: the files, the address and the journal", async () => {
		await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		const undone = (await dispatch("refactorUndo", {})) as RefactorUndoResult;

		expect(undone).toMatchObject({ undone: true, stepNo: 1 });
		expect([...(undone.modules ?? [])].sort()).toEqual(["a.ref", "b.ref"]);
		expect("unreversed" in undone).toBe(false);
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(read("b.ref")).toBeNull();
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(statusOf(MOVED)).toMatchObject({ state: "none", forwardedTo: null });
		expect(journaledRebinds()).toBe(0);
	});

	it("is put back by revert along with every tracked file", async () => {
		await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		const reverted = await dispatch("refactorRevert", {});

		expect(reverted).toMatchObject({ reverted: true });
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(read("b.ref")).toBeNull();
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(CART)).toMatchObject({
			state: "bound",
			evidence: "sameLocator",
			fromSymbolId: null,
		});
		expect(statusOf(MOVED)).toMatchObject({ state: "none", forwardedTo: null });
		expect(journaledRebinds()).toBe(0);
	});

	it("is refused by the provider when the destination already declares the name, and both subjects stand", async () => {
		put("b.ref", "export class Cart {}\n");
		await service.indexFile("b.ref");
		await record(MOVED, "The other cart.");

		const outcome = await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		expect(outcome).toMatchObject({ moved: false, reason: expect.stringContaining("b.ref: TargetCollision") });
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.answer(MOVED, "describe")?.prose).toBe("The other cart.");
		expect(journaledRebinds()).toBe(0);
	});
});

describe("a rename through the daemon's handlers", () => {
	it("rebinds the subject to the re-minted id with the rename as evidence", async () => {
		const outcome = await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });

		expect(outcome).toMatchObject({ renamed: true, migrated: { answers: 1, gaps: 0 } });
		expect(read("a.ref")).toBe("export class Basket {}\n");
		expect(store.answer(RENAMED, "describe")?.prose).toBe("A shopping cart.");
		expect(statusOf(RENAMED)).toMatchObject({ state: "bound", evidence: "journalRename", resolves: true });
		expect(statusOf(CART)).toMatchObject({ state: "none", forwardedTo: RENAMED });
		expect(store.subjects.forAddress(RENAMED)).toMatchObject({ fromSymbolId: CART });
		expect(await dispatch("diagnoseSubject", { symbolId: CART })).toMatchObject({
			kind: "moved",
			forwardedTo: RENAMED,
		});
		expect(journaledRebinds()).toBe(1);
	});

	it("is put back by undo", async () => {
		await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });

		const undone = await dispatch("refactorUndo", {});

		expect(undone).toMatchObject({ undone: true, modules: ["a.ref"] });
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(statusOf(RENAMED)).toMatchObject({ state: "none", forwardedTo: null });
		expect(store.subjects.forAddress(CART)).toMatchObject({
			state: "bound",
			evidence: "sameLocator",
			fromSymbolId: null,
		});
		expect(journaledRebinds()).toBe(0);
	});

	it("is put back by revert", async () => {
		await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });

		const reverted = await dispatch("refactorRevert", {});

		expect(reverted).toMatchObject({ reverted: true, modules: ["a.ref"] });
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(store.answer(CART, "describe")?.prose).toBe("A shopping cart.");
		expect(store.subjects.forAddress(CART)).toMatchObject({
			state: "bound",
			evidence: "sameLocator",
			fromSymbolId: null,
		});
		expect(statusOf(RENAMED)).toMatchObject({ state: "none", forwardedTo: null });
		expect(journaledRebinds()).toBe(0);
	});

	it("is refused with the provider's reason for a name that is not an identifier", async () => {
		const outcome = await dispatch("refactorRename", { symbolId: CART, newName: "not a name" });

		expect(outcome).toMatchObject({ renamed: false, reason: expect.stringContaining("InvalidName") });
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(statusOf(CART)).toMatchObject({ state: "bound", evidence: "sameLocator" });
	});
});
