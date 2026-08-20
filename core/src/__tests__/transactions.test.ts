import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexStore } from "../store";
import { TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let manager: TransactionManager;

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

/** A step that actually writes, so undo has something of its own to recognize. */
function step(kind: "replace" | "rename", edits: Record<string, string | null>) {
	const modules = Object.keys(edits);
	const begun = manager.beginStep(kind, modules);
	if (!begun.ok) throw new Error(begun.reason);

	for (const [module, text] of Object.entries(edits)) {
		if (text === null) rmSync(path.join(root, module), { force: true });
		else write(module, text);
	}
	manager.completeStep(begun.stepNo, "written");
	manager.completeStep(begun.stepNo, "finalized");
	return begun.stepNo;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-txn-"));
	store = IndexStore.open(path.join(root, ".index.sqlite")).store;
	manager = new TransactionManager(store, root);
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("holding one transaction per workspace", () => {
	it("refuses a second start and points at the open one", () => {
		const first = manager.start();
		const second = manager.start();

		expect(first.started).toBe(true);
		expect(second).toMatchObject({ started: false, id: first.id });
	});

	it("reports no transaction as an answer rather than an error", () => {
		expect(manager.status()).toEqual({ open: false, steps: [], tracked: [], issues: [] });
	});

	it("opens again once the first is committed", () => {
		manager.start();
		manager.commit();
		expect(manager.start().started).toBe(true);
	});
});

describe("undoing a step", () => {
	beforeEach(() => {
		write("a.ts", "original\n");
		manager.start();
	});

	it("puts the file back to what the step found", () => {
		step("replace", { "a.ts": "edited\n" });

		expect(manager.undo()).toMatchObject({ undone: true, modules: ["a.ts"] });
		expect(read("a.ts")).toBe("original\n");
	});

	it("unwinds newest first", () => {
		step("replace", { "a.ts": "one\n" });
		step("replace", { "a.ts": "two\n" });

		manager.undo();
		expect(read("a.ts")).toBe("one\n");
		manager.undo();
		expect(read("a.ts")).toBe("original\n");
	});

	// The case the design was argued around: a manual edit between two steps belongs to the file,
	// and the later step's snapshot is what preserves it.
	it("restores a manual edit made between two steps", () => {
		step("replace", { "a.ts": "step one\n" });
		write("a.ts", "hand written\n");
		step("replace", { "a.ts": "step two\n" });

		expect(manager.undo()).toMatchObject({ undone: true });
		expect(read("a.ts")).toBe("hand written\n");
	});

	// Undo restores bytes. If the file is not what the step left, those bytes are not its output
	// and writing them back would silently destroy whatever replaced them.
	it("refuses when the file changed after the step, naming the conflict", () => {
		step("replace", { "a.ts": "edited\n" });
		write("a.ts", "changed by hand\n");

		const outcome = manager.undo();
		expect(outcome.undone).toBe(false);
		expect(outcome.reason).toContain("a.ts");
		expect(read("a.ts")).toBe("changed by hand\n");
	});

	it("deletes a file the step created, rather than leaving an empty one", () => {
		step("replace", { "b.ts": "new file\n" });

		expect(manager.undo()).toMatchObject({ undone: true });
		expect(read("b.ts")).toBeNull();
	});

	it("brings back a file the step deleted", () => {
		step("replace", { "a.ts": null });
		expect(read("a.ts")).toBeNull();

		manager.undo();
		expect(read("a.ts")).toBe("original\n");
	});

	it("says so when there is nothing left to undo", () => {
		expect(manager.undo()).toMatchObject({ undone: false });
	});
});

describe("reverting a transaction", () => {
	it("returns every touched file to how the transaction found it", () => {
		write("a.ts", "a original\n");
		write("b.ts", "b original\n");
		manager.start();

		step("replace", { "a.ts": "a one\n" });
		step("replace", { "b.ts": "b one\n" });
		step("replace", { "a.ts": "a two\n" });

		expect(manager.revert().reverted).toBe(true);
		expect(read("a.ts")).toBe("a original\n");
		expect(read("b.ts")).toBe("b original\n");
	});

	// Revert is defined as the transaction's opening state, so an edit made inside it goes too.
	it("discards a manual edit made inside the transaction", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		write("a.ts", "hand written\n");

		manager.revert();
		expect(read("a.ts")).toBe("original\n");
	});

	// Tracking twice must not move the mark revert restores to.
	it("keeps the first baseline when a file is tracked again later", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		write("a.ts", "later\n");
		manager.track("a.ts");

		manager.revert();
		expect(read("a.ts")).toBe("original\n");
	});

	it("leaves an untracked file alone", () => {
		write("a.ts", "original\n");
		write("untouched.ts", "mine\n");
		manager.start();
		step("replace", { "a.ts": "edited\n" });
		write("untouched.ts", "still mine\n");

		manager.revert();
		expect(read("untouched.ts")).toBe("still mine\n");
	});
});

describe("committing", () => {
	beforeEach(() => {
		write("a.ts", "original\n");
		manager.start();
	});

	it("keeps what is on disk and leaves nothing to undo", () => {
		step("replace", { "a.ts": "edited\n" });

		expect(manager.commit().committed).toBe(true);
		expect(read("a.ts")).toBe("edited\n");
		expect(manager.status().open).toBe(false);
	});

	it("refuses while issues are unresolved, and says how many", () => {
		const stepNo = step("replace", { "a.ts": "edited\n" });
		manager.recordIssues(stepNo, [{ kind: "OrphanedReference", detail: "add is referenced from b.ts" }]);

		const outcome = manager.commit();
		expect(outcome.committed).toBe(false);
		expect(outcome.issues).toHaveLength(1);
		expect(manager.status().open).toBe(true);
	});

	it("commits anyway when forced, carrying the issues into the answer", () => {
		const stepNo = step("replace", { "a.ts": "edited\n" });
		manager.recordIssues(stepNo, [{ kind: "OrphanedReference", detail: "add is referenced from b.ts" }]);

		const outcome = manager.commit({ force: true });
		expect(outcome.committed).toBe(true);
		expect(outcome.issues).toHaveLength(1);
	});

	it("drops an issue along with the step that introduced it", () => {
		const stepNo = step("replace", { "a.ts": "edited\n" });
		manager.recordIssues(stepNo, [{ kind: "OrphanedReference", detail: "gone" }]);

		manager.undo();
		expect(manager.status().issues).toEqual([]);
		expect(manager.commit().committed).toBe(true);
	});
});

describe("recovering after a crash", () => {
	beforeEach(() => {
		write("a.ts", "original\n");
		manager.start();
	});

	// The phase says what was STARTED, so recovery judges by what the files actually hold.
	it("rolls back a step whose write completed but was never finalized", () => {
		const begun = manager.beginStep("replace", ["a.ts"]);
		if (!begun.ok) throw new Error(begun.reason);
		write("a.ts", "half applied\n");
		manager.completeStep(begun.stepNo, "written");

		const outcome = manager.recover();
		expect(outcome.restored).toEqual(["a.ts"]);
		expect(read("a.ts")).toBe("original\n");
	});

	it("leaves a step alone when its files were never written", () => {
		manager.beginStep("replace", ["a.ts"]);

		const outcome = manager.recover();
		expect(outcome.restored).toEqual([]);
		expect(read("a.ts")).toBe("original\n");
	});

	// Overwriting here would destroy an edit the journal knows nothing about.
	it("reports a conflict rather than overwriting a file it does not recognize", () => {
		const begun = manager.beginStep("replace", ["a.ts"]);
		if (!begun.ok) throw new Error(begun.reason);
		write("a.ts", "written by the step\n");
		manager.completeStep(begun.stepNo, "written");
		write("a.ts", "then edited by someone else\n");

		const outcome = manager.recover();
		expect(outcome.conflicts).toEqual(["a.ts"]);
		expect(read("a.ts")).toBe("then edited by someone else\n");
	});

	// The real shape: the process holding the journal dies, and a fresh daemon opens the same store
	// and has to work out what happened from rows alone.
	it("recovers across a process that died, from the journal on disk", () => {
		const begun = manager.beginStep("replace", ["a.ts"]);
		if (!begun.ok) throw new Error(begun.reason);
		write("a.ts", "written by the step\n");
		manager.completeStep(begun.stepNo, "written");

		// Everything in memory goes away, as it would on a crash.
		store.close();
		store = IndexStore.open(path.join(root, ".index.sqlite")).store;
		const reopened = new TransactionManager(store, root);

		const outcome = reopened.recover();

		expect(outcome).toMatchObject({ recovered: true, restored: ["a.ts"] });
		expect(read("a.ts")).toBe("original\n");
		expect(reopened.status().steps).toEqual([]);
	});

	it("sweeps a temporary file left by a write that died mid-rename", () => {
		manager.beginStep("replace", ["a.ts"]);
		write("a.ts.lexicon-tmp", "partial\n");

		manager.recover();
		expect(read("a.ts.lexicon-tmp")).toBeNull();
	});
});

// Insert knows its final text before writing, so the outcome rides in the journal from begin. A
// crash between write and completion must read as unfinished work, never as a conflict.
describe("a step that journals its outcome up front", () => {
	const planned = (text: string) => [{ module: "src/new.ts", text }];

	it("removes a created module whose write crashed before completion", () => {
		manager.start();
		const text = "function added() {}\n";
		const begun = manager.beginStep("insert", ["src/new.ts"], undefined, planned(text));
		expect(begun.ok).toBe(true);
		write("src/new.ts", text);

		const recovered = new TransactionManager(store, root).recover();

		expect(recovered.restored).toEqual(["src/new.ts"]);
		expect(recovered.conflicts).toEqual([]);
		expect(read("src/new.ts")).toBeNull();
	});

	it("restores an existing module written but not completed", () => {
		write("src/a.ts", "before\n");
		manager.start();
		manager.beginStep("insert", ["src/a.ts"], undefined, [{ module: "src/a.ts", text: "before\nadded\n" }]);
		write("src/a.ts", "before\nadded\n");

		const recovered = new TransactionManager(store, root).recover();

		expect(recovered.restored).toEqual(["src/a.ts"]);
		expect(read("src/a.ts")).toBe("before\n");
	});

	it("still calls a mismatching file a conflict rather than deleting a stranger's work", () => {
		manager.start();
		manager.beginStep("insert", ["src/new.ts"], undefined, planned("planned\n"));
		write("src/new.ts", "someone else's content\n");

		const recovered = new TransactionManager(store, root).recover();

		expect(recovered.conflicts).toEqual(["src/new.ts"]);
		expect(read("src/new.ts")).toBe("someone else's content\n");
	});

	// The audit's zombie: a planned-after step whose write FAILED holds its before-image forever,
	// and an undo that only accepts the after-image wedges every later undo behind it.
	it("undoes a planned-after step whose write never landed", () => {
		write("src/a.ts", "before\n");
		manager.start();
		const begun = manager.beginStep("insert", ["src/a.ts"], undefined, [
			{ module: "src/a.ts", text: "before\nadded\n" },
		]);
		expect(begun.ok).toBe(true);

		const undone = manager.undo();

		expect(undone.undone).toBe(true);
		expect(read("src/a.ts")).toBe("before\n");
		expect(manager.status().steps).toEqual([]);
	});
});
