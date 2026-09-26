import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IndexStore } from "../store";
import { hashBytes, readLeaf, TransactionManager } from "../transactions";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let manager: TransactionManager;

function write(module: string, text: string | Uint8Array) {
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

function diskDrift(module: string, contents: string | null) {
	return { module, contentHash: contents === null ? null : hashBytes(Buffer.from(contents)) };
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
		expect(manager.status()).toEqual({ open: false, steps: [], tracked: [], drifted: [], edited: [], issues: [] });
	});

	it("opens again once the first is committed", () => {
		manager.start();
		manager.commit();
		expect(manager.start().started).toBe(true);
	});

	it("names the refactor a track landed in, and null when none is open", () => {
		expect(manager.track("a.ts")).toMatchObject({ tracked: false, refactor: null });
		const { id } = manager.start();
		expect(manager.track("a.ts")).toEqual({ tracked: true, refactor: { id } });
	});
});

describe("reading tracked before-images", () => {
	it("returns the opening text, absent-file state, bytes and untracked state", () => {
		const opening = Buffer.from("opening\n");
		const binary = Buffer.from([0, 255, 1]);
		write("tracked.ts", opening);
		write("binary.ts", binary);
		const { id } = manager.start();
		manager.track("tracked.ts");
		manager.track("created.ts");
		manager.track("binary.ts");
		write("tracked.ts", "edited\n");
		write("created.ts", "created later\n");
		write("binary.ts", "edited\n");

		expect(manager.beforeImage("tracked.ts")).toEqual({
			tracked: true,
			existed: true,
			contentHash: hashBytes(opening),
			encoding: "text",
			text: "opening\n",
		});
		expect(manager.beforeImage("created.ts")).toEqual({ tracked: true, existed: false });
		expect(manager.beforeImage("binary.ts")).toEqual({
			tracked: true,
			existed: true,
			contentHash: hashBytes(binary),
			encoding: "base64",
			bytes: binary.toString("base64"),
		});
		expect(manager.beforeImage("untracked.ts")).toEqual({ tracked: false });
		expect(manager.beforeImage("tracked.ts", id)).toMatchObject({ tracked: true, text: "opening\n" });
		expect(manager.beforeImage("tracked.ts", "rt-another")).toEqual({ tracked: false });
		manager.commit();
		expect(manager.beforeImage("tracked.ts")).toEqual({ tracked: false });
	});
});

describe("acting on the transaction that was shown", () => {
	it("refuses commit, undo and revert once its id or revision moved, changing nothing", () => {
		write("a.ts", "original\n");
		const { id } = manager.start();
		const shown = manager.status();
		if (shown.revision === undefined) throw new Error("open transaction has no revision");
		step("replace", { "a.ts": "edited\n" });
		const current = manager.status();
		if (current.revision === undefined) throw new Error("open transaction has no revision");

		for (const stale of [
			{ id, revision: shown.revision },
			{ id: "rt-another", revision: current.revision },
		]) {
			expect(manager.undo(stale).undone).toBe(false);
			expect(manager.revert(current.drifted, stale).reverted).toBe(false);
			expect(manager.commit({ expect: stale }).committed).toBe(false);
		}
		expect(read("a.ts")).toBe("edited\n");
		expect(manager.status()).toMatchObject({ open: true, id, steps: [{ stepNo: 1 }] });

		expect(manager.undo({ id, revision: current.revision }).undone).toBe(true);
		const afterUndo = manager.status();
		if (afterUndo.revision === undefined) throw new Error("open transaction has no revision");
		expect(manager.commit({ expect: { id, revision: afterUndo.revision } }).committed).toBe(true);
		expect(manager.revert(afterUndo.drifted, { id, revision: afterUndo.revision }).reverted).toBe(false);
	});

	it("does not accept a reused step number after undo", () => {
		write("a.ts", "original\n");
		const { id } = manager.start();
		step("replace", { "a.ts": "one\n" });
		step("replace", { "a.ts": "two\n" });
		const shown = manager.status();
		if (shown.revision === undefined) throw new Error("open transaction has no revision");

		expect(manager.undo({ id, revision: shown.revision }).undone).toBe(true);
		step("replace", { "a.ts": "replacement two\n" });
		const current = manager.status();
		if (current.revision === undefined) throw new Error("open transaction has no revision");
		expect(current.steps.map(({ stepNo }) => stepNo)).toEqual([1, 2]);
		expect(current.revision).toBeGreaterThan(shown.revision);

		expect(manager.undo({ id, revision: shown.revision }).undone).toBe(false);
		expect(manager.revert(current.drifted, { id, revision: shown.revision }).reverted).toBe(false);
		expect(manager.commit({ expect: { id, revision: shown.revision } }).committed).toBe(false);
		expect(read("a.ts")).toBe("replacement two\n");
		expect(manager.status().revision).toBe(current.revision);
	});

	it("advances and persists the revision when tracking adds a baseline", () => {
		write("a.ts", "original\n");
		manager.start();
		const shown = manager.status();
		if (shown.revision === undefined) throw new Error("open transaction has no revision");

		expect(manager.track("a.ts").tracked).toBe(true);
		const tracked = manager.status();
		if (tracked.revision === undefined) throw new Error("open transaction has no revision");
		expect(tracked.revision).toBeGreaterThan(shown.revision);
		expect(manager.track("a.ts").tracked).toBe(true);
		expect(manager.status().revision).toBe(tracked.revision);
		const id = tracked.id as string;
		expect(manager.undo({ id, revision: shown.revision }).undone).toBe(false);
		expect(manager.revert(tracked.drifted, { id, revision: shown.revision }).reverted).toBe(false);
		expect(manager.commit({ expect: { id, revision: shown.revision } }).committed).toBe(false);
		expect(manager.status().tracked).toEqual(["a.ts"]);

		store.close();
		store = IndexStore.open(path.join(root, ".index.sqlite")).store;
		manager = new TransactionManager(store, root);
		expect(manager.status().revision).toBe(tracked.revision);
	});
});

describe("known file states", () => {
	it("follows editor writes, steps and undo", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");

		write("a.ts", "editor\n");
		const blobsBeforeStatus = store.journalRead((db) =>
			db.prepare("SELECT COUNT(*) AS n FROM refactor_blobs").get(),
		);
		expect(manager.status().drifted).toEqual([diskDrift("a.ts", "editor\n")]);
		expect(store.journalRead((db) => db.prepare("SELECT COUNT(*) AS n FROM refactor_blobs").get())).toEqual(
			blobsBeforeStatus,
		);
		expect(manager.noteWrite("a.ts", { contentHash: hashBytes(Buffer.from("editor\n")) })).toEqual({ noted: true });
		const noted = manager.status();
		expect(noted).toMatchObject({ drifted: [], edited: ["a.ts"] });
		if (noted.revision === undefined) throw new Error("open transaction has no revision");
		expect(manager.noteWrite("a.ts", { contentHash: hashBytes(Buffer.from("editor\n")) })).toEqual({ noted: true });
		expect(manager.status().revision).toBe(noted.revision);

		step("replace", { "a.ts": "refactor\n" });
		expect(manager.status()).toMatchObject({ drifted: [], edited: [] });
		expect(manager.undo().undone).toBe(true);
		expect(read("a.ts")).toBe("editor\n");
		expect(manager.status()).toMatchObject({ drifted: [], edited: ["a.ts"] });
	});

	it("refuses a note when disk no longer holds the reported state", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		const before = manager.status();
		write("a.ts", "actual\n");

		const refused = manager.noteWrite("a.ts", { contentHash: hashBytes(Buffer.from("reported\n")) });
		expect(refused.noted).toBe(false);
		expect(before.revision).toBe(manager.status().revision);
		expect(manager.status()).toMatchObject({ drifted: [diskDrift("a.ts", "actual\n")], edited: [] });
	});

	it("records a reported deletion only while the module is absent", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		rmSync(path.join(root, "a.ts"));

		expect(manager.noteWrite("a.ts", { absent: true })).toEqual({ noted: true });
		expect(manager.status()).toMatchObject({ drifted: [], edited: ["a.ts"] });
	});

	it("advances the revision when a note only marks the known state as edited", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		store.journalWrite((db) => {
			db.exec("DROP TRIGGER refactor_known_states_revision_update");
			db.exec(`
				CREATE TRIGGER refactor_known_states_revision_update AFTER UPDATE ON refactor_known_states
				WHEN OLD.transactionId IS NOT NEW.transactionId OR OLD.module IS NOT NEW.module
					OR OLD.existed IS NOT NEW.existed OR OLD.contentHash IS NOT NEW.contentHash
				BEGIN UPDATE refactor_transactions SET revision = revision + 1 WHERE id = NEW.transactionId AND state = 'open'; END;
			`);
		});
		store.close();
		store = IndexStore.open(path.join(root, ".index.sqlite")).store;
		manager = new TransactionManager(store, root);
		const before = manager.status();
		if (before.revision === undefined) throw new Error("open transaction has no revision");

		expect(manager.noteWrite("a.ts", { contentHash: hashBytes(Buffer.from("original\n")) })).toEqual({
			noted: true,
		});
		const after = manager.status();
		expect(after.revision).toBeGreaterThan(before.revision);
		expect(after).toMatchObject({ drifted: [], edited: ["a.ts"] });
	});

	it("reverts only the drift set the caller reviewed", () => {
		write("a.ts", "a original\n");
		write("b.ts", "b original\n");
		manager.start();
		manager.track("a.ts");
		manager.track("b.ts");
		write("a.ts", "a outside\n");
		const shown = manager.status();
		write("b.ts", "b outside\n");

		const stale = manager.revert(shown.drifted);
		expect(stale.reverted).toBe(false);
		expect(read("a.ts")).toBe("a outside\n");
		expect(read("b.ts")).toBe("b outside\n");
		expect(
			store.journalRead((db) => db.prepare("SELECT COUNT(*) AS n FROM refactor_recovery_intents").get()),
		).toEqual({ n: 0 });

		const current = manager.status();
		expect(current.drifted).toEqual([diskDrift("a.ts", "a outside\n"), diskDrift("b.ts", "b outside\n")]);
		expect(manager.revert([...current.drifted].reverse()).reverted).toBe(true);
		expect(read("a.ts")).toBe("a original\n");
		expect(read("b.ts")).toBe("b original\n");
	});

	it("refuses a reviewed drift path when its disk hash changes", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		write("a.ts", "first outside edit\n");
		const shown = manager.status();
		write("a.ts", "second outside edit\n");

		const stale = manager.revert(shown.drifted);
		expect(stale.reverted).toBe(false);
		expect(read("a.ts")).toBe("second outside edit\n");
		expect(manager.status().drifted).toEqual([diskDrift("a.ts", "second outside edit\n")]);
	});

	it("keeps an interrupted revert pending when disk changed while the daemon was down", () => {
		write("a.ts", "original\n");
		manager.start();
		step("replace", { "a.ts": "refactor output\n" });
		write("a.ts", "confirmed outside edit\n");
		const shown = manager.status();
		const dying = new TransactionManager(store, root, undefined, () => {
			throw new Error("daemon stopped during revert");
		});
		expect(() => dying.revert(shown.drifted)).toThrow("daemon stopped during revert");

		store.close();
		write("a.ts", "edit made while stopped\n");
		store = IndexStore.open(path.join(root, ".index.sqlite")).store;
		manager = new TransactionManager(store, root);
		expect(manager.recover()).toMatchObject({ recovered: true, restored: [], conflicts: ["a.ts"] });
		expect(read("a.ts")).toBe("edit made while stopped\n");
		expect(manager.openTransaction()).not.toBeNull();
		expect(
			store.journalRead((db) => db.prepare("SELECT COUNT(*) AS n FROM refactor_recovery_intents").get()),
		).toEqual({ n: 1 });

		write("a.ts", "confirmed outside edit\n");
		expect(manager.recover()).toMatchObject({ recovered: true, restored: ["a.ts"], conflicts: [] });
		expect(read("a.ts")).toBe("original\n");
		expect(manager.status().open).toBe(false);
	});

	it("reports and refuses a tracked path whose parent link leaves the workspace", () => {
		const outside = mkdtempSync(path.join(tmpdir(), "lexicon-outside-"));
		try {
			write("linked/a.ts", "original\n");
			manager.start();
			manager.track("linked/a.ts");
			rmSync(path.join(root, "linked"), { recursive: true, force: true });
			writeFileSync(path.join(outside, "a.ts"), "outside\n");
			symlinkSync(outside, path.join(root, "linked"), "dir");

			const shown = manager.status();
			expect(shown.drifted).toEqual([{ module: "linked/a.ts", contentHash: null }]);
			const refused = manager.revert(shown.drifted);
			expect(refused.reverted).toBe(false);
			expect(refused.reason).toContain("linked/a.ts");
			expect(refused.reason).toContain("parent link");
			expect(readFileSync(path.join(outside, "a.ts"), "utf8")).toBe("outside\n");
			expect(
				store.journalRead((db) => db.prepare("SELECT COUNT(*) AS n FROM refactor_recovery_intents").get()),
			).toEqual({ n: 0 });
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("persists known state and editor provenance across a restart", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		write("a.ts", "editor\n");
		manager.noteWrite("a.ts", { contentHash: hashBytes(Buffer.from("editor\n")) });
		store.close();

		store = IndexStore.open(path.join(root, ".index.sqlite")).store;
		manager = new TransactionManager(store, root);
		expect(manager.status()).toMatchObject({ drifted: [], edited: ["a.ts"] });
		write("a.ts", "outside\n");
		store.close();

		store = IndexStore.open(path.join(root, ".index.sqlite")).store;
		manager = new TransactionManager(store, root);
		expect(manager.status()).toMatchObject({ drifted: [diskDrift("a.ts", "outside\n")], edited: ["a.ts"] });
	});
});

describe("opening a path without following a swapped leaf", () => {
	it("refuses a file replaced between lstat and open", () => {
		const full = path.join(root, "swap.ts");
		const old = path.join(root, "old.ts");
		const replacement = path.join(root, "replacement.ts");
		write("swap.ts", "before\n");
		write("replacement.ts", "after\n");

		const leaf = readLeaf(full, (target, flags) => {
			renameSync(target, old);
			renameSync(replacement, target);
			return openSync(target, flags);
		});

		expect(leaf).toEqual({ kind: "link" });
		expect(readFileSync(old, "utf8")).toBe("before\n");
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

		expect(manager.revert(manager.status().drifted).reverted).toBe(true);
		expect(read("a.ts")).toBe("a original\n");
		expect(read("b.ts")).toBe("b original\n");
	});

	// Revert is defined as the transaction's opening state, so an edit made inside it goes too.
	it("discards a manual edit made inside the transaction", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		write("a.ts", "hand written\n");

		manager.revert(manager.status().drifted);
		expect(read("a.ts")).toBe("original\n");
	});

	// Tracking twice must not move the mark revert restores to.
	it("keeps the first baseline when a file is tracked again later", () => {
		write("a.ts", "original\n");
		manager.start();
		manager.track("a.ts");
		write("a.ts", "later\n");
		manager.track("a.ts");

		manager.revert(manager.status().drifted);
		expect(read("a.ts")).toBe("original\n");
	});

	it("leaves an untracked file alone", () => {
		write("a.ts", "original\n");
		write("untouched.ts", "mine\n");
		manager.start();
		step("replace", { "a.ts": "edited\n" });
		write("untouched.ts", "still mine\n");

		manager.revert(manager.status().drifted);
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

// Directories at restore paths block undo.
describe("restoring where a directory now stands", () => {
	beforeEach(() => {
		write("a.ts", "original\n");
		manager.start();
		step("replace", { "a.ts": "edited\n", "b.ts": "created\n" });
		rmSync(path.join(root, "b.ts"));
		write("b.ts/inner.ts", "mine\n");
	});

	it("refuses undo and revert before restoring anything, naming the directory", () => {
		expect(manager.undo()).toMatchObject({ undone: false, reason: expect.stringContaining("b.ts") });
		expect(manager.revert(manager.status().drifted)).toMatchObject({
			reverted: false,
			reason: expect.stringContaining("b.ts"),
		});

		expect(read("a.ts")).toBe("edited\n");
		expect(read("b.ts/inner.ts")).toBe("mine\n");
		// No recovery intent remains.
		new TransactionManager(store, root).recover();
		expect(read("a.ts")).toBe("edited\n");
		expect(manager.status().steps).toHaveLength(1);
	});

	it("reverts once the directory is deleted", () => {
		rmSync(path.join(root, "b.ts"), { recursive: true });

		expect(manager.revert(manager.status().drifted).reverted).toBe(true);
		expect(read("a.ts")).toBe("original\n");
		expect(read("b.ts")).toBeNull();
	});
});

// Link reads and writes affect the target.
describe("never reading or writing through a leaf link", () => {
	beforeEach(() => {
		write("a.ts", "original\n");
		write("elsewhere.txt", "edited\n");
		manager.start();
	});

	function link(module: string): void {
		rmSync(path.join(root, module), { force: true });
		symlinkSync(path.join(root, "elsewhere.txt"), path.join(root, module));
	}

	it("refuses to track a link or journal a step over one", () => {
		link("linked.ts");

		expect(manager.track("linked.ts")).toMatchObject({ tracked: false, reason: expect.any(String) });
		expect(manager.beginStep("replace", ["linked.ts"]).ok).toBe(false);
		expect(manager.status()).toMatchObject({ steps: [], tracked: [] });
	});

	it("does not read a link to identical bytes as the step's output", () => {
		step("replace", { "a.ts": "edited\n" });
		link("a.ts");

		expect(manager.undo().undone).toBe(false);
		expect(lstatSync(path.join(root, "a.ts")).isSymbolicLink()).toBe(true);
	});

	it("reverts a file over the link that replaced it, leaving the link's target alone", () => {
		manager.track("a.ts");
		link("a.ts");

		expect(manager.revert(manager.status().drifted).reverted).toBe(true);
		expect(lstatSync(path.join(root, "a.ts")).isFile()).toBe(true);
		expect(read("a.ts")).toBe("original\n");
		expect(read("elsewhere.txt")).toBe("edited\n");
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
		expect(manager.status().drifted).toEqual([]);
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

	it("keeps a transaction refactor_start opened, since someone may still be holding it", () => {
		manager.beginStep("replace", ["a.ts"]);

		const outcome = manager.recover();
		expect(outcome.closed).toBeUndefined();
		expect(manager.start().started).toBe(false);
	});

	// Recovery preserves directories at restore paths.
	for (const operation of ["undo", "revert"] as const) {
		it(`finishes an interrupted ${operation}, leaving a directory in a file's place as a conflict`, () => {
			step("replace", { "a.ts": "edited\n", "b.ts": "created\n" });
			const dying = new TransactionManager(store, root, undefined, () => {
				write("b.ts/inner.ts", "mine\n");
				throw new Error("died after restoring");
			});
			expect(() => (operation === "undo" ? dying.undo() : dying.revert(dying.status().drifted))).toThrow(
				"died after restoring",
			);

			const recovered = new TransactionManager(store, root);
			const outcome = recovered.recover();

			expect(outcome).toMatchObject({ recovered: true, restored: ["a.ts"], conflicts: ["b.ts"] });
			expect(read("a.ts")).toBe("original\n");
			expect(read("b.ts/inner.ts")).toBe("mine\n");
			expect(recovered.status()).toMatchObject({ open: true, tracked: ["a.ts", "b.ts"] });
			expect(recovered.beforeImage("a.ts")).toMatchObject({ tracked: true, text: "original\n" });
			expect(
				store.journal((db) => db.prepare("SELECT operation, stepNo FROM refactor_recovery_intents").get()),
			).toEqual({
				operation,
				stepNo: operation === "undo" ? 1 : null,
			});
			expect(recovered.commit().committed).toBe(false);
			expect(recovered.openTransaction()).not.toBeNull();

			if (operation === "undo") expect(recovered.undo().undone).toBe(false);
			else expect(recovered.revert(recovered.status().drifted).reverted).toBe(false);

			rmSync(path.join(root, "b.ts"), { recursive: true, force: true });
			if (operation === "undo") expect(recovered.undo().undone).toBe(true);
			else expect(recovered.revert(recovered.status().drifted).reverted).toBe(true);

			expect(read("b.ts")).toBeNull();
			if (operation === "undo") {
				expect(recovered.status()).toMatchObject({ open: true, steps: [], tracked: ["a.ts", "b.ts"] });
			} else {
				expect(recovered.status().open).toBe(false);
			}
		});
	}
});

// Otherwise it blocks every later session.
describe("recovering a step's own transaction", () => {
	beforeEach(() => {
		write("a.ts", "original\n");
		manager.start("own");
	});

	it("puts back an unfinished step and closes the transaction", () => {
		const begun = manager.beginStep("replace", ["a.ts"]);
		if (!begun.ok) throw new Error(begun.reason);
		write("a.ts", "half applied\n");
		manager.completeStep(begun.stepNo, "written");

		const outcome = new TransactionManager(store, root).recover();

		expect(outcome).toMatchObject({ restored: ["a.ts"], closed: "reverted" });
		expect(read("a.ts")).toBe("original\n");
		expect(manager.start().started).toBe(true);
	});

	it("keeps a finalized step that died before its commit, and closes the transaction", () => {
		step("replace", { "a.ts": "saved\n" });

		const outcome = new TransactionManager(store, root).recover();

		expect(outcome).toMatchObject({ restored: [], closed: "committed" });
		expect(read("a.ts")).toBe("saved\n");
		expect(manager.start().started).toBe(true);
	});

	it("keeps a transaction from a store older than the origin column open, as refactor_start's", () => {
		store.journalWrite((db) => db.exec("ALTER TABLE refactor_transactions DROP COLUMN origin"));
		store.close();
		store = IndexStore.open(path.join(root, ".index.sqlite")).store;
		const reopened = new TransactionManager(store, root);

		expect(reopened.recover().closed).toBeUndefined();
		expect(reopened.start().started).toBe(false);
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
