// Committed rename and move, driven through the daemon's own handlers against a provider that moves.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bunCommand } from "@nyaa-lexicon/client";
import {
	type CommittedStep,
	DAEMON_METHODS,
	hashContent,
	type RequestOf,
	type ResponseOf,
	type StepBase,
	type StepPhase,
} from "@nyaa-lexicon/protocol";
import { createDispatch, daemonHandlers, type Gate, gateOf } from "../dispatch";
import { lexiconRoot } from "../providers";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";
import { type StepOutcome, TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

const FIXTURE = path.join(lexiconRoot(), "protocol", "src", "conformance", "fixtureProvider.ts");

const ORIGINAL = "export class Cart {}\n";

const CART = "lexicon reference a.ref Cart#";
const MOVED = "lexicon reference b.ref Cart#";
const RENAMED = "lexicon reference a.ref Basket#";

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;
let service: LexiconService;
let transactions: TransactionManager;
let dispatch: ReturnType<typeof createDispatch>;

/** The process dies after the write lands and before the journal records it. */
class CrashAfterWrite extends TransactionManager {
	private dead = false;

	override completeStep(stepNo: number, phase: StepPhase): void {
		if (phase === "written") this.dead = true;
		if (this.dead) throw new Error("the daemon died");
		super.completeStep(stepNo, phase);
	}

	override openTransaction(): ReturnType<TransactionManager["openTransaction"]> {
		if (this.dead) throw new Error("the daemon died");
		return super.openTransaction();
	}
}

/** The journal throws at the named point, as a failed read or write of it would. */
class ThrowsAt extends TransactionManager {
	constructor(
		store: IndexStore,
		root: string,
		private readonly at: "beginStep" | "written",
	) {
		super(store, root);
	}

	override beginStep(...args: Parameters<TransactionManager["beginStep"]>): StepOutcome {
		if (this.at === "beginStep") throw new Error("EACCES");
		return super.beginStep(...args);
	}

	override completeStep(stepNo: number, phase: StepPhase): void {
		if (this.at === "written" && phase === "written") throw new Error("SQLITE_IOERR");
		super.completeStep(stepNo, phase);
	}
}

function put(module: string, text: string): void {
	writeFileSync(path.join(root, module), text);
}

function read(module: string): string | null {
	const full = path.join(root, module);
	return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function prose(symbolId: string): string | undefined {
	return store.answer(symbolId, "describe")?.prose;
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

/** The handler's raw answer, which must survive its own schema whole. */
async function committed<M extends "refactorRenameCommitted" | "refactorMoveCommitted">(
	method: M,
	params: RequestOf<M>,
	gate: Gate = gateOf(service.gate),
	manager: TransactionManager = transactions,
): Promise<CommittedStep> {
	const handler = daemonHandlers(service, { transactions: manager })[method];
	const raw = (await handler.run(DAEMON_METHODS[method].request.parse(params) as never, gate)) as CommittedStep;
	expect(DAEMON_METHODS[method].response.parse(raw)).toEqual(raw);
	return raw;
}

/** What `renameEdits` showed, as the bases a client journals. */
async function renameBases(symbolId: string, newName: string): Promise<StepBase[]> {
	const planned = (await dispatch("renameEdits", { symbolId, newName })) as ResponseOf<"renameEdits">;
	if (!planned.ok) throw new Error(planned.reason);
	return planned.files.map((file) => ({ module: file.module, contentHash: file.contentHash }));
}

/** What `previewMove` showed, as the bases a client journals. */
async function moveBases(symbolId: string, toModule: string): Promise<StepBase[]> {
	const preview = (await dispatch("previewMove", { symbolId, toModule })) as ResponseOf<"previewMove">;
	if (!preview.ok) throw new Error(preview.reason);
	return preview.files.map((file) => ({ module: file.module, contentHash: file.contentHash }));
}

function onDisk(outcome: CommittedStep): Array<{ module: string; after: string | null }> {
	if (!outcome.committed) throw new Error(outcome.reason);
	return outcome.files.map((file) => {
		const text = read(file.module);
		return { module: file.module, after: text === null ? null : hashContent(text) };
	});
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-committed-step-"));
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
	put("a.ref", ORIGINAL);
	await service.indexFile("a.ref");
	const cited = store.declaration(CART)?.factId as string;
	const recorded = await service.recordAnswer(CART, "describe", "A shopping cart.", [cited]);
	if (!recorded.recorded) throw new Error(recorded.reason);
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a committed step with no refactor open", () => {
	it("renames, leaves no refactor open, and answers what it wrote, what it re-minted and how to put it back", async () => {
		const outcome = await committed("refactorRenameCommitted", {
			symbolId: CART,
			newName: "Basket",
			bases: await renameBases(CART, "Basket"),
		});

		expect(outcome).toMatchObject({
			committed: true,
			kind: "rename",
			symbolId: RENAMED,
			files: [{ module: "a.ref", before: hashContent(ORIGINAL) }],
			forwarded: [{ from: CART, to: RENAMED }],
			reverse: { kind: "rename", symbolId: RENAMED, newName: "Cart" },
			migrated: { answers: 1, gaps: 0 },
		});
		expect(outcome.committed && outcome.files).toMatchObject(onDisk(outcome));
		expect(read("a.ref")).toBe("export class Basket {}\n");
		expect(prose(RENAMED)).toBe("A shopping cart.");
		expect(transactions.status().open).toBe(false);
	});

	it("moves into a new module and answers both files, the created one with no before", async () => {
		const outcome = await committed("refactorMoveCommitted", {
			symbolId: CART,
			toModule: "b.ref",
			bases: await moveBases(CART, "b.ref"),
		});

		expect(outcome).toMatchObject({
			committed: true,
			kind: "move",
			symbolId: MOVED,
			files: [
				{ module: "a.ref", before: hashContent(ORIGINAL) },
				{ module: "b.ref", before: null },
			],
			forwarded: [{ from: CART, to: MOVED }],
			reverse: { kind: "move", symbolId: MOVED, toModule: "a.ref" },
		});
		expect(outcome.committed && outcome.files).toMatchObject(onDisk(outcome));
		expect(prose(MOVED)).toBe("A shopping cart.");
		expect(transactions.status().open).toBe(false);
	});
});

describe("a committed step while a refactor is open", () => {
	it("refuses both methods naming the open refactor, and changes nothing", async () => {
		const renameShown = await renameBases(CART, "Basket");
		const moveShown = await moveBases(CART, "b.ref");
		const open = transactions.start();
		const status = transactions.status();

		const renamed = await committed("refactorRenameCommitted", {
			symbolId: CART,
			newName: "Basket",
			bases: renameShown,
		});
		const moved = await committed("refactorMoveCommitted", { symbolId: CART, toModule: "b.ref", bases: moveShown });

		for (const outcome of [renamed, moved]) {
			expect(outcome).toMatchObject({ committed: false, openRefactor: { id: open.id } });
		}
		expect(read("a.ref")).toBe(ORIGINAL);
		expect(read("b.ref")).toBeNull();
		expect(transactions.status()).toEqual(status);
	});

	it("refuses inside the gate when a refactor opened after planning, and writes nothing", async () => {
		let opened = "";
		const outcome = await committed(
			"refactorRenameCommitted",
			{ symbolId: CART, newName: "Basket", bases: await renameBases(CART, "Basket") },
			gateAfter(() => {
				opened = transactions.start().id;
			}),
		);

		expect(outcome).toMatchObject({ committed: false, openRefactor: { id: opened } });
		expect(read("a.ref")).toBe(ORIGINAL);
		expect(transactions.status()).toMatchObject({ open: true, id: opened, steps: [] });
	});
});

describe("the bases a committed step is held to", () => {
	it("refuses a written module missing from them or moved off its hash, naming where it stands", async () => {
		const shown = await moveBases(CART, "b.ref");
		const missing = await committed("refactorMoveCommitted", {
			symbolId: CART,
			toModule: "b.ref",
			bases: shown.filter((base) => base.module !== "b.ref"),
		});
		expect(missing).toMatchObject({ committed: false, unexpected: [{ module: "b.ref", contentHash: null }] });

		const edited = "export class Cart {}\nexport const extra = 1\n";
		put("a.ref", edited);
		await service.indexFile("a.ref");
		const moved = await committed("refactorMoveCommitted", { symbolId: CART, toModule: "b.ref", bases: shown });
		expect(moved).toMatchObject({
			committed: false,
			unexpected: [{ module: "a.ref", contentHash: hashContent(edited) }],
		});

		expect(read("a.ref")).toBe(edited);
		expect(read("b.ref")).toBeNull();
		expect(prose(CART)).toBe("A shopping cart.");
		expect(transactions.status().open).toBe(false);
	});

	it("takes more bases than the step writes", async () => {
		const outcome = await committed("refactorMoveCommitted", {
			symbolId: CART,
			toModule: "b.ref",
			bases: [...(await moveBases(CART, "b.ref")), { module: "c.ref", contentHash: null }],
		});

		expect(outcome).toMatchObject({ committed: true, symbolId: MOVED });
	});
});

describe("putting a committed step back through its reverse", () => {
	it("renames back to the original ids, knowledge and text, and forward again through the reverse's reverse", async () => {
		const forward = await committed("refactorRenameCommitted", {
			symbolId: CART,
			newName: "Basket",
			bases: await renameBases(CART, "Basket"),
		});
		if (!forward.committed || forward.reverse.kind !== "rename") throw new Error("the rename did not commit");

		const { symbolId, newName } = forward.reverse;
		const back = await committed("refactorRenameCommitted", {
			symbolId,
			newName,
			bases: await renameBases(symbolId, newName),
		});
		expect(back).toMatchObject({
			committed: true,
			symbolId: CART,
			forwarded: [{ from: RENAMED, to: CART }],
			reverse: { kind: "rename", symbolId: CART, newName: "Basket" },
		});
		expect(read("a.ref")).toBe(ORIGINAL);
		expect(prose(CART)).toBe("A shopping cart.");

		const again = await committed("refactorRenameCommitted", {
			symbolId: CART,
			newName: "Basket",
			bases: await renameBases(CART, "Basket"),
		});
		expect(again).toMatchObject({ committed: true, symbolId: RENAMED });
		expect(prose(RENAMED)).toBe("A shopping cart.");
	});

	it("moves back to the original ids and knowledge, naming the module it created, and forward again through the reverse's reverse", async () => {
		const forward = await committed("refactorMoveCommitted", {
			symbolId: CART,
			toModule: "b.ref",
			bases: await moveBases(CART, "b.ref"),
		});
		if (!forward.committed || forward.reverse.kind !== "move") throw new Error("the move did not commit");

		const { symbolId, toModule } = forward.reverse;
		const back = await committed("refactorMoveCommitted", {
			symbolId,
			toModule,
			bases: await moveBases(symbolId, toModule),
		});

		expect(back).toMatchObject({ committed: true, symbolId: CART, forwarded: [{ from: MOVED, to: CART }] });
		expect(prose(CART)).toBe("A shopping cart.");
		expect(store.declaration(MOVED)).toBeNull();
		if (!back.committed || back.reverse.kind !== "move") throw new Error("the move back did not commit");
		expect(back.files.find((file) => file.module === "b.ref")?.after).not.toBeNull();
		expect(read("b.ref")).not.toBeNull();

		const redo = back.reverse;
		const again = await committed("refactorMoveCommitted", {
			symbolId: redo.symbolId,
			toModule: redo.toModule,
			bases: await moveBases(redo.symbolId, redo.toModule),
		});
		expect(again).toMatchObject({
			committed: true,
			symbolId: MOVED,
			forwarded: [{ from: CART, to: MOVED }],
			reverse: { kind: "move", symbolId: MOVED, toModule: "a.ref" },
		});
		if (!again.committed) throw new Error(again.reason);
		expect(again.files).toMatchObject(onDisk(again));
		// Each file starts where the move back left it.
		const left = new Map(back.files.map((file) => [file.module, file.after]));
		expect(again.files.map((file) => [file.module, file.before])).toEqual([...left]);
		expect(prose(MOVED)).toBe("A shopping cart.");
		expect(store.declaration(CART)).toBeNull();
		expect(transactions.status().open).toBe(false);
	});
});

describe("a committed step the daemon died inside", () => {
	it("is closed by recovery, with the files put back and the knowledge where it was", async () => {
		const crashing = new CrashAfterWrite(store, root);
		const died = committed(
			"refactorRenameCommitted",
			{ symbolId: CART, newName: "Basket", bases: await renameBases(CART, "Basket") },
			gateOf(service.gate),
			crashing,
		);
		await expect(died).rejects.toThrow();
		expect(read("a.ref")).toBe("export class Basket {}\n");

		// As the daemon starts: recover, then reindex what came back.
		const recovered = new TransactionManager(store, root).recover();
		for (const module of recovered.restored) await service.indexFile(module);

		expect(recovered).toMatchObject({ restored: ["a.ref"], conflicts: [] });
		expect(transactions.status().open).toBe(false);
		expect(read("a.ref")).toBe(ORIGINAL);
		expect(store.declaration(CART)).not.toBeNull();
		expect(prose(CART)).toBe("A shopping cart.");
	});
});

describe("a committed step whose journal throws", () => {
	const rename = async (manager: TransactionManager) =>
		committed(
			"refactorRenameCommitted",
			{ symbolId: CART, newName: "Basket", bases: await renameBases(CART, "Basket") },
			gateOf(service.gate),
			manager,
		);

	it("is refused before it writes, and closes the refactor it opened so the next one commits", async () => {
		const outcome = await rename(new ThrowsAt(store, root, "beginStep"));

		expect(outcome).toMatchObject({ committed: false });
		expect(read("a.ref")).toBe(ORIGINAL);
		expect(transactions.status().open).toBe(false);
		expect(await rename(transactions)).toMatchObject({ committed: true, symbolId: RENAMED });
	});

	it("is refused after it writes, with the files put back and the knowledge where it was", async () => {
		const outcome = await rename(new ThrowsAt(store, root, "written"));

		expect(outcome).toMatchObject({ committed: false });
		expect(transactions.status().open).toBe(false);
		expect(read("a.ref")).toBe(ORIGINAL);
		expect(store.declaration(CART)).not.toBeNull();
		expect(prose(CART)).toBe("A shopping cart.");
	});
});

describe("a window save through the span replace", () => {
	it("still joins an open refactor, and still commits its own when none is", async () => {
		const span = async () => {
			const source = (await dispatch("symbolSource", { symbolId: CART })) as ResponseOf<"symbolSource">;
			if (!source.found || source.spanHash === undefined) throw new Error("no span to replace");
			return { symbolId: CART, expectedSpanHash: source.spanHash, standalone: true };
		};

		const own = await dispatch("refactorReplaceSpan", {
			...(await span()),
			newText: "export class Cart extends Bag",
		});
		expect(own).toMatchObject({ replaced: true, transaction: "own" });
		expect(transactions.status().open).toBe(false);

		transactions.start();
		const joined = await dispatch("refactorReplaceSpan", { ...(await span()), newText: "export class Cart" });
		expect(joined).toMatchObject({ replaced: true, transaction: "joined" });
		expect(transactions.status().steps).toHaveLength(1);
	});
});
