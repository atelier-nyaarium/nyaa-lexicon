import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CommittedFile, hashContent, type IndexOutcome } from "@nyaa-lexicon/protocol";
import {
	journaledStep,
	type PlannedStep,
	type PlannedWrite,
	type RefusedWith,
	type StepHold,
	type StepPolicy,
} from "../refactorStep";
import { changedWhilePlanned } from "../refusals";
import type { LexiconService } from "../service";
import { IndexStore } from "../store";
import { type RefactorIssue, type StepPhase, TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let transactions: TransactionManager;
let reindexed: string[];
let failReindexOf: string | null;
/** A module's index answer; absent, it indexes. */
let answers: Map<string, IndexOutcome>;
/** Ids the reindexed facts do not declare. */
let undeclared: Set<string>;
/** Runs before the `base` check. */
let beforeWrite: ((module: string) => void) | null;
/** The workspace's fix; null runs none. */
let fixer: ((modules: string[]) => { ran: boolean; failed: string | null }) | null;

interface Outcome {
	ok: boolean;
	issues: RefactorIssue[];
	reason?: string;
	why?: RefusedWith | undefined;
	hold?: StepHold;
	files?: CommittedFile[];
}

function write(module: string, text: string) {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function read(module: string): string | null {
	try {
		return readFileSync(path.join(root, module), "utf8");
	} catch {
		return null;
	}
}

function hashOf(module: string): string | null {
	const text = read(module);
	return text === null ? null : hashContent(text);
}

/** Only what the executor asks of the service. */
const service = {
	upgradeRemaining: async () => {},
	during: (_doing: unknown, work: () => Promise<unknown>) => work(),
	indexFile: async (module: string) => {
		if (module === failReindexOf) throw new Error("provider gone");
		reindexed.push(module);
		return answers.get(module) ?? { module, action: "indexed" };
	},
	oweParses: (modules: readonly string[]) => store.oweRebinds(modules),
	payOwed: () => {},
	declarationOf: (symbolId: string) => (undeclared.has(symbolId) ? null : { symbolId }),
	currentHashOf: hashOf,
	writeModule: (module: string, text: string, base: string | null) => {
		beforeWrite?.(module);
		if (hashOf(module) !== base) return false;
		write(module, text);
		return true;
	},
	fixWritten: async (modules: string[]) => fixer?.(modules) ?? { ran: false, failed: null },
} as unknown as LexiconService;

function over(module: string, before: string, text: string): PlannedWrite {
	return { module, base: hashContent(before), text };
}

function run(parts: Partial<PlannedStep> = {}, hold: StepPolicy = "join"): Promise<Outcome> {
	return journaledStep<Outcome>(
		{ service, transactions, write: (work) => Promise.resolve(work()) },
		{
			kind: "replace",
			hold,
			refuse: (reason, issues, why) => ({ ok: false, issues, reason, why }),
			succeed: (issues, hold, files) => ({ ok: true, issues, hold, files }),
			plan: async () => ({
				planned: {
					modules: ["src/a.ts"],
					writes: [over("src/a.ts", "before\n", "after\n")],
					stale: () => null,
					reindex: ["src/a.ts"],
					issues: [],
					...parts,
				},
			}),
		},
	);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-step-"));
	store = IndexStore.open(path.join(root, ".index.sqlite")).store;
	transactions = new TransactionManager(store, root);
	reindexed = [];
	failReindexOf = null;
	answers = new Map();
	undeclared = new Set();
	beforeWrite = null;
	fixer = null;
	write("src/a.ts", "before\n");
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the addresses a step re-mints", () => {
	const from = "lexicon reference src/a.ts Cart#";
	const to = "lexicon reference src/b.ts Cart#";
	const rebind = () => ({ entries: [{ from, to }], evidence: "journalMove" as const });
	const mint = (address: string) => store.noteWrite(() => store.subjects.mint(address, 1));

	it("are rebound once every reindex succeeded, and reported through finish", async () => {
		transactions.start();
		mint(from);
		let reported: unknown;
		const outcome = await run({
			rebind,
			finish: (_issues, rebound) => {
				reported = rebound;
			},
		});

		expect(outcome.ok).toBe(true);
		expect(reported).toMatchObject({ subjects: 1 });
		expect(store.subjects.forAddress(to)?.evidence).toBe("journalMove");
		expect(store.subjects.forAddress(from)).toBeNull();
	});

	// The journal is the evidence; the index catching up is a separate matter the issue names.
	it("are rebound even when a reindex failed, and the step says the facts are stale", async () => {
		transactions.start();
		mint(from);
		failReindexOf = "src/a.ts";
		const outcome = await run({ rebind });

		expect(outcome.ok).toBe(true);
		expect(outcome.issues.map((issue) => issue.kind)).toContain("ReindexFailed");
		expect(store.subjects.forAddress(to)?.evidence).toBe("journalMove");
		expect(store.subjects.forAddress(from)).toBeNull();
	});

	it("keep their knowledge where another subject holds the new address, and the step says so", async () => {
		transactions.start();
		const moving = mint(from);
		mint(to);
		const outcome = await run({ rebind });

		expect(outcome.issues.map((issue) => issue.kind)).toEqual(["KnowledgeKept"]);
		expect(store.subjects.forAddress(from)?.subjectId).toBe(moving.subjectId);
	});

	// A fix command may change a declaration after the plan; its knowledge then has nowhere to go.
	it("keep their knowledge where the reindexed step declares no new address, and the step says so", async () => {
		transactions.start();
		mint(from);
		undeclared.add(to);
		const outcome = await run({ rebind });

		expect(outcome.issues.map((issue) => issue.kind)).toEqual(["KnowledgeKept"]);
		expect(store.subjects.forAddress(from)).not.toBeNull();
		expect(store.subjects.forAddress(to)).toBeNull();
	});
});

describe("reindexing what a step wrote", () => {
	it("says a parse that did not land, and leaves it owed", async () => {
		transactions.start();
		answers.set("src/a.ts", {
			module: "src/a.ts",
			action: "skipped",
			cause: "providerDown",
			reason: "provider unavailable",
			failure: "provider gone",
		});
		const outcome = await run();

		expect(outcome.issues).toEqual([expect.objectContaining({ kind: "ReindexFailed", module: "src/a.ts" })]);
		expect(store.owedRebindAfter(null)).toBe("src/a.ts");
	});

	it("takes a written file that is gone as reindexed, since no fact of it is left stale", async () => {
		transactions.start();
		answers.set("src/a.ts", { module: "src/a.ts", action: "forgotten", cause: "missing", reason: "file is gone" });
		const outcome = await run();

		expect(outcome).toMatchObject({ ok: true, issues: [] });
	});
});

describe("the workspace's fix command", () => {
	it("runs inside the step, so its output is the step's after-image and undo restores the original", async () => {
		transactions.start();
		fixer = (modules) => {
			for (const module of modules) write(module, `${read(module)}// fixed\n`);
			return { ran: true, failed: null };
		};
		const outcome = await run();
		const undone = transactions.undo();

		expect({
			ok: outcome.ok,
			after: outcome.files?.[0]?.after,
			undone: undone.undone,
			text: read("src/a.ts"),
		}).toEqual({ ok: true, after: hashContent("after\n// fixed\n"), undone: true, text: "before\n" });
	});

	it("keeps the step when the fix fails, and says so", async () => {
		transactions.start();
		fixer = () => ({ ran: true, failed: "exited with 1" });
		const outcome = await run();

		expect({ ok: outcome.ok, kinds: outcome.issues.map((issue) => issue.kind), text: read("src/a.ts") }).toEqual({
			ok: true,
			kinds: ["FixFailed"],
			text: "after\n",
		});
	});

	it("names a written file the fix deleted, and keeps the planned after-image", async () => {
		transactions.start();
		fixer = (modules) => {
			for (const module of modules) rmSync(path.join(root, module));
			return { ran: true, failed: null };
		};
		const outcome = await run();

		expect({
			ok: outcome.ok,
			issues: outcome.issues.map((issue) => [issue.kind, issue.module]),
			after: outcome.files?.[0]?.after,
		}).toEqual({ ok: true, issues: [["FixFailed", "src/a.ts"]], after: hashContent("after\n") });
	});
});

describe("the one failure policy every operation now shares", () => {
	it("refuses without an open transaction, before planning anything", async () => {
		const outcome = await run();

		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toMatch(/no refactor transaction/);
		expect(read("src/a.ts")).toBe("before\n");
	});

	it("refuses a stale world or a moved base inside the gate with nothing journaled", async () => {
		transactions.start();
		const stale = await run({ stale: () => changedWhilePlanned("src/a.ts", "step") });
		const moved = await run({ writes: [over("src/a.ts", "older\n", "after\n")] });

		expect([stale, moved]).toMatchObject([
			{ ok: false, reason: expect.stringContaining("changed while the step was planned") },
			{ ok: false, reason: expect.stringContaining("src/a.ts changed while the replacement was planned") },
		]);
		expect({ steps: transactions.status().steps, text: read("src/a.ts") }).toEqual({ steps: [], text: "before\n" });
	});

	// Recheck `base` before writing.
	it("backs out a step whose file moved mid-write, restoring what it wrote and leaving the moved file alone", async () => {
		transactions.start();
		write("src/b.ts", "before b\n");
		beforeWrite = (module) => {
			if (module === "src/b.ts") write("src/b.ts", "saved by the editor\n");
		};
		const outcome = await run({
			modules: ["src/a.ts", "src/b.ts"],
			writes: [over("src/a.ts", "before\n", "after\n"), over("src/b.ts", "before b\n", "after b\n")],
			reindex: ["src/a.ts", "src/b.ts"],
		});

		expect({
			outcome,
			texts: [read("src/a.ts"), read("src/b.ts")],
			reindexed,
			status: transactions.status(),
		}).toMatchObject({
			outcome: {
				ok: false,
				reason: expect.stringContaining("src/b.ts changed while the replacement was planned"),
			},
			texts: ["before\n", "saved by the editor\n"],
			reindexed: ["src/a.ts"],
			status: { steps: [], tracked: ["src/a.ts"] },
		});
	});

	it("releases every module a refused step never wrote, so a later edit to one survives Revert", async () => {
		transactions.start();
		write("src/b.ts", "before b\n");
		beforeWrite = (module) => {
			if (module === "src/a.ts") write("src/a.ts", "saved by the editor\n");
		};
		const outcome = await run({
			modules: ["src/a.ts", "src/b.ts"],
			writes: [over("src/a.ts", "before\n", "after\n"), over("src/b.ts", "before b\n", "after b\n")],
			reindex: ["src/a.ts", "src/b.ts"],
		});
		beforeWrite = null;
		write("src/b.ts", "later owner edit\n");
		const status = transactions.status();
		transactions.revert(status.drifted);

		expect({ ok: outcome.ok, tracked: status.tracked, b: read("src/b.ts") }).toEqual({
			ok: false,
			tracked: [],
			b: "later owner edit\n",
		});
	});

	it("keeps a save landing between the write and its record as drift, so undo refuses instead of overwriting it", async () => {
		transactions = new (class extends TransactionManager {
			override completeStep(stepNo: number, phase: StepPhase): void {
				if (phase === "written") write("src/a.ts", "saved by the editor\n");
				super.completeStep(stepNo, phase);
			}
		})(store, root);
		transactions.start();
		const outcome = await run();

		expect({
			ok: outcome.ok,
			drifted: transactions.status().drifted.map((each) => each.module),
			undone: transactions.undo().undone,
			text: read("src/a.ts"),
		}).toEqual({ ok: true, drifted: ["src/a.ts"], undone: false, text: "saved by the editor\n" });
	});

	it("frames an unexpected write error as a write failure", async () => {
		transactions.start();
		beforeWrite = () => {
			throw new Error("EACCES");
		};
		const outcome = await run();

		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe("the replace could not be written: EACCES");
	});

	// The write LANDED: failing the call lies, and an unfinalized step arms a silent revert on
	// the next recovery. Success with a ReindexFailed issue lies in neither direction.
	it("finalizes a step whose reindex failed, saying so, and skips the verifier", async () => {
		transactions.start();
		failReindexOf = "src/a.ts";
		let finished = 0;
		const outcome = await run({
			finish: () => {
				finished++;
			},
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.issues.map((issue) => issue.kind)).toContain("ReindexFailed");
		// A verifier reading a half-reindexed store answers falsehoods in both directions.
		expect(finished).toBe(0);
		expect(transactions.status().steps).toEqual([
			{ stepNo: 1, kind: "replace", phase: "finalized", modules: ["src/a.ts"] },
		]);
	});

	it("runs finish only after a clean reindex, and keeps a finish failure as an issue", async () => {
		transactions.start();
		const clean = await run({
			finish: (issues) => {
				issues.push({ kind: "Landed", detail: "verified" });
			},
		});
		expect(clean.issues.map((issue) => issue.kind)).toContain("Landed");

		const failing = await run({
			writes: [over("src/a.ts", "after\n", "again\n")],
			finish: () => {
				throw new Error("verifier crashed");
			},
		});
		expect(failing.ok).toBe(true);
		expect(failing.issues.map((issue) => issue.kind)).toContain("FinishIncomplete");
	});

	// A failed write can leave text matching neither journal image. Undo refuses, so the executor reports the step.
	it("says so when a failed write cannot be undone", async () => {
		transactions.start();
		beforeWrite = () => {
			write("src/a.ts", "junk that matches neither image\n");
			throw new Error("boom");
		};
		const outcome = await run();

		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toMatch(/could not be written: boom/);
		expect(outcome.reason).toMatch(/journaled step remains/);
		expect(transactions.status().steps).toHaveLength(1);
	});
});

describe("a step that opens its own transaction when none is open", () => {
	it("opens a transaction of its own when none is open, and leaves none open once written", async () => {
		const outcome = await run({}, "joinOrOwn");

		expect(outcome).toMatchObject({ ok: true, hold: "own" });
		expect(read("src/a.ts")).toBe("after\n");
		expect(transactions.start().started).toBe(true);
	});

	it("closes its own transaction when journaling throws, and writes nothing", async () => {
		transactions = new (class extends TransactionManager {
			override beginStep(): never {
				throw new Error("EACCES");
			}
		})(store, root);
		const outcome = await run({}, "joinOrOwn");

		expect(outcome.ok).toBe(false);
		expect(read("src/a.ts")).toBe("before\n");
		expect(transactions.status().open).toBe(false);
	});

	it("writes into a transaction someone else opened, and leaves it theirs to undo or close", async () => {
		transactions.start();
		const outcome = await run({}, "joinOrOwn");

		expect(outcome).toMatchObject({ ok: true, hold: "joined" });
		expect(transactions.start().started).toBe(false);
		expect(transactions.undo().undone).toBe(true);
		expect(read("src/a.ts")).toBe("before\n");
	});

	it("closes its own transaction when refused inside the gate, and after a moved write it backed out", async () => {
		const stale = await run({ stale: () => changedWhilePlanned("src/a.ts", "step") }, "joinOrOwn");
		expect(stale.ok).toBe(false);
		expect(transactions.start().started).toBe(true);
		transactions.revert(transactions.status().drifted);

		beforeWrite = () => write("src/a.ts", "saved by the editor\n");
		const failed = await run({}, "joinOrOwn");
		expect(failed.ok).toBe(false);
		expect(read("src/a.ts")).toBe("saved by the editor\n");
		expect(transactions.start().started).toBe(true);
	});

	it("closes its own transaction when a failed write cannot be undone, leaving the file as found", async () => {
		beforeWrite = () => {
			write("src/a.ts", "junk that matches neither image\n");
			throw new Error("boom");
		};
		const outcome = await run({}, "joinOrOwn");

		expect(outcome.reason).toMatch(/could not be written: boom; src\/a\.ts matched neither image/);
		expect(read("src/a.ts")).toBe("junk that matches neither image\n");
		expect(transactions.start().started).toBe(true);
	});
});

describe("a step that commits its own transaction", () => {
	const before = hashContent("before\n");

	it("refuses while a refactor is open, naming it, and writes nothing", async () => {
		const open = transactions.start();
		const outcome = await run({}, { own: [] });

		expect(outcome).toMatchObject({ ok: false, why: { openRefactor: { id: open.id } } });
		expect(read("src/a.ts")).toBe("before\n");
		expect(transactions.status().steps).toEqual([]);
	});

	it("refuses a written module missing from its bases or off its hash, saying where it stands", async () => {
		for (const bases of [[], [{ module: "src/a.ts", contentHash: "0".repeat(32) }]]) {
			const outcome = await run({}, { own: bases });

			expect(outcome).toMatchObject({
				ok: false,
				why: { unexpected: [{ module: "src/a.ts", contentHash: before }] },
			});
			expect(read("src/a.ts")).toBe("before\n");
			expect(transactions.status().open).toBe(false);
		}
	});

	it("takes extra bases and needs none for a module it only reindexes, and answers what it wrote", async () => {
		write("src/b.ts", "bound\n");
		const outcome = await run(
			{ modules: ["src/a.ts", "src/b.ts"], reindex: ["src/b.ts"] },
			{
				own: [
					{ module: "src/a.ts", contentHash: before },
					{ module: "src/unrelated.ts", contentHash: null },
				],
			},
		);

		expect(outcome).toMatchObject({
			ok: true,
			hold: "own",
			files: [{ module: "src/a.ts", before, after: hashContent("after\n") }],
		});
		expect(transactions.status().open).toBe(false);
	});
});
