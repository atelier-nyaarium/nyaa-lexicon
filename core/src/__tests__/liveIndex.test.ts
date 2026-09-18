import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent } from "@nyaa-lexicon/protocol";
import type { IndexOutcome } from "../indexer";
import type { FileEvent } from "../invalidation";
import { holdBatches, type LiveIndex, serializeBatches, startLiveIndex } from "../liveIndex";
import type { MethodRequest, ProviderPort } from "../providerPort";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { fakeClock } from "./fakeClock";
import { fakeSupervisor, parseFake } from "./fakeProvider";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Helpers

const OLD = "export class A {}\n";
const NEW = "export class B {}\n";
const DEBOUNCE_MS = 10;

let root: string;
let store: IndexStore;
let live: LiveIndex | undefined;

function change(module: string): FileEvent {
	return { kind: "changed", module, contentHash: `h-${module}` };
}

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function deferred(): { promise: Promise<void>; release: () => void } {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/**
 * Bounded by real time, so a state that never arrives fails the test instead of hanging it.
 *
 * Admission now spawns git asynchronously rather than blocking the thread, so what settles here can
 * take real wall-clock milliseconds under load; a fixed tick count would flake for that reason alone.
 */
async function settle(until: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (until()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("the awaited state never arrived");
}

/** Records every parse as it is ASKED, which is when the file was read; `park` holds the ones it claims. */
function recording(
	discovered: string[],
	asked: string[],
	park: { promise: Promise<void>; holds: (request: MethodRequest<"parseFile">) => boolean },
): ProviderPort {
	return fakeSupervisor({
		discover: () => discovered,
		answers: {
			parseFile: async (request) => {
				asked.push(request.module);
				if (park.holds(request)) await park.promise;
				return parseFake(request);
			},
		},
	});
}

function serviceOver(supervisor: ProviderPort): LexiconService {
	return new LexiconService(store, supervisor, sourceReader(root), root);
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-live-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	await gitInit(root);
});

afterEach(() => {
	live?.stop();
	live = undefined;
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("batch serialization", () => {
	it("never runs two batches at once, because both would race the same store rows", async () => {
		const log: string[] = [];
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The first batch parks on `held`. An unserialized queue would let the second one enter while
		// it waits, which is exactly the overlap that corrupts a shared store row.
		const queue = serializeBatches(async (events) => {
			const label = events.map((e) => e.module).join(",");
			log.push(`enter ${label}`);
			if (label === "src/a.ts") await held;
			log.push(`exit ${label}`);
			return [];
		});

		queue.push([change("src/a.ts")]);
		queue.push([change("src/b.ts")]);
		for (let tick = 0; tick < 8; tick++) await Promise.resolve();

		expect(log).toEqual(["enter src/a.ts"]);

		release();
		await queue.settled();
		expect(log).toEqual(["enter src/a.ts", "exit src/a.ts", "enter src/b.ts", "exit src/b.ts"]);
	});

	it("reports a failing batch instead of taking the daemon down with it", async () => {
		const errors: unknown[] = [];
		const applied: IndexOutcome[][] = [];
		const queue = serializeBatches(
			async (events) => {
				if (events[0]?.module === "src/bad.ts") throw new Error("provider died");
				return events.map((e) => ({ module: e.module, action: "indexed" as const }));
			},
			(outcomes) => applied.push(outcomes),
			(error) => errors.push(error),
		);

		queue.push([change("src/bad.ts")]);
		queue.push([change("src/good.ts")]);
		await queue.settled();

		// The queue survives the failure, which is the point: one unreadable file must not stop the
		// daemon from indexing everything after it.
		expect((errors[0] as Error).message).toBe("provider died");
		expect(applied.flat().map((o) => o.module)).toEqual(["src/good.ts"]);
	});

	it("applies a batch when nobody is listening, which an optional-call chain quietly skips", async () => {
		const seen: string[] = [];
		const queue = serializeBatches(async (events) => {
			seen.push(events[0]?.module ?? "");
			return [];
		});

		queue.push([change("src/a.ts")]);
		await queue.settled();

		// Written after `onApplied?.(await apply(events))` shipped: with no listener that short-circuits
		// its own argument, so the work never ran and a live index would silently stop updating.
		expect(seen).toEqual(["src/a.ts"]);
	});

	it("settles even when nothing was ever pushed", async () => {
		await expect(serializeBatches(async () => []).settled()).resolves.toBeUndefined();
	});
});

describe("holding batches under the scan", () => {
	// The bound: a scan of any length leaves one event per module waiting, the last one.
	it("coalesces what it holds and releases it as one batch, in first-appearance order", async () => {
		const pushed: FileEvent[][] = [];
		const scan = deferred();
		const held = holdBatches(
			(events) => pushed.push(events),
			() => {},
		);
		const released = held.until(scan.promise);

		held.push([change("src/a.ts"), change("src/b.ts")]);
		held.push([{ kind: "deleted", module: "src/a.ts" }]);
		held.push([{ kind: "changed", module: "src/b.ts", contentHash: "h2" }]);
		expect(pushed).toEqual([]);

		scan.release();
		await released;
		expect(pushed).toEqual([
			[
				{ kind: "deleted", module: "src/a.ts" },
				{ kind: "changed", module: "src/b.ts", contentHash: "h2" },
			],
		]);

		held.push([change("src/c.ts")]);
		expect(pushed).toHaveLength(2);
	});

	it("drops what it held and everything after when the scan fails", async () => {
		const pushed: FileEvent[][] = [];
		let refused = 0;
		const held = holdBatches(
			(events) => pushed.push(events),
			() => refused++,
		);
		const released = held.until(Promise.reject(new Error("discovery broke")));

		held.push([change("src/a.ts")]);
		await expect(released).rejects.toThrow("discovery broke");
		held.push([change("src/b.ts")]);

		expect(pushed).toEqual([]);
		expect(refused).toBe(1);
	});
});

describe("watching under the warm scan", () => {
	// The pass skips a current full file; an edit under it is what a later watcher never saw.
	it("applies an edit made under the scan to a file the scan skipped as current", async () => {
		put("a.fake", OLD);
		put("b.fake", "export class Other {}\n");
		const asked: string[] = [];
		const parked = deferred();
		let parking = false;
		const service = serviceOver(
			recording(["a.fake", "b.fake"], asked, {
				...parked,
				holds: (request) => parking && request.module === "b.fake",
			}),
		);
		await service.indexFile("a.fake");
		parking = true;

		const clock = fakeClock();
		const errors: unknown[] = [];
		live = startLiveIndex({
			service,
			workspaceRoot: root,
			clock,
			debounceMs: DEBOUNCE_MS,
			warm: async () => {
				await service.warmupWorkspace();
			},
			onError: (error) => errors.push(error),
		});
		await settle(() => asked.includes("b.fake"));

		put("a.fake", NEW);
		live.inject("a.fake");
		clock.advance(DEBOUNCE_MS);
		parked.release();
		await live.warmed;
		await live.settled();
		await service.upgradeRemaining();

		expect(errors).toEqual([]);
		expect(store.contentHashOf("a.fake")).toBe(hashContent(NEW));
		expect(service.findByName("B")).toHaveLength(1);
		expect(service.findByName("A")).toHaveLength(0);
	});

	// A failed pass leaves an index nothing may write until a restart, so what waited is dropped and
	// nothing further is read.
	it("releases nothing when the scan fails, and stops watching", async () => {
		put("a.fake", OLD);
		const service = serviceOver(
			fakeSupervisor({
				answers: {
					discoverProject: async () => {
						throw new Error("discovery broke");
					},
				},
			}),
		);
		const clock = fakeClock();
		const applied: IndexOutcome[][] = [];
		// The daemon computes the scope before starting the live index, since watchScope() reads it
		// synchronously; nothing else here has asked for it yet on a fresh service.
		await service.currentScope();
		live = startLiveIndex({
			service,
			workspaceRoot: root,
			clock,
			debounceMs: DEBOUNCE_MS,
			warm: async () => {
				await service.warmupWorkspace();
			},
			onApplied: (outcomes) => applied.push(outcomes),
		});
		live.inject("a.fake");
		clock.advance(DEBOUNCE_MS);

		await expect(live.warmed).rejects.toThrow("discovery broke");
		await live.settled();
		expect(applied).toEqual([]);
		expect(store.contentHashOf("a.fake")).toBeNull();

		expect(clock.pending()).toBe(0);
		live.inject("a.fake");
		clock.advance(DEBOUNCE_MS);
		await live.settled();
		expect(applied).toEqual([]);
	});
});
