// The journaled rebind, driven through the daemon's own handlers against a provider that moves.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bunCommand } from "@nyaa-lexicon/client";
import {
	type ArrangeEditsRequest,
	applyEdits,
	hashBytes,
	hashContent,
	type Range,
	type RefactorUndoResult,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { createDispatch, daemonHandlers } from "../dispatch";
import { lexiconRoot } from "../providers";
import { recoverSteps } from "../refactorStep";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import type { Gate } from "../stepRunners";
import { IndexStore } from "../store";
import { ProviderSupervisor, ProviderUnavailableError } from "../supervisor";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

const FIXTURE = path.join(lexiconRoot(), "protocol", "src", "conformance", "fixtureProvider.ts");

const CART = "lexicon reference a.ref Cart#";
const MOVED = "lexicon reference b.ref Cart#";
const RENAMED = "lexicon reference a.ref Basket#";
const APPLE = "lexicon reference a.ref Apple#";
const APPLE_B = "lexicon reference b.ref Apple#";
const ZEBRA = "lexicon reference b.ref Zebra#";

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

function record(symbolId: string, text: string): void {
	const outcome = service.writeNote({ symbolId, text, expectedRevision: 0 });
	if (outcome.outcome === "refused") throw new Error(outcome.reason);
}

function noteAt(symbolId: string): string | undefined {
	return store.notes.byAddress(symbolId)?.text;
}

function journaledRebinds(): number {
	return (store.journal((db) => db.prepare("SELECT COUNT(*) AS n FROM refactor_rebinds").get()) as { n: number }).n;
}

function statusOf(symbolId: string) {
	return store.subjects.stateOf(symbolId, () => null);
}

/** A gate that runs `between` after planning and before the step's hold. */
function gateAfter(between: () => void | Promise<void>): Gate {
	return {
		read: async (work) => work(),
		write: async (work) => {
			await between();
			return work();
		},
	};
}

async function eventually(done: () => boolean): Promise<boolean> {
	for (let tries = 0; tries < 200 && !done(); tries++) await Bun.sleep(5);
	return done();
}

/** Starts the fixture provider and everything over it; `flags` go to the provider. */
async function open(flags: string[] = []): Promise<void> {
	supervisor = new ProviderSupervisor();
	const launch = bunCommand(
		{ kind: "bun", executable: process.execPath, version: Bun.version },
		{ platform: process.platform, env: { XDG_STATE_HOME: root }, home: root },
	);
	await supervisor.start({ command: [...launch, "run", FIXTURE, ...flags], timeoutMs: 30_000 }, root);
	service = new LexiconService(store, supervisor, sourceReader(root), root);
	transactions = new TransactionManager(store, root);
	dispatch = createDispatch(service, { transactions });
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-fixture-refactor-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	await open();
	put("a.ref", "export class Cart {}\n");
	await service.indexFile("a.ref");
	record(CART, "A shopping cart.");
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

	it("rebinds the subject with the move as evidence, and its note reads at the new address", async () => {
		const outcome = await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		expect(outcome).toMatchObject({ moved: true, toModule: "b.ref" });
		expect(read("b.ref")).toBe("export class Cart\n");
		expect(read("a.ref")).toBe(" {}\n");
		expect(store.declaration(CART)).toBeNull();
		expect(noteAt(MOVED)).toBe("A shopping cart.");
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
		expect(noteAt(CART)).toBe("A shopping cart.");
		expect(statusOf(MOVED)).toMatchObject({ state: "none", forwardedTo: null });
		expect(journaledRebinds()).toBe(0);
	});

	it("is put back by revert along with every tracked file", async () => {
		await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		const reverted = await dispatch("refactorRevert", { drifted: transactions.status().drifted });

		expect(reverted).toMatchObject({ reverted: true });
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(read("b.ref")).toBeNull();
		expect(noteAt(CART)).toBe("A shopping cart.");
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
		record(MOVED, "The other cart.");

		const outcome = await dispatch("refactorMove", { symbolId: CART, toModule: "b.ref" });

		expect(outcome).toMatchObject({ moved: false, reason: expect.stringContaining("b.ref: TargetCollision") });
		expect(noteAt(CART)).toBe("A shopping cart.");
		expect(noteAt(MOVED)).toBe("The other cart.");
		expect(journaledRebinds()).toBe(0);
	});
});

describe("a debt a stopped daemon left", () => {
	it("is paid by the next daemon's pump before any scan computed its scope", async () => {
		store.oweRebinds(["a.ref"]);
		const restarted = new LexiconService(store, supervisor, sourceReader(root), root);

		await recoverSteps(restarted, new TransactionManager(store, root));

		expect(await eventually(() => store.owedRebindAfter(null) === null)).toBe(true);
		expect(store.blockedRebinds()).toEqual([]);
	});
});

describe("restoring a file the index cannot read yet", () => {
	for (const operation of ["refactorUndo", "refactorRevert"] as const) {
		it(`${operation} names it, and the pump parses it later`, async () => {
			await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });
			// The rename's own pump run ends first, so only the restore's debt can start the next.
			await service.upgradeRemaining();
			const indexFile = service.indexFile.bind(service);
			// The handler's parse of a.ref finds its provider down; the pump's later one does not.
			service.indexFile = async (module, ...rest) =>
				module === "a.ref"
					? {
							module,
							action: "skipped",
							cause: "providerDown",
							reason: "provider unavailable",
							failure: "down",
						}
					: indexFile(module, ...rest);

			const outcome =
				operation === "refactorUndo"
					? await dispatch("refactorUndo", {})
					: await dispatch("refactorRevert", { drifted: transactions.status().drifted });

			expect(outcome).toMatchObject({
				issues: [expect.objectContaining({ kind: "ReindexFailed", module: "a.ref" })],
			});
			expect(read("a.ref")).toBe("export class Cart {}\n");
			expect(await eventually(() => store.declaration(CART) !== null)).toBe(true);
		});
	}
});

describe("moving several declarations together", () => {
	const BAG = "lexicon reference a.ref Bag#";
	const BOTH = "export class Cart {}\nexport class Bag {}\n";

	beforeEach(async () => {
		put("a.ref", BOTH);
		await service.indexFile("a.ref");
	});

	it("moves the set as one step where the provider arranges, naming them in order", async () => {
		const outcome = (await dispatch("refactorMove", {
			symbolId: CART,
			toModule: "b.ref",
			together: [BAG],
		})) as ResponseOf<"refactorMove">;

		expect({
			moved: outcome.moved,
			order: [...(outcome.order ?? [])].sort(),
			steps: transactions.status().steps.length,
		}).toEqual({ moved: true, order: ["Bag", "Cart"], steps: 1 });
	}, 60_000);

	describe("where the provider does not arrange", () => {
		beforeEach(async () => {
			supervisor.stopAll();
			await open(["--no-arrange"]);
			await service.indexFile("a.ref");
		});

		it("moves each in a step of its own and names them in order", async () => {
			const outcome = (await dispatch("refactorMove", {
				symbolId: CART,
				toModule: "b.ref",
				together: [BAG],
			})) as ResponseOf<"refactorMove">;

			expect({
				moved: outcome.moved,
				order: [...(outcome.order ?? [])].sort(),
				steps: transactions.status().steps.length,
			}).toEqual({ moved: true, order: ["Bag", "Cart"], steps: 2 });
		}, 60_000);

		it("still names what moved when a later member throws", async () => {
			const handlers = daemonHandlers(service, { transactions });
			let gated = 0;
			const outcome = await handlers.refactorMove.run(
				{ symbolId: CART, toModule: "b.ref", together: [BAG] },
				gateAfter(() => {
					gated += 1;
					if (gated === 2) throw new Error("the gate closed");
				}),
			);

			expect({
				moved: outcome.moved,
				order: outcome.order?.length,
				steps: transactions.status().steps.length,
			}).toEqual({
				moved: false,
				order: 1,
				steps: 1,
			});
		}, 60_000);
	});

	it("refuses declarations from two modules before writing anything", async () => {
		put("c.ref", "export class Box {}\n");
		await service.indexFile("c.ref");
		const outcome = (await dispatch("refactorMove", {
			symbolId: CART,
			toModule: "b.ref",
			together: ["lexicon reference c.ref Box#"],
		})) as ResponseOf<"refactorMove">;

		expect({ moved: outcome.moved, source: read("a.ref"), target: read("b.ref") }).toEqual({
			moved: false,
			source: BOTH,
			target: null,
		});
	}, 60_000);
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
		expect(await dispatch("refactorRevert", { expect: { id, revision }, drifted: shown.drifted })).toMatchObject({
			reverted: false,
		});
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
	/** A gate that indexes a new unrelated file before each of the first `times` holds. */
	function indexingElsewhere(times: number): { gate: Gate; holds: () => number } {
		let holds = 0;
		const gate = gateAfter(async () => {
			holds += 1;
			if (holds > times) return;
			put(`z${holds}.ref`, `export class Zebra${holds} {}\n`);
			await service.indexFile(`z${holds}.ref`);
		});
		return { gate, holds: () => holds };
	}

	/** Owes `module` a parse its provider is down for; the pump holds that debt until the provider answers. */
	async function holdDebtOf(module: string): Promise<void> {
		const ask = supervisor.askProvider.bind(supervisor);
		supervisor.askProvider = (async (providerId, method, params) =>
			method === "parseFile" && (params as { module: string }).module === module
				? Promise.reject(new ProviderUnavailableError("provider down"))
				: ask(providerId, method, params)) as typeof supervisor.askProvider;
		store.oweRebinds([module]);
		service.payOwed();
		const held = await eventually(() => store.blockedRebinds().some((debt) => debt.module === module));
		supervisor.askProvider = ask;
		if (!held) throw new Error(`no held debt on ${module}`);
	}

	it("refuses while a module its plan reads owes a parse a failure holds back", async () => {
		await holdDebtOf("a.ref");

		const outcome = await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });

		expect(outcome).toMatchObject({ renamed: false, reason: expect.stringContaining("a.ref") });
		expect(read("a.ref")).toBe("export class Cart {}\n");
	});

	it("refuses while a module its plan never read spells the old name and owes a held parse", async () => {
		put("z.ref", "export class Zebra {}\n\nexport const pick = Cart;\n");
		await service.indexFile("z.ref");
		await holdDebtOf("z.ref");

		const outcome = await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });

		expect(outcome).toMatchObject({ renamed: false, reason: expect.stringContaining("z.ref") });
		expect(read("a.ref")).toBe("export class Cart {}\n");
	});

	it("goes ahead past a held debt on a module its plan never reads", async () => {
		put("z.ref", "export class Zebra {}\n");
		await service.indexFile("z.ref");
		await holdDebtOf("z.ref");

		expect(await dispatch("refactorRename", { symbolId: CART, newName: "Basket" })).toMatchObject({
			renamed: true,
		});
	});

	it("plans again when only indexing elsewhere outran its plan, and lands", async () => {
		const { gate, holds } = indexingElsewhere(1);
		const outcome = await daemonHandlers(service, { transactions }).refactorRename.run(
			{ symbolId: CART, newName: "Basket" },
			gate,
		);

		expect(outcome).toMatchObject({ renamed: true });
		expect(holds()).toBe(2);
		expect(read("a.ref")).toBe("export class Basket {}\n");
	});

	it("refuses, to be tried again, when indexing elsewhere outruns every plan", async () => {
		const { gate, holds } = indexingElsewhere(Number.POSITIVE_INFINITY);
		const outcome = await daemonHandlers(service, { transactions }).refactorRename.run(
			{ symbolId: CART, newName: "Basket" },
			gate,
		);

		expect(outcome).toMatchObject({ renamed: false });
		expect(holds()).toBe(3);
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(transactions.status().steps).toEqual([]);
	});

	it("rebinds the subject to the re-minted id with the rename as evidence", async () => {
		const outcome = await dispatch("refactorRename", { symbolId: CART, newName: "Basket" });

		expect(outcome).toMatchObject({ renamed: true });
		expect(read("a.ref")).toBe("export class Basket {}\n");
		expect(noteAt(RENAMED)).toBe("A shopping cart.");
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
		expect(noteAt(CART)).toBe("A shopping cart.");
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

		const reverted = await dispatch("refactorRevert", { drifted: transactions.status().drifted });

		expect(reverted).toMatchObject({ reverted: true, modules: ["a.ref"] });
		expect(read("a.ref")).toBe("export class Cart {}\n");
		expect(noteAt(CART)).toBe("A shopping cart.");
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

describe("an anchored move", () => {
	async function files(entries: Record<string, string>): Promise<void> {
		for (const [module, text] of Object.entries(entries)) {
			put(module, text);
			await service.indexFile(module);
		}
	}

	it("lands beside the anchor in the target, framed by blank lines, whichever side names the spot", async () => {
		await files({ "a.ref": "export class Cart\n", "b.ref": "export class Apple\n\nexport class Zebra\n" });
		const landed: Array<string | undefined> = [];
		for (const anchor of [
			{ symbolId: APPLE_B, side: "after" },
			{ symbolId: ZEBRA, side: "before" },
		] as const) {
			const preview = (await dispatch("previewMove", {
				symbolId: CART,
				toModule: "b.ref",
				anchor,
			})) as ResponseOf<"previewMove">;
			if (!preview.ok) throw new Error(preview.reason);
			landed.push(preview.files.find((file) => file.module === "b.ref")?.text);
		}
		expect(landed).toEqual(Array(2).fill("export class Apple\n\nexport class Cart\n\nexport class Zebra\n"));
	}, 60_000);

	it("reorders within its own module, and its restore anchor puts it back", async () => {
		await files({ "a.ref": "export class Cart\n\nexport class Apple\n" });
		const anchor = { symbolId: APPLE, side: "after" } as const;
		const plan = (await dispatch("planMove", {
			symbolId: CART,
			toModule: "a.ref",
			anchor,
		})) as ResponseOf<"planMove">;
		if (!plan.ok) throw new Error(plan.reason);
		const moved = await dispatch("refactorMove", { symbolId: CART, toModule: "a.ref", anchor });
		const after = read("a.ref");
		const back = await dispatch("refactorMove", { symbolId: CART, toModule: "a.ref", anchor: plan.restore });

		expect({
			moved,
			after,
			back,
			restored: read("a.ref"),
			note: noteAt(CART),
		}).toMatchObject({
			moved: { moved: true },
			after: "export class Apple\n\nexport class Cart\n",
			back: { moved: true },
			restored: "export class Cart\n\nexport class Apple\n",
			note: "A shopping cart.",
		});
	}, 60_000);

	it("refuses an anchor outside the target or inside what moves, and a same-module move without one, naming declarations", async () => {
		await files({ "a.ref": "export class Cart\n\nexport class Apple\n", "b.ref": "export class Zebra\n" });
		const reasons: string[] = [];
		for (const request of [
			{ symbolId: CART, toModule: "b.ref", anchor: { symbolId: APPLE, side: "before" } },
			{ symbolId: CART, toModule: "a.ref", anchor: { symbolId: CART, side: "after" } },
			{ symbolId: CART, toModule: "a.ref" },
		] as const) {
			const preview = (await dispatch("previewMove", request)) as ResponseOf<"previewMove">;
			reasons.push(preview.ok ? "moved" : preview.reason);
		}

		expect(reasons.map((reason) => reason === "moved" || reason.includes(CART))).toEqual([false, false, false]);
		expect(read("a.ref")).toBe("export class Cart\n\nexport class Apple\n");
	}, 60_000);

	it("ends an unterminated last line before landing after it", async () => {
		await files({ "a.ref": "export class Cart\n", "b.ref": "export class Apple" });
		const preview = (await dispatch("previewMove", {
			symbolId: CART,
			toModule: "b.ref",
			anchor: { symbolId: APPLE_B, side: "after" },
		})) as ResponseOf<"previewMove">;
		if (!preview.ok) throw new Error(preview.reason);

		expect(preview.files.find((file) => file.module === "b.ref")?.text).toBe(
			"export class Apple\n\nexport class Cart\n",
		);
	}, 60_000);

	it("keeps a together move's order after an anchor", async () => {
		await files({ "a.ref": "export class Cart\n\nexport class Apple\n", "b.ref": "export class Zebra\n" });
		const outcome = (await dispatch("refactorMove", {
			symbolId: CART,
			toModule: "b.ref",
			together: [APPLE],
			anchor: { symbolId: ZEBRA, side: "after" },
		})) as ResponseOf<"refactorMove">;

		expect(outcome.moved).toBe(true);
		expect(read("b.ref")).toBe(
			["Zebra", ...(outcome.order ?? [])].map((name) => `export class ${name}\n`).join("\n"),
		);
	}, 60_000);
});

describe("an arrangement through the daemon's handlers", () => {
	const PEAR = "lexicon reference a.ref Pear#";
	const KIWI = "lexicon reference c.ref Kiwi#";
	const SOURCE = "export class Cart\n\nexport class Apple\n\nexport class Pear\n";
	const ARRANGED = {
		toModule: "b.ref",
		placements: [
			{ symbolId: CART, anchor: { symbolId: ZEBRA, side: "before" } },
			{ symbolId: APPLE, anchor: { symbolId: CART, side: "after" } },
		],
	};

	type Shown = Extract<ResponseOf<"previewArrange">, { ok: true }>;

	async function files(entries: Record<string, string>): Promise<void> {
		for (const [module, text] of Object.entries(entries)) {
			put(module, text);
			await service.indexFile(module);
		}
	}

	async function preview(request: object): Promise<Shown> {
		const answer = (await dispatch("previewArrange", request)) as ResponseOf<"previewArrange">;
		if (!answer.ok) throw new Error(answer.reason);
		return answer;
	}

	function expectOf(shown: Shown) {
		return shown.files.map(({ module, base, result }) => ({ module, base, result }));
	}

	it("writes exactly the previewed bytes as one step, and one Undo puts every file back", async () => {
		await files({ "a.ref": SOURCE, "b.ref": "export class Zebra\n" });
		const before = { a: read("a.ref"), b: read("b.ref") };
		const shown = await preview(ARRANGED);
		const unchanged = { a: read("a.ref"), b: read("b.ref") };
		const outcome = await dispatch("refactorArrange", { ...ARRANGED, expect: expectOf(shown) });
		const written = Object.fromEntries(shown.files.map((file) => [file.module, read(file.module)]));
		const note = noteAt(MOVED);
		await dispatch("refactorUndo", {});

		expect({
			texts: Object.fromEntries(shown.files.map((file) => [file.module, file.text])),
			bases: shown.files.map((file) => file.base),
			unchanged,
			outcome,
			written,
			note,
			undone: { a: read("a.ref"), b: read("b.ref") },
		}).toMatchObject({
			texts: {
				"b.ref": "export class Cart\n\nexport class Apple\n\nexport class Zebra\n",
				"a.ref": "export class Pear\n",
			},
			bases: [hashContent(before.b as string), hashContent(before.a as string)],
			unchanged: before,
			outcome: { moved: true },
			written: {
				"b.ref": "export class Cart\n\nexport class Apple\n\nexport class Zebra\n",
				"a.ref": "export class Pear\n",
			},
			note: "A shopping cart.",
			undone: before,
		});
	}, 60_000);

	it("refuses an apply whose preview no longer matches, and writes nothing", async () => {
		await files({ "a.ref": SOURCE, "b.ref": "export class Zebra\n" });
		const shown = await preview(ARRANGED);
		await files({ "b.ref": "export class Zebra\n\nexport class Kiwi\n" });
		const outcome = (await dispatch("refactorArrange", {
			...ARRANGED,
			expect: expectOf(shown),
		})) as ResponseOf<"refactorArrange">;

		expect({
			moved: outcome.moved,
			previewed: outcome.reason?.includes("previewed"),
			a: read("a.ref"),
			b: read("b.ref"),
		}).toEqual({ moved: false, previewed: true, a: SOURCE, b: "export class Zebra\n\nexport class Kiwi\n" });
	}, 60_000);

	it("previews and writes the formatter's text, which the fix command leaves alone", async () => {
		put("format.ts", 'process.stdout.write((await Bun.stdin.text()) + "\\n");\n');
		put("spoil.ts", 'for (const file of process.argv.slice(2)) await Bun.write(file, "spoiled\\n");\n');
		put(
			"lexicon.json",
			JSON.stringify({ fixText: [process.execPath, "format.ts"], fix: [process.execPath, "spoil.ts"] }),
		);
		await files({ "a.ref": SOURCE, "b.ref": "export class Zebra\n" });
		const shown = await preview(ARRANGED);
		await dispatch("refactorArrange", { ...ARRANGED, expect: expectOf(shown) });

		expect({ formatted: shown.formatted, a: read("a.ref"), b: read("b.ref") }).toEqual({
			formatted: true,
			a: "export class Pear\n\n",
			b: "export class Cart\n\nexport class Apple\n\nexport class Zebra\n\n",
		});
	}, 60_000);

	it("reorders a module's own declarations", async () => {
		await files({ "a.ref": SOURCE });
		const request = {
			toModule: "a.ref",
			placements: [{ symbolId: PEAR, anchor: { symbolId: CART, side: "before" } }],
		};
		const shown = await preview(request);
		const outcome = await dispatch("refactorArrange", { ...request, expect: expectOf(shown) });

		expect({ outcome, a: read("a.ref") }).toMatchObject({
			outcome: { moved: true },
			a: "export class Pear\n\nexport class Cart\n\nexport class Apple\n",
		});
	}, 60_000);

	it("applies an arrangement that changes nothing as no step", async () => {
		await files({ "a.ref": SOURCE });
		const request = {
			toModule: "a.ref",
			placements: [{ symbolId: PEAR, anchor: { symbolId: APPLE, side: "after" } }],
		};
		const shown = await preview(request);
		const status = transactions.status();
		const outcome = await dispatch("refactorArrange", { ...request, expect: expectOf(shown) });

		expect({ files: shown.files, outcome, a: read("a.ref"), status: transactions.status() }).toMatchObject({
			files: [],
			outcome: { moved: true },
			a: SOURCE,
			status,
		});
	}, 60_000);

	it("refuses a declaration placed twice, members of two modules, and an anchor placed later", async () => {
		await files({ "a.ref": SOURCE, "b.ref": "export class Zebra\n", "c.ref": "export class Kiwi\n" });
		const answers: boolean[] = [];
		for (const placements of [
			[{ symbolId: CART }, { symbolId: CART }],
			[{ symbolId: CART }, { symbolId: KIWI }],
			[{ symbolId: CART, anchor: { symbolId: APPLE, side: "after" } }, { symbolId: APPLE }],
		]) {
			const answer = (await dispatch("previewArrange", {
				toModule: "b.ref",
				placements,
			})) as ResponseOf<"previewArrange">;
			answers.push(answer.ok);
		}

		expect(answers).toEqual([false, false, false]);
	}, 60_000);

	it("refuses edits that leave a member declared where it was", async () => {
		await files({ "a.ref": SOURCE, "b.ref": "export class Zebra\n" });
		const probe = service.probe;
		const real = probe.arrangeEdits;
		// The source loses only its first member.
		probe.arrangeEdits = (module: string, request: ArrangeEditsRequest) =>
			module === "a.ref"
				? Promise.resolve({
						status: "ready" as const,
						edits: request.members
							.slice(0, 1)
							.map((member) => ({ range: member.removal as Range, newText: "" })),
						blocked: [],
					})
				: real(module, request);
		const answer = (await dispatch("previewArrange", ARRANGED)) as ResponseOf<"previewArrange">;
		probe.arrangeEdits = real;

		expect({ ok: answer.ok, a: read("a.ref") }).toEqual({ ok: false, a: SOURCE });
	}, 60_000);
});
