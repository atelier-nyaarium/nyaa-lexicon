// The journaled rebind, driven through the daemon's own handlers against a provider that moves.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bunCommand } from "@nyaa-lexicon/client";
import { applyEdits, hashContent, type RefactorUndoResult, type ResponseOf } from "@nyaa-lexicon/protocol";
import { createDispatch, daemonHandlers, type Gate } from "../dispatch";
import { lexiconRoot } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { hashBytes, TransactionManager } from "../transactions";

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
let transactions: TransactionManager;
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

/** A gate that runs `between` after planning and before the step's hold. */
function gateAfter(between: () => void): Gate {
	return {
		read: async (work) => work(),
		write: async (work) => {
			between();
			return work();
		},
	};
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-fixture-refactor-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
	const launch = bunCommand(
		{ kind: "bun", executable: process.execPath, version: Bun.version },
		{ platform: process.platform, env: { XDG_STATE_HOME: root }, home: root },
	);
	await supervisor.start({ command: [...launch, "run", FIXTURE], timeoutMs: 30_000 }, root);
	service = new LexiconService(store, supervisor, sourceReader(root), root);
	transactions = new TransactionManager(store, root);
	dispatch = createDispatch(service, { transactions });
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
	it("previews the exact files the move writes", async () => {
		const before = new Map(["a.ref", "b.ref"].map((module) => [module, read(module)]));
		const status = transactions.status();
		const preview = (await dispatch("previewMove", {
			symbolId: CART,
			toModule: "b.ref",
		})) as ResponseOf<"previewMove">;

		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.reason);
		const copy = new Map(before);
		for (const file of preview.files) {
			const prior = before.get(file.module) ?? null;
			expect(file.contentHash).toBe(prior === null ? null : hashContent(prior));
			expect(file.created).toBe(prior === null);
			expect(applyEdits(prior ?? "", file.edits)).toEqual({ text: file.text });
			copy.set(file.module, file.text);
		}
		expect(new Map(["a.ref", "b.ref"].map((module) => [module, read(module)]))).toEqual(before);
		expect(transactions.status()).toEqual(status);

		const outcome = (await dispatch("refactorMove", {
			symbolId: CART,
			toModule: "b.ref",
		})) as ResponseOf<"refactorMove">;
		expect(outcome.moved).toBe(true);
		for (const file of preview.files) expect(read(file.module)).toBe(copy.get(file.module) ?? null);
	}, 60_000);

	it("reports a refused target as a blocker", async () => {
		put("b.ref", "export class Cart {}\n");
		await service.indexFile("b.ref");
		const preview = (await dispatch("previewMove", {
			symbolId: CART,
			toModule: "b.ref",
		})) as ResponseOf<"previewMove">;

		expect(preview.ok).toBe(false);
		if (preview.ok) throw new Error("colliding target preview succeeded");
		expect(preview.blockers.length).toBeGreaterThan(0);
		expect(preview.reason).toContain("TargetCollision");
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(read("b.ref")).toBe("export class Cart {}\n");
	}, 60_000);

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

	it("is refused inside the gate when the target changed after planning, and the target keeps its bytes", async () => {
		put("b.ref", "export class Other {}\n");
		await service.indexFile("b.ref");
		const handlers = daemonHandlers(service, { transactions });
		const late = "export class Other {}\nexport const late = 1\n";

		const outcome = await handlers.refactorMove.run(
			{ symbolId: CART, toModule: "b.ref" },
			gateAfter(() => put("b.ref", late)),
		);

		expect(outcome).toMatchObject({ moved: false, reason: expect.stringContaining("b.ref") });
		expect(read("b.ref")).toBe(late);
		expect(read("a.ref")).toBe("export class Cart {}\n");
	});

	it("is refused inside the gate when a target planned as absent appeared", async () => {
		const handlers = daemonHandlers(service, { transactions });
		const late = "export const late = 1\n";

		const outcome = await handlers.refactorMove.run(
			{ symbolId: CART, toModule: "b.ref" },
			gateAfter(() => put("b.ref", late)),
		);

		expect(outcome).toMatchObject({ moved: false, reason: expect.stringContaining("b.ref") });
		expect(read("b.ref")).toBe(late);
		expect(read("a.ref")).toBe("export class Cart {}\n");
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

describe("read-only refactor previews", () => {
	it("previews the exact insert text and leaves disk and transaction state alone", async () => {
		const before = read("a.ref");
		const status = transactions.status();
		const preview = (await dispatch("previewInsert", {
			module: "a.ref",
			text: "export const Extra = 1",
		})) as ResponseOf<"previewInsert">;

		expect(preview.state).toBe("planned");
		if (preview.state !== "planned") {
			throw new Error(preview.state === "refused" ? preview.reason : "insert is already present");
		}
		const copy = new Map([["a.ref", before]]);
		copy.set(preview.module, preview.text);
		expect(preview.contentHash).toBe(hashContent(before as string));
		expect(preview.created).toBe(false);
		expect(applyEdits(before as string, preview.edits)).toEqual({ text: preview.text });
		expect(read("a.ref")).toBe(before);
		expect(transactions.status()).toEqual(status);

		const outcome = (await dispatch("refactorInsert", {
			module: "a.ref",
			text: "export const Extra = 1",
		})) as ResponseOf<"refactorInsert">;
		expect(outcome.inserted).toBe(true);
		expect(read("a.ref")).toBe(copy.get("a.ref") ?? null);
	}, 60_000);

	it("does not open a transaction", async () => {
		await dispatch("refactorCommit", {});
		expect(transactions.status().open).toBe(false);
		await dispatch("previewMove", { symbolId: CART, toModule: "b.ref" });
		await dispatch("previewInsert", { module: "a.ref", text: "export const Extra = 1" });
		expect(transactions.status().open).toBe(false);
		expect(await dispatch("refactorBeforeImage", { module: "a.ref" })).toEqual({ tracked: false });
	}, 60_000);

	it("returns the tracked before-image for edited, created and untracked modules", async () => {
		const original = read("a.ref") as string;
		await dispatch("refactorTrack", { module: "a.ref" });
		put("a.ref", "export class Changed {}\n");
		await dispatch("refactorTrack", { module: "created.ref" });
		put("created.ref", "created later\n");
		const binary = Buffer.from([0, 255, 1]);
		writeFileSync(path.join(root, "binary.ref"), binary);
		await dispatch("refactorTrack", { module: "binary.ref" });
		writeFileSync(path.join(root, "binary.ref"), Buffer.from("changed"));

		expect(await dispatch("refactorBeforeImage", { module: "a.ref" })).toEqual({
			tracked: true,
			existed: true,
			contentHash: hashContent(original),
			encoding: "text",
			text: original,
		});
		expect(await dispatch("refactorBeforeImage", { module: "created.ref" })).toEqual({
			tracked: true,
			existed: false,
		});
		expect(await dispatch("refactorBeforeImage", { module: "binary.ref" })).toEqual({
			tracked: true,
			existed: true,
			contentHash: hashBytes(binary),
			encoding: "base64",
			bytes: binary.toString("base64"),
		});
		expect(await dispatch("refactorBeforeImage", { module: "untracked.ref" })).toEqual({ tracked: false });
		expect(await dispatch("refactorBeforeImage", { module: "a.ref", id: transactions.status().id })).toMatchObject({
			tracked: true,
		});
		expect(await dispatch("refactorBeforeImage", { module: "a.ref", id: "rt-another" })).toEqual({
			tracked: false,
		});
	}, 60_000);
});

describe("acting on the refactor that was shown", () => {
	it("refuses undo, revert and commit shown an older refactor, and changes nothing", async () => {
		const shown = transactions.status();
		const id = shown.id as string;
		const revision = shown.revision as number;
		await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });

		expect(await dispatch("refactorUndo", { expect: { id, revision } })).toMatchObject({ undone: false });
		expect(await dispatch("refactorRevert", { expect: { id, revision } })).toMatchObject({ reverted: false });
		expect(await dispatch("refactorCommit", { expect: { id: "rt-another", revision } })).toMatchObject({
			committed: false,
		});
		expect(read("a.ref")).toBe("export class Basket {}\n");
		const current = transactions.status();
		expect(current).toMatchObject({ open: true, id, steps: [{ stepNo: 1 }] });
		if (current.revision === undefined) throw new Error("open transaction has no revision");

		expect(await dispatch("refactorUndo", { expect: { id, revision: current.revision } })).toMatchObject({
			undone: true,
		});
		expect(read("a.ref")).toBe("export class Cart {}\n");
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
