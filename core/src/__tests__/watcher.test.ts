import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileEvent } from "../invalidation";
import type { EvidenceSubscription } from "../policyEvidence";
import {
	admitted,
	hashContent,
	isIgnored,
	type RunningWatcher,
	readEvent,
	toModule,
	type WatchOptions,
	type WatchScope,
	watchWorkspace,
} from "../watcher";
import { fakeClock } from "./fakeClock";
import { hashOfRead } from "./reads";

////////////////////////////////
//  Helpers

let root: string;
let watcher: RunningWatcher | undefined;

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const watch = (options: Omit<WatchOptions, "hash">) => watchWorkspace({ ...options, hash: hashOfRead });

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

	// The id grammar's key: a decomposed filename indexes under the composed one every host asks by.
	it("composes the name the platform reported, so one file has one key", () => {
		const decomposed = path.join(root, "src", "café.ts");
		expect(toModule(root, decomposed)).toBe("src/café.ts");
	});

	it("drops a name the grammar cannot spell rather than minting a key nobody can ask by", () => {
		expect(toModule(root, path.join(root, `bad${String.fromCharCode(7)}.ts`))).toBeNull();
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
		const event = readEvent(root, "a.ts", hashOfRead);
		expect(event).toEqual({ kind: "changed", module: "a.ts", contentHash: hashContent("hello") });
	});

	// The indexer reads it and says why; the watcher only says it changed.
	it("leaves a binary unhashed rather than hashing a mangled decode", () => {
		writeFileSync(path.join(root, "b.bin"), Buffer.from([0x41, 0x00, 0x42]));
		expect(readEvent(root, "b.bin", hashOfRead)).toEqual({ kind: "changed", module: "b.bin", contentHash: null });
	});

	it("gives the same hash for the same content, and a different one otherwise", () => {
		expect(hashContent("a")).toBe(hashContent("a"));
		expect(hashContent("a")).not.toBe(hashContent("b"));
	});

	it("reports a vanished file as deleted rather than failing the batch", () => {
		expect(readEvent(root, "never-existed.ts", hashOfRead)).toEqual({
			kind: "deleted",
			module: "never-existed.ts",
		});
	});
});

describe("batching", () => {
	it("delivers one batch for a burst rather than one event each", async () => {
		const batches: FileEvent[][] = [];
		write("a.ts", "1");
		watcher = watch({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

		watcher.inject("a.ts");
		watcher.inject("a.ts");
		watcher.inject("a.ts");
		await settle();

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
	});

	// Decided on the injected clock, so the rule is tested rather than the wall.
	it("settles a burst when the debounce elapses on the clock, restarting it per event", () => {
		const batches: FileEvent[][] = [];
		const clock = fakeClock();
		write("a.ts", "1");
		watcher = watch({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20, clock });

		watcher.inject("a.ts");
		clock.advance(15);
		watcher.inject("a.ts");
		clock.advance(15);
		expect(batches).toEqual([]);

		clock.advance(5);
		expect(batches).toHaveLength(1);
		expect(clock.pending()).toBe(0);
	});

	it("carries the last state of each file in the burst", async () => {
		const batches: FileEvent[][] = [];
		write("a.ts", "first");
		watcher = watch({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

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
		watcher = watch({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

		watcher.inject("a.ts");
		watcher.inject("b.ts");
		await settle();

		expect(batches[0]?.map((e) => e.module).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("drops ignored paths before they reach a batch", async () => {
		const batches: FileEvent[][] = [];
		watcher = watch({
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
		watcher = watch({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 20 });

		watcher.stop();
		watcher.inject("a.ts");
		await settle();

		expect(batches).toEqual([]);
	});

	it("sees a real filesystem write, not only injected events", async () => {
		const batches: FileEvent[][] = [];
		watcher = watch({ workspaceRoot: root, onBatch: (b) => batches.push(b), debounceMs: 30 });

		write("real.ts", "written");
		await settle(200);

		expect(batches.flat().some((e) => e.module === "real.ts")).toBe(true);
	});

	it("delivers a burst that never settles at the ceiling rather than holding it", () => {
		const batches: FileEvent[][] = [];
		const clock = fakeClock();
		write("a.ts", "1");
		watcher = watch({
			workspaceRoot: root,
			onBatch: (b) => batches.push(b),
			debounceMs: 20,
			maxWaitMs: 100,
			clock,
		});

		for (let at = 0; at < 100; at += 15) {
			watcher.inject("a.ts");
			clock.advance(15);
		}

		expect(batches).toHaveLength(1);
		expect(clock.pending()).toBe(0);
	});
});

describe("asking the scope before reading", () => {
	const scopeOf = (admits: WatchScope["admits"], ignored: WatchScope["ignored"]): WatchScope => ({
		subscriptions: () => [],
		onSubscriptionsChanged: () => () => {},
		watchesModule: () => false,
		admits,
		ignored,
	});

	it("reads what the scope holds without asking git", async () => {
		const batches: FileEvent[][] = [];
		let asked = 0;
		write("a.ts", "1");
		watcher = watch({
			workspaceRoot: root,
			onBatch: (b) => batches.push(b),
			debounceMs: 20,
			scope: scopeOf(
				(module) => module === "a.ts",
				async () => {
					asked++;
					return new Set();
				},
			),
		});

		watcher.inject("a.ts");
		await settle();

		expect(batches).toEqual([[{ kind: "changed", module: "a.ts", contentHash: hashContent("1") }]]);
		expect(asked).toBe(0);
	});

	it("asks git once per burst for the rest, and never reads what git ignores", async () => {
		const batches: FileEvent[][] = [];
		const asked: string[][] = [];
		write("volumes/state.json", "{}");
		write("src/new.ts", "1");
		watcher = watch({
			workspaceRoot: root,
			onBatch: (b) => batches.push(b),
			debounceMs: 20,
			scope: scopeOf(
				() => false,
				async (modules) => {
					asked.push(modules);
					return new Set(["volumes/state.json"]);
				},
			),
		});

		watcher.inject("volumes/state.json");
		watcher.inject("src/new.ts");
		watcher.inject("volumes/state.json");
		await settle();

		expect(asked).toEqual([["volumes/state.json", "src/new.ts"]]);
		expect(batches).toEqual([[{ kind: "changed", module: "src/new.ts", contentHash: hashContent("1") }]]);
	});

	it("delivers no batch for a burst git ignores entirely", async () => {
		const batches: FileEvent[][] = [];
		write("volumes/state.json", "{}");
		watcher = watch({
			workspaceRoot: root,
			onBatch: (b) => batches.push(b),
			debounceMs: 20,
			scope: scopeOf(
				() => false,
				async (modules) => new Set(modules),
			),
		});

		watcher.inject("volumes/state.json");
		await settle();

		expect(batches).toEqual([]);
	});

	it("keeps delivery in trigger order when a later burst's git call answers first", async () => {
		const batches: FileEvent[][] = [];
		write("a.ts", "1");
		write("b.ts", "2");
		const resolvers: Array<(value: Set<string>) => void> = [];
		watcher = watch({
			workspaceRoot: root,
			onBatch: (b) => batches.push(b),
			debounceMs: 5,
			scope: scopeOf(
				() => false,
				() => new Promise<Set<string>>((resolve) => resolvers.push(resolve)),
			),
		});

		watcher.inject("a.ts");
		await settle(20);
		watcher.inject("b.ts");
		await settle(20);
		expect(resolvers).toHaveLength(2);

		// The second burst's git call answers first; delivery still waits for the first burst.
		resolvers[1]?.(new Set());
		await settle(20);
		expect(batches).toEqual([]);

		resolvers[0]?.(new Set());
		await settle(20);
		expect(batches.map((b) => b.map((e) => e.module))).toEqual([["a.ts"], ["b.ts"]]);
	});

	it("leaves the previous verdicts standing when git cannot say: kept if already admitted, retried otherwise", async () => {
		await expect(
			admitted(
				["a.ts", "b.ts", "c.ts"],
				scopeOf(
					(module) => module === "a.ts",
					async () => null,
				),
			),
		).resolves.toEqual({ admitted: ["a.ts"], retry: ["b.ts", "c.ts"] });
	});

	it("keeps a new file pending through a failed git call and admits it without a further edit", async () => {
		const batches: FileEvent[][] = [];
		write("new.ts", "1");
		let calls = 0;
		watcher = watch({
			workspaceRoot: root,
			onBatch: (b) => batches.push(b),
			debounceMs: 10,
			maxWaitMs: 30,
			scope: scopeOf(
				() => false,
				async () => {
					calls += 1;
					// The first ask fails outright; the retry it leaves behind gets a real answer.
					return calls === 1 ? null : new Set();
				},
			),
		});

		watcher.inject("new.ts");
		await settle(200);

		expect(calls).toBe(2);
		expect(batches.map((b) => b.map((e) => e.module))).toEqual([["new.ts"]]);
	});
});

describe("following evidence subscriptions", () => {
	let outside: string;
	let first: string;
	let second: string;

	function subscription(file: string, key: EvidenceSubscription["keys"][number]): EvidenceSubscription {
		const stat = statSync(file);
		return {
			path: file,
			keys: [key],
			fingerprint: `${stat.mtimeMs}:${stat.size}:${stat.ino}`,
		};
	}

	function movingScope(initial: EvidenceSubscription[]) {
		const listeners = new Set<() => void>();
		let current = initial;
		const scope: WatchScope = {
			subscriptions: () => current,
			onSubscriptionsChanged: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			watchesModule: () => false,
			admits: () => true,
			ignored: async () => new Set(),
		};
		return {
			scope,
			listeners,
			move: (subscriptions: EvidenceSubscription[]) => {
				current = subscriptions;
				for (const listener of listeners) listener();
			},
		};
	}

	beforeEach(() => {
		outside = mkdtempSync(path.join(tmpdir(), "lexicon-watch-index-"));
		first = path.join(outside, "a", "index");
		second = path.join(outside, "b", "index");
		for (const file of [first, second]) {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, "0");
		}
	});

	afterEach(() => {
		rmSync(outside, { recursive: true, force: true });
	});

	it("catches an index change between collection and subscription once", async () => {
		const batches: Array<{ files: FileEvent[]; evidence: readonly string[] }> = [];
		const { scope, move } = movingScope([subscription(first, "listing:")]);
		watcher = watch({
			workspaceRoot: root,
			onBatch: (files, evidence) => batches.push({ files, evidence }),
			debounceMs: 20,
			scope,
		});

		const collected = subscription(second, "listing:vendor");
		writeFileSync(second, "first change");
		move([subscription(first, "listing:"), collected]);
		await settle();

		expect(batches).toEqual([{ files: [], evidence: ["listing:vendor"] }]);
		batches.length = 0;
		writeFileSync(second, "second, longer change");
		await settle(150);
		expect(batches).toEqual([{ files: [], evidence: ["listing:vendor"] }]);
	});

	it("drops a removed subscription and keeps the remaining path", async () => {
		const batches: Array<{ files: FileEvent[]; evidence: readonly string[] }> = [];
		const firstSubscription = subscription(first, "listing:first");
		const secondSubscription = subscription(second, "listing:second");
		const { scope, move } = movingScope([firstSubscription, secondSubscription]);
		watcher = watch({
			workspaceRoot: root,
			onBatch: (files, evidence) => batches.push({ files, evidence }),
			debounceMs: 20,
			scope,
		});

		move([secondSubscription]);
		await settle();
		expect(batches).toEqual([]);

		writeFileSync(first, "changed");
		await settle(150);
		expect(batches).toEqual([]);

		writeFileSync(second, "changed");
		await settle(150);
		expect(batches).toEqual([{ files: [], evidence: ["listing:second"] }]);
	});

	it("emits one event for a moved fingerprint and none while it stays put", async () => {
		const batches: Array<{ files: FileEvent[]; evidence: readonly string[] }> = [];
		const current = subscription(first, "repositories");
		const { scope, move } = movingScope([current]);
		watcher = watch({
			workspaceRoot: root,
			onBatch: (files, evidence) => batches.push({ files, evidence }),
			debounceMs: 20,
			scope,
		});

		move([current]);
		await settle();
		expect(batches).toEqual([]);

		const moved = { ...current, fingerprint: "moved" };
		move([moved]);
		await settle();
		expect(batches).toEqual([{ files: [], evidence: ["repositories"] }]);

		move([moved]);
		await settle();
		expect(batches).toHaveLength(1);
	});

	it("records a watched secret path beneath an ignored segment", async () => {
		const batches: FileEvent[][] = [];
		watcher = watch({
			workspaceRoot: root,
			onBatch: (files) => batches.push(files),
			debounceMs: 20,
			scope: {
				subscriptions: () => [],
				onSubscriptionsChanged: () => () => {},
				admits: () => true,
				ignored: async () => new Set(),
				watchesModule: (module) => module === "dist/.env.local",
			},
		});

		write("dist/.env.local", "API_KEY=PRIVATE\n");
		watcher.inject("dist/.env.local");
		await settle();

		expect(batches.flat().map(({ module }) => module)).toEqual(["dist/.env.local"]);
	});

	it("stops following the scope when it stops", () => {
		const { scope, listeners } = movingScope([subscription(first, "repositories")]);
		watcher = watch({ workspaceRoot: root, onBatch: () => {}, scope });
		expect(listeners.size).toBe(1);

		watcher.stop();
		expect(listeners.size).toBe(0);
	});
});
