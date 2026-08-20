import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journaledStep, type PlannedStep, StepRefusal } from "../refactorStep";
import type { LexiconService } from "../service";
import { IndexStore } from "../store";
import { type RefactorIssue, TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let transactions: TransactionManager;
let reindexed: string[];
let failReindexOf: string | null;

interface Outcome {
	ok: boolean;
	issues: RefactorIssue[];
	reason?: string;
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

/** Only what the executor asks of the service. */
const service = {
	upgradeRemaining: async () => {},
	indexFile: async (module: string) => {
		if (module === failReindexOf) throw new Error("provider gone");
		reindexed.push(module);
		return { module, action: "indexed" };
	},
} as unknown as LexiconService;

function run(parts: Partial<PlannedStep> & Pick<PlannedStep, "apply">): Promise<Outcome> {
	return journaledStep<Outcome>(
		{ service, transactions, write: (work) => Promise.resolve(work()) },
		{
			kind: "replace",
			refuse: (reason, issues) => ({ ok: false, issues, reason }),
			succeed: (issues) => ({ ok: true, issues }),
			plan: async () => ({
				planned: {
					modules: ["src/a.ts"],
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
	write("src/a.ts", "before\n");
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the one failure policy every operation now shares", () => {
	it("refuses without an open transaction, before planning anything", async () => {
		const outcome = await run({ apply: () => write("src/a.ts", "after\n") });

		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toMatch(/no refactor transaction/);
		expect(read("src/a.ts")).toBe("before\n");
	});

	it("refuses a stale world inside the gate with nothing journaled", async () => {
		transactions.start();
		const outcome = await run({
			stale: () => "the world moved",
			apply: () => write("src/a.ts", "after\n"),
		});

		expect(outcome).toMatchObject({ ok: false, reason: "the world moved" });
		expect(transactions.status().steps).toEqual([]);
	});

	// The audit's zombie, generalized: a failed apply must remove its step AND repair the index
	// for whatever the undo restored; the helper-local undos never reindexed.
	it("undoes a failed apply, reindexes the restored files, and passes the refusal through", async () => {
		transactions.start();
		const outcome = await run({
			apply: () => {
				write("src/a.ts", "half-written\n");
				throw new StepRefusal("the provider said no");
			},
		});

		expect(outcome).toMatchObject({ ok: false, reason: "the provider said no" });
		expect(read("src/a.ts")).toBe("before\n");
		expect(reindexed).toEqual(["src/a.ts"]);
		expect(transactions.status().steps).toEqual([]);
	});

	it("frames an unexpected apply error as a write failure", async () => {
		transactions.start();
		const outcome = await run({
			apply: () => {
				throw new Error("EACCES");
			},
		});

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
			apply: () => write("src/a.ts", "after\n"),
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
			apply: () => write("src/a.ts", "after\n"),
			finish: (issues) => {
				issues.push({ kind: "Landed", detail: "verified" });
			},
		});
		expect(clean.issues.map((issue) => issue.kind)).toContain("Landed");

		const failing = await run({
			apply: () => write("src/a.ts", "again\n"),
			finish: () => {
				throw new Error("verifier crashed");
			},
		});
		expect(failing.ok).toBe(true);
		expect(failing.issues.map((issue) => issue.kind)).toContain("FinishIncomplete");
	});

	// An apply that wrote something UNEXPECTED then failed matches neither journal image; the undo
	// rightly refuses, and the executor must say the step remains rather than strand it silently.
	it("says so when a failed apply cannot be undone", async () => {
		transactions.start();
		const outcome = await run({
			plannedText: [{ module: "src/a.ts", text: "after\n" }],
			apply: () => {
				write("src/a.ts", "junk that matches neither image\n");
				throw new Error("boom");
			},
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toMatch(/could not be written: boom/);
		expect(outcome.reason).toMatch(/journaled step remains/);
		expect(transactions.status().steps).toHaveLength(1);
	});
});
