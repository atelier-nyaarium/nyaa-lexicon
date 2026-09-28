import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent } from "@nyaa-lexicon/protocol";
import type { MethodRequest, ProviderPort } from "../providerPort";
import { journaledStep } from "../refactorStep";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { TransactionManager } from "../transactions";
import type { WorkspaceGate } from "../workspaceGate";
import { fakeSupervisor, parseFake } from "./fakeProvider";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;

const OLD = "export class A {}\n";
const NEW = "export class B {}\n";

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

/**
 * Records every parse as it is ASKED, which is when the file was read.
 *
 * `park` holds the parses it claims, so a test decides what is in flight when.
 */
function recording(
	discovered: string[],
	asked: string[],
	park: { promise: Promise<void>; holds: (request: MethodRequest<"parseFile">) => boolean },
): ProviderPort {
	return fakeSupervisor({
		discover: () => discovered,
		answers: {
			parseFile: async (request) => {
				asked.push(`${request.depth ?? "full"} ${request.module}`);
				if (park.holds(request)) await park.promise;
				return parseFake(request);
			},
		},
	});
}

/** Enough turns for any unblocked road to reach its next parse. */
async function turns(count = 32): Promise<void> {
	for (let turn = 0; turn < count; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A held gate, admitted and holding by the time this resolves. */
async function blocker(gate: WorkspaceGate): Promise<{ holding: Promise<void>; release: () => void }> {
	const blocked = deferred();
	let holding = false;
	const held = gate.exclusive(async () => {
		holding = true;
		await blocked.promise;
	});
	await settle(() => holding);
	return { holding: held, release: blocked.release };
}

function serviceOver(supervisor: ProviderPort): LexiconService {
	return new LexiconService(store, supervisor, sourceReader(root), root);
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-index-gate-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	await gitInit(root);
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("every indexing road takes the workspace gate", () => {
	// The upgrade parses bytes read before the batch wrote newer ones. Ungated it commits last and
	// the store regresses to the older parse.
	it("keeps the newer parse when a batch and an upgrade reach one module", async () => {
		put("a.fake", OLD);
		const asked: string[] = [];
		const slow = deferred();
		const parksOldFullParse = (request: MethodRequest<"parseFile">) =>
			request.depth === undefined && request.text === OLD;
		const service = serviceOver(recording(["a.fake"], asked, { ...slow, holds: parksOldFullParse }));
		const gate = service.gate;

		await service.warmupWorkspace();
		expect(store.depthOf("a.fake")).toBe("outline");

		const upgrading = service.upgradeRemaining();
		await settle(() => asked.some((entry) => entry.startsWith("full")));

		put("a.fake", NEW);
		const batching = gate.exclusive(() =>
			service.applyBatch([{ kind: "changed", module: "a.fake", contentHash: "a-new" }]),
		);
		for (let turn = 0; turn < 32; turn++) await Promise.resolve();
		expect(asked.filter((entry) => entry.startsWith("full"))).toHaveLength(1);

		slow.release();
		await upgrading;
		await batching;

		expect(store.contentHashOf("a.fake")).toBe(hashContent(NEW));
		expect(service.findByName("B")).toHaveLength(1);
		expect(service.findByName("A")).toHaveLength(0);
	});

	// One hold for the whole walk would block every reader for the length of a full upgrade.
	it("releases the gate between modules, so a writer queued mid-upgrade runs before the walk ends", async () => {
		const modules = ["a.fake", "b.fake", "c.fake"];
		for (const module of modules) put(module, `export class ${module[0]?.toUpperCase()} {}\n`);
		const asked: string[] = [];
		const slow = deferred();
		const service = serviceOver(
			recording(modules, asked, { ...slow, holds: (request) => request.depth === undefined }),
		);
		const gate = service.gate;

		await service.warmupWorkspace();
		asked.length = 0;

		const upgrading = service.upgradeRemaining();
		await settle(() => asked.length > 0);
		const writer = gate.exclusive(async () => void asked.push("writer"));
		slow.release();
		await upgrading;
		await writer;

		expect(asked.indexOf("writer")).toBeGreaterThan(0);
		expect(asked.indexOf("writer")).toBeLessThan(asked.length - 1);
	});

	// A writer admitted between two files proves both halves: the scan releases per file, and the
	// next file waits rather than parsing beside whoever holds the gate.
	it("holds a scan's next root until a writer admitted mid-scan releases", async () => {
		const modules = ["a.fake", "b.fake", "c.fake"];
		for (const module of modules) put(module, `export class ${module[0]?.toUpperCase()} {}\n`);
		const asked: string[] = [];
		const slow = deferred();
		let parking = true;
		const service = serviceOver(recording(modules, asked, { ...slow, holds: () => parking }));
		const gate = service.gate;

		const scanning = service.warmupWorkspace();
		await settle(() => asked.length === 1);

		const writer = blocker(gate);
		parking = false;
		slow.release();
		const held = await writer;
		await turns();

		expect(asked).toHaveLength(1);
		held.release();
		await held.holding;
		await scanning;
		expect(asked).toHaveLength(modules.length);
	});

	// The import walk indexes whatever the roots reach, which is the scan's other parsing loop.
	it("holds a scan's import walk until a writer admitted mid-scan releases", async () => {
		put("a.fake", 'import "./b.fake"\nexport class A {}\n');
		put("b.fake", 'import "./c.fake"\nexport class B {}\n');
		put("c.fake", "export class C {}\n");
		// Ignored files are no root; an import is what makes them reachable, which is this walk.
		put(".gitignore", "b.fake\nc.fake\n");
		const asked: string[] = [];
		const slow = deferred();
		let parking = true;
		const service = serviceOver(recording(["a.fake"], asked, { ...slow, holds: () => parking }));
		const gate = service.gate;

		const scanning = service.warmupWorkspace();
		await settle(() => asked.length === 1);

		const writer = blocker(gate);
		parking = false;
		slow.release();
		const held = await writer;
		await turns();

		expect(asked).toEqual(["outline a.fake"]);
		held.release();
		await held.holding;
		await scanning;
		expect(asked).toHaveLength(3);
	});
});

describe("what a status says the index is doing", () => {
	// Read while the work runs, since a status bar tells a busy index from an idle one.
	it("names a scan and a batch with their counts, a refactor step by its kind, and nothing once idle", async () => {
		put("a.fake", OLD);
		put("b.fake", OLD);
		const asked: string[] = [];
		const park = { ...deferred(), holds: (request: MethodRequest<"parseFile">) => request.module === "b.fake" };
		const service = serviceOver(recording(["a.fake", "b.fake"], asked, park));
		const doing = () => service.indexStatus().activity;

		const scanning = service.indexWorkspace();
		await settle(() => asked.includes("full b.fake"));
		const scan = doing();
		park.release();
		await scanning;
		await service.upgradeRemaining();
		const idle = doing();

		Object.assign(park, deferred());
		put("b.fake", NEW);
		const batching = service.gate.exclusive(() =>
			service.applyBatch([{ kind: "changed", module: "b.fake", contentHash: "b-new" }]),
		);
		await settle(() => asked.filter((entry) => entry === "full b.fake").length === 2);
		const batch = doing();
		park.release();
		await batching;

		const planning = deferred();
		const stepping = journaledStep<string>(
			{
				service,
				transactions: new TransactionManager(store, root),
				write: (work) => service.gate.exclusive(async () => work()),
			},
			{
				kind: "rename",
				hold: "joinOrOwn",
				refuse: () => "refused",
				succeed: () => "written",
				plan: async () => {
					await planning.promise;
					return { done: "planned" };
				},
			},
		);
		await turns();
		const step = doing();
		planning.release();
		await stepping;

		expect({ scan, idle, batch, step, after: doing() }).toEqual({
			scan: { kind: "scan", done: 1, total: 2 },
			idle: null,
			batch: { kind: "batch", done: 0, total: 1 },
			step: { kind: "refactor", label: "rename" },
			after: null,
		});
	});

	// One edited file can hold the gate for minutes over the roots it brings, which a file count hides.
	it("names and counts a batch's re-parse of many modules beyond its own files", async () => {
		put(".gitignore", "gen/\n");
		put("a.fake", OLD);
		const generated = Array.from({ length: 12 }, (_, at) => `gen/f${String(at).padStart(2, "0")}.fake`);
		for (const module of generated) put(module, OLD);
		const asked: string[] = [];
		const park = {
			...deferred(),
			holds: (request: MethodRequest<"parseFile">) => request.module === "gen/f05.fake",
		};
		const service = serviceOver(recording(["a.fake"], asked, park));
		await service.indexWorkspace();

		put(".gitignore", "");
		const batching = service.gate.exclusive(() =>
			service.applyBatch([{ kind: "changed", module: ".gitignore", contentHash: hashContent("") }]),
		);
		await settle(() => asked.includes("full gen/f05.fake"));
		const batch = service.indexStatus().activity;
		park.release();
		await batching;

		expect(batch).toEqual({ kind: "batch", label: "re-parsing modules", done: 5, total: 12 });
	});
});
