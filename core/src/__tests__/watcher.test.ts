import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileEvent } from "../invalidation";
import { hashContent, isIgnored, type RunningWatcher, readEvent, toModule, watchWorkspace } from "../watcher";

////////////////////////////////
//  Helpers

let root: string;
let watcher: RunningWatcher | undefined;

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function write(relative: string, text: string): void {
	const full = path.join(root, relative);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-watch-"));
});

afterEach(() => {
	watcher?.stop();
	watcher = undefined;
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("turning a path into a module", () => {
	// Paths always arrive from the running platform's own watcher, so `toModule` uses that
	// platform's path semantics. The separator swap is what makes the result POSIX either way.
	it("makes a path workspace-relative and POSIX, matching the id grammar", () => {
		const nested = path.join(root, "src", "a.ts");
		expect(toModule(root, nested)).toBe("src/a.ts");
	});

	it("refuses a file outside the workspace, which has no module identity", () => {
		expect(toModule("/w", "/elsewhere/a.ts")).toBeNull();
		expect(toModule("/w", "/w")).toBeNull();
	});
});

describe("ignoring churn", () => {
	it("ignores a directory whose volume dwarfs the source", () => {
		expect(isIgnored("node_modules/zod/index.js", ["node_modules"])).toBe(true);
		expect(isIgnored("src/node_modules_helper.ts", ["node_modules"])).toBe(false);
	});

	it("matches a segment at any depth", () => {
		expect(isIgnored("packages/app/node_modules/a.js", ["node_modules"])).toBe(true);
	});
});

describe("reading an event", () => {
	it("hashes what it read", () => {
		write("a.ts", "hello");
		const event = readEvent(root, "a.ts");
		expect(event).toEqual({ kind: "changed", module: "a.ts", contentHash: hashContent("hello") });
	});

	// The indexer reads it and says why; the watcher only says it changed.
	it("leaves a binary unhashed rather than hashing a mangled decode", () => {
		writeFileSync(path.join(root, "b.bin"), Buffer.from([0x41, 0x00, 0x42]));
		expect(readEvent(root, "b.bin")).toEqual({ kind: "changed", module: "b.bin", contentHash: null });
	});

	it("gives the same hash for the same content, and a different one otherwise", () => {
		expect(hashContent("a")).toBe(hashContent("a"));
		expect(hashContent("a")).not.toBe(hashContent("b"));
	});

	it("reports a vanished file as deleted rather than failing the batch", () => {
		expect(readEvent(root, "never-existed.ts")).toEqual({ kind: "deleted", module: "never-existed.ts" });
	});
});

describe("batching", () => {
	it("delivers one batch for a burst rather than one event each", async () => {
		const batches: FileEvent[][] = [];
		write("a.ts", "1");
		watcher = watchWorkspace({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

		watcher.inject("a.ts");
		watcher.inject("a.ts");
		watcher.inject("a.ts");
		await settle();

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
	});

	it("carries the last state of each file in the burst", async () => {
		const batches: FileEvent[][] = [];
		write("a.ts", "first");
		watcher = watchWorkspace({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

		watcher.inject("a.ts");
		write("a.ts", "second");
		watcher.inject("a.ts");
		await settle();

		expect(batches[0]?.[0]).toMatchObject({ kind: "changed", contentHash: hashContent("second") });
	});

	it("keeps separate files separate within one batch", async () => {
		const batches: FileEvent[][] = [];
		write("a.ts", "1");
		write("b.ts", "2");
		watcher = watchWorkspace({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

		watcher.inject("a.ts");
		watcher.inject("b.ts");
		await settle();

		expect(batches[0]?.map((e) => e.module).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("drops ignored paths before they reach a batch", async () => {
		const batches: FileEvent[][] = [];
		watcher = watchWorkspace({
			workspaceRoot: root,
			onBatch: (b) => batches.push(b),
			debounceMs: 20,
			ignore: ["node_modules"],
		});

		watcher.inject("node_modules/zod/index.js");
		await settle();

		expect(batches).toEqual([]);
	});

	it("delivers nothing after stop, so a late burst cannot outlive the watcher", async () => {
		const batches: FileEvent[][] = [];
		write("a.ts", "1");
		watcher = watchWorkspace({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

		watcher.stop();
		watcher.inject("a.ts");
		await settle();

		expect(batches).toEqual([]);
	});

	it("sees a real filesystem write, not only injected events", async () => {
		const batches: FileEvent[][] = [];
		watcher = watchWorkspace({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 30 });

		write("real.ts", "written");
		await settle(200);

		expect(batches.flat().some((e) => e.module === "real.ts")).toBe(true);
	});
});
