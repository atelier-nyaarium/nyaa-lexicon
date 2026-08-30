import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Declaration, Import, IndexDepth } from "@nyaa-lexicon/protocol";
import type { Clock } from "../clock";
import { warmRefusal } from "../daemonCli";
import type { ProviderPort } from "../providerPort";
import type { ProviderClaims } from "../routing";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ProviderUnavailableError } from "../supervisor";
import { fakeClock } from "./fakeClock";
import { fakeSupervisor, resolveFake } from "./fakeProvider";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let service: LexiconService;

const claims: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };
const point = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function initGit(): void {
	execFileSync("git", ["init", "-q"], { cwd: root });
}

function declaration(module: string, name: string): Declaration {
	return {
		symbolId: `lexicon fake ${module} ${name}.`,
		kind: "class",
		name,
		range: point,
		selectionRange: point,
		visibility: "public",
		exported: true,
	};
}

function importsFrom(text: string): Import[] {
	return [...text.matchAll(/import\s+["']([^"']+)["']/g)].map((match) => ({
		specifier: match[1] as string,
		imported: [],
		reExport: false,
	}));
}

interface ParseSeen {
	module: string;
	depth?: IndexDepth;
}

/** Controls whether outline requests are echoed or served as full facts. */
function depthSupervisor(
	discovered: string[],
	honorOutline: boolean,
	seen: ParseSeen[],
	options: {
		discovery?: Promise<void>;
		parse?: Promise<void>;
		fullParse?: Promise<void>;
		hangResolve?: boolean;
	} = {},
): ProviderPort {
	return fakeSupervisor({
		claims: [claims],
		answers: {
			discoverProject: async () => {
				await options.discovery;
				return { files: discovered, externalRoots: [], configFiles: [], diagnostics: [] };
			},
			parseFile: async (request) => {
				await (request.depth === "outline" ? options.parse : options.fullParse);
				seen.push({ module: request.module, ...(request.depth === undefined ? {} : { depth: request.depth }) });
				if (request.text.includes("DEAD")) throw new ProviderUnavailableError("provider exited with code null");
				if (request.text.includes("POISON")) throw new Error("poisoned file");
				const declarations = [...request.text.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)].map((match) =>
					declaration(request.module, match[1] as string),
				);
				// A container the file never declares, which the store's admission refuses.
				if (request.text.includes("BADCONTAINER") && declarations[0] !== undefined)
					declarations[0].containerId = `lexicon fake ${request.module} Missing.`;
				const outlined = honorOutline && request.depth === "outline";
				return {
					module: request.module,
					contentHash: request.contentHash,
					declarations,
					references: [],
					imports: importsFrom(request.text),
					// Full parsing must retain this literal.
					literals: outlined ? [] : [{ kind: "string" as const, value: "full-only", range: point }],
					diagnostics: [],
					...(outlined ? { depth: "outline" as const } : {}),
				};
			},
			resolveImport: async (request) => {
				if (options.hangResolve) await new Promise<void>(() => {});
				return resolveFake(request);
			},
		},
	});
}

function deferred(): { promise: Promise<void>; release: () => void } {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** Bounded, so a state that never arrives fails the test instead of hanging it. */
async function settle(until: () => boolean): Promise<void> {
	for (let turn = 0; turn < 1_000; turn++) {
		if (until()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("the awaited state never arrived");
}

function unread(): boolean {
	return service.warmHold()?.includes("not yet read") === true;
}

function serviceOver(supervisor: ProviderPort, clock?: Clock): LexiconService {
	return new LexiconService(store, supervisor, sourceReader(root), root, clock);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-warmup-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("warmup pass", () => {
	it("holds a partial store until each missing root is attempted", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.indexFile("a.fake");

		const parse = deferred();
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, [], { parse: parse.promise }));
		const warming = service.warmupWorkspace();
		// No pass ever completed here, so discovery holds too.
		expect(service.warmHold()).toBe("discovering the workspace");
		await settle(unread);
		expect(service.warmHold()).toContain("1 not yet read");
		parse.release();
		await warming;
		expect(service.warmHold()).toBeNull();

		const fullParse = deferred();
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, [], { fullParse: fullParse.promise }));
		const upgrading = service.upgradeRemaining();
		await Promise.resolve();
		expect(service.findByName("B")).toHaveLength(1);
		fullParse.release();
		await upgrading;
	});

	it("allows a completed store to answer while discovery runs", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.warmupWorkspace();

		const discovery = deferred();
		service = serviceOver(depthSupervisor(["a.fake"], true, [], { discovery: discovery.promise }));
		const warming = service.warmupWorkspace();
		await Promise.resolve();
		expect(service.warmHold()).toBeNull();
		discovery.release();
		await warming;
	});

	it("holds an older completed store through discovery", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.warmupWorkspace();
		store.close();
		const raw = new DatabaseSync(path.join(root, "index.sqlite"));
		raw.prepare("UPDATE meta SET value = ? WHERE key = 'scanSummary'").run(
			JSON.stringify({ tracked: 1, claimed: 1, unclaimed: 0, generated: 0, denied: 0, at: Date.now() }),
		);
		raw.close();
		store = IndexStore.open(path.join(root, "index.sqlite")).store;
		const discovery = deferred();
		service = serviceOver(depthSupervisor(["a.fake"], true, [], { discovery: discovery.promise }));
		const warming = service.warmupWorkspace();
		await Promise.resolve();
		expect(service.warmHold()).toBe("discovering the workspace");
		discovery.release();
		await warming;
		expect(service.warmHold()).toBeNull();
	});

	it("holds a cold store through outline parsing", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		const parse = deferred();
		service = serviceOver(depthSupervisor(["a.fake"], true, [], { parse: parse.promise }));
		const warming = service.warmupWorkspace();
		expect(service.warmHold()).toBe("discovering the workspace");
		await settle(unread);
		expect(service.warmHold()).toContain("0 of 1 files outlined, 1 not yet read");
		parse.release();
		await warming;
		expect(service.warmHold()).toBeNull();
	});

	it("holds a grown root until the restarted scan attempts it", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.warmupWorkspace();
		put("b.fake", "export class B {}\n");

		const parse = deferred();
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, [], { parse: parse.promise }));
		const warming = service.warmupWorkspace();
		// The last pass completed, so discovery answers; the new root holds once it is known.
		expect(service.warmHold()).toBeNull();
		await settle(unread);
		expect(service.warmHold()).toContain("1 not yet read");
		parse.release();
		await warming;
		expect(service.warmHold()).toBeNull();
	});

	it("removes a root that vanishes before its attempt from coverage", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const parse = deferred();
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, [], { parse: parse.promise }));
		const warming = service.warmupWorkspace();
		await settle(unread);
		rmSync(path.join(root, "b.fake"));
		parse.release();
		const outcomes = await warming;
		expect(outcomes).toContainEqual(expect.objectContaining({ module: "b.fake", action: "forgotten" }));
		expect(service.warmHold()).toBeNull();
	});

	it("removes a failed root from coverage", async () => {
		initGit();
		put("bad.fake", "POISON\n");
		service = serviceOver(depthSupervisor(["bad.fake"], true, []));
		const outcomes = await service.warmupWorkspace();
		expect(outcomes).toContainEqual(expect.objectContaining({ module: "bad.fake", action: "skipped" }));
		expect(service.warmHold()).toBeNull();
	});

	it("does not hold while upgrades run", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		const fullParse = deferred();
		service = serviceOver(depthSupervisor(["a.fake"], true, [], { fullParse: fullParse.promise }));
		const warming = service.warmupWorkspace();
		await warming;
		const upgrading = service.upgradeRemaining();
		await Promise.resolve();
		expect(service.warmHold()).toBeNull();
		fullParse.release();
		await upgrading;
	});

	it("reports a failed scan as a plain admission error", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(
			depthSupervisor(["a.fake"], true, [], { discovery: Promise.reject(new Error("discovery broke")) }),
		);
		await service.warmupWorkspace().catch(() => {});
		const refusal = warmRefusal(service);
		expect(refusal).toBeInstanceOf(Error);
		expect(refusal).not.toHaveProperty("retryInMs");
		expect(refusal?.message).toContain("discovery broke");
	});

	it("bounds tree-first preparation across import resolution", async () => {
		initGit();
		put("a.fake", 'import "./b.fake"\nexport class A {}\n');
		put("b.fake", "export class B {}\n");
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, []));
		await service.warmupWorkspace();
		const clock = fakeClock();
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, [], { hangResolve: true }), clock);
		const preparing = service.ensureTreeForModule("a.fake");
		clock.advance(60_000);
		await preparing;
	});

	it("covers each admission branch", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		const parse = deferred();
		service = serviceOver(depthSupervisor(["a.fake"], true, [], { parse: parse.promise }));
		const warming = service.warmupWorkspace();
		await Promise.resolve();
		const starting = warmRefusal(service);
		expect(starting).toBeInstanceOf(Error);
		expect(starting).toHaveProperty("retryInMs");
		parse.release();
		await warming;
		expect(warmRefusal(service)).toBeNull();
	});
	it("stores honored outline facts as outline, then upgrades them to full", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		const seen: ParseSeen[] = [];
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, seen));

		await service.warmupWorkspace();
		// The warmup genuinely asked for outline, not full facts it then discarded.
		expect(seen.map((p) => p.depth)).toEqual(["outline", "outline"]);
		expect(store.depthTotals()).toMatchObject({ outline: 2, full: 0 });
		expect(service.findByName("A")).toHaveLength(1);

		await service.upgradeRemaining();
		expect(store.depthTotals()).toMatchObject({ outline: 0, full: 2 });
		const status = service.indexStatus();
		expect(status.outlineFiles).toBe(0);
		expect(status.fullFiles).toBe(2);
	});

	it("records full when a provider ignores the outline request, owing no upgrade", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		const seen: ParseSeen[] = [];
		service = serviceOver(depthSupervisor(["a.fake"], false, seen));

		await service.warmupWorkspace();
		expect(store.depthTotals()).toMatchObject({ outline: 0, full: 1 });

		await service.upgradeRemaining();
		// One parse total: the silent full answer left nothing owed.
		expect(seen.filter((p) => p.module === "a.fake")).toHaveLength(1);
	});

	it("does not demote a full store on a warm restart, and skips unchanged files entirely", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		const seen: ParseSeen[] = [];
		service = serviceOver(depthSupervisor(["a.fake"], true, seen));

		await service.warmupWorkspace();
		await service.upgradeRemaining();
		const parses = seen.length;

		await service.warmupWorkspace();
		expect(store.depthTotals()).toMatchObject({ outline: 0, full: 1 });
		expect(seen.length).toBe(parses);
	});

	it("serves a requestFull order before the background backlog", async () => {
		initGit();
		const modules = ["a.fake", "b.fake", "c.fake", "d.fake", "z.fake"];
		for (const module of modules) put(module, `export class C${module[0]?.toUpperCase()} {}\n`);
		service = serviceOver(depthSupervisor(modules, true, []));

		await service.warmupWorkspace();
		// The upgrade is mid-flight when the order arrives, so this exercises real preemption:
		// z sorts last in the backlog, and the order must beat the alphabetical walk to it.
		const upgrading = service.upgradeRemaining();
		await service.ensureTreeForModule("z.fake");
		const outlineAtOrderTime = store.depthTotals().outline;

		expect(store.depthOf("z.fake")).toBe("full");
		expect(outlineAtOrderTime).toBeGreaterThan(0);
		await upgrading;
		expect(store.depthTotals().outline).toBe(0);
	});

	it("pulls a symbol's direct imports into the ordered tree", async () => {
		initGit();
		put("a.fake", 'import "./b.fake"\nexport class A {}\n');
		put("b.fake", "export class B {}\n");
		put("c.fake", "export class C {}\n");
		service = serviceOver(depthSupervisor(["a.fake", "b.fake", "c.fake"], true, []));

		await service.warmupWorkspace();
		const [found] = service.findByName("A");
		await service.ensureTreeFor((found as { symbolId: string }).symbolId);

		expect(store.depthOf("a.fake")).toBe("full");
		expect(store.depthOf("b.fake")).toBe("full");
		expect(store.depthOf("c.fake")).toBe("outline");
	});

	it("persists a parse failure, skips it in the upgrade, and clears it on recovery", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("bad.fake", "POISON\n");
		service = serviceOver(depthSupervisor(["a.fake", "bad.fake"], true, []));

		await service.warmupWorkspace();
		expect(store.parseFailures().map((f) => f.module)).toEqual(["bad.fake"]);

		await service.upgradeRemaining();
		expect(store.depthOf("a.fake")).toBe("full");
		// Named, not only counted.
		const status = service.indexStatus("bad.fake");
		expect(status).toMatchObject({ failures: 1, failed: [{ module: "bad.fake", reason: expect.any(String) }] });
		expect(status.concerning).toEqual(status.failed[0]);
		expect(service.indexStatus("a.fake").concerning).toBeUndefined();

		put("bad.fake", "export class Fixed {}\n");
		await service.indexFile("bad.fake");
		expect(store.parseFailures()).toEqual([]);
	});

	it("drops a failure row once the stored facts are found current", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.warmupWorkspace();
		await service.upgradeRemaining();
		// What a timed-out re-read leaves.
		store.recordFailure("a.fake", "timed out");
		expect(service.indexStatus().failures).toBe(1);

		await service.indexFile("a.fake", "full", true);
		expect(service.indexStatus().failures).toBe(0);
	});

	it("classifies a dead provider as unavailable, blaming no file", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("gone.fake", "DEAD\n");
		service = serviceOver(depthSupervisor(["a.fake", "gone.fake"], true, []));

		const outcomes = await service.warmupWorkspace();
		const skipped = outcomes.find((outcome) => outcome.module === "gone.fake");

		expect(skipped).toMatchObject({ action: "skipped", cause: "providerDown", reason: "provider unavailable" });
		// Provider outages do not create per-file failure records.
		expect(store.parseFailures()).toEqual([]);
		expect(service.indexStatus().failures).toBe(0);
		// Nor does the pass read as covered: the file is unread, and every request says so until a restart.
		expect(service.warmFailure()).toMatch(/provider was unavailable/);
		expect(service.warmHold()).toBeNull();
		expect(store.readScanSummary()?.outlined).not.toBe(true);

		await service.applyBatch([{ kind: "changed", module: "gone.fake", contentHash: "gone-2" }]);
		expect(service.warmFailure()).toMatch(/provider was unavailable/);
	});

	it("records a plain provider error as a parse failure for that file", async () => {
		initGit();
		put("bad.fake", "POISON\n");
		service = serviceOver(depthSupervisor(["bad.fake"], true, []));

		const outcomes = await service.warmupWorkspace();

		expect(outcomes).toContainEqual({
			module: "bad.fake",
			action: "skipped",
			cause: "parseFailed",
			reason: "parse failed",
			failure: "poisoned file",
		});
		expect(store.parseFailureOf("bad.fake")).toEqual({ module: "bad.fake", reason: "poisoned file" });
	});

	it("classifies an escaped indexer fault, records it in its own words, and keeps the pass covered", async () => {
		initGit();
		put("bad.fake", "export class Bad {}\n");
		put("good.fake", "export class Good {}\n");
		const replaceFile = store.replaceFile.bind(store);
		store.replaceFile = (...args: Parameters<IndexStore["replaceFile"]>) => {
			if (args[0] === "bad.fake") throw new Error("store broke");
			return replaceFile(...args);
		};
		service = serviceOver(depthSupervisor(["bad.fake", "good.fake"], true, []));

		const outcomes = await service.warmupWorkspace();

		expect(outcomes).toContainEqual({
			module: "bad.fake",
			action: "skipped",
			cause: "fault",
			reason: "the indexer failed on this file",
			failure: "store broke",
		});
		expect(store.parseFailureOf("bad.fake")?.reason).toBe("the indexer failed on this file: store broke");
		// One file's fault is not the workspace's: a restart would meet the same fault, so the pass serves.
		expect(service.warmFailure()).toBeNull();
		expect(service.warmHold()).toBeNull();
		expect(service.findByName("Good")).toHaveLength(1);
	});

	it("records an answer the store refuses as that file's parse failure", async () => {
		initGit();
		put("orphan.fake", "BADCONTAINER export class Child {}\n");
		service = serviceOver(depthSupervisor(["orphan.fake"], true, []));

		const outcomes = await service.warmupWorkspace();

		expect(outcomes).toContainEqual(
			expect.objectContaining({ module: "orphan.fake", cause: "parseFailed", action: "skipped" }),
		);
		expect(store.parseFailureOf("orphan.fake")?.reason).toMatch(/refused: .*is not declared in this file/);
		expect(service.warmFailure()).toBeNull();
	});
});

describe("accounting for every file the scan saw", () => {
	// The parts must sum, or a reader cannot tell a defect from a readme.
	it("splits tracked files into disjoint parts that add up", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		put("b.fake", "export class B {}\n");
		put("README.md", "# readme\n");
		put("data.json", "{}\n");
		service = serviceOver(depthSupervisor(["a.fake", "b.fake"], true, []));

		await service.warmupWorkspace();
		const scan = store.readScanSummary();

		expect(scan).not.toBeNull();
		const { tracked, claimed, unclaimed, generated, denied } = scan as NonNullable<typeof scan>;
		expect(claimed).toBe(2);
		// At least the readme and the json. The harness also writes its sqlite files here, and they
		// are unclaimed too, which is exactly the kind of file this accounting exists to explain.
		expect(unclaimed).toBeGreaterThanOrEqual(2);
		expect(claimed + unclaimed + generated + denied).toBe(tracked);
	});

	// A watcher batch recomputed the counts and then never stored them.
	it("refreshes the stored summary after a watcher batch", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.warmupWorkspace();
		expect(store.readScanSummary()?.claimed).toBe(1);

		put("b.fake", "export class B {}\n");
		await service.applyBatch([{ kind: "changed", module: "b.fake", contentHash: "b1" }]);

		expect(store.readScanSummary()?.claimed).toBe(2);
	});

	it("settles coverage when a watcher adds or removes a root", async () => {
		initGit();
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["a.fake"], true, []));
		await service.warmupWorkspace();

		put("b.fake", "export class B {}\n");
		await service.applyBatch([{ kind: "changed", module: "b.fake", contentHash: "b1" }]);
		expect(service.warmHold()).toBeNull();

		rmSync(path.join(root, "a.fake"));
		await service.applyBatch([{ kind: "deleted", module: "a.fake" }]);
		expect(service.warmHold()).toBeNull();

		put("denied.fake", "export class Denied {}\n");
		put("lexicon.json", JSON.stringify({ deny: ["denied.fake"] }));
		await service.applyBatch([{ kind: "changed", module: "lexicon.json", contentHash: "deny" }]);
		expect(service.warmHold()).toBeNull();
	});

	// A failed root holds no row, and it is not the watcher's to attempt again.
	it("keeps the watcher running after a root that failed to parse", async () => {
		initGit();
		put("bad.fake", "POISON\n");
		put("a.fake", "export class A {}\n");
		service = serviceOver(depthSupervisor(["bad.fake", "a.fake"], true, []));
		await service.warmupWorkspace();
		expect(store.parseFailureOf("bad.fake")).not.toBeNull();

		put("b.fake", "export class B {}\n");
		const outcomes = await service.applyBatch([{ kind: "changed", module: "b.fake", contentHash: "b1" }]);
		expect(outcomes).toContainEqual(expect.objectContaining({ module: "b.fake", action: "indexed" }));
		expect(service.warmHold()).toBeNull();
	});

	// Defaulting a missing part would print arithmetic that does not sum.
	it("refuses a summary missing any part", () => {
		store.writeScanSummary({ tracked: 5, claimed: 5, unclaimed: 0, generated: 0, denied: 0, outlined: true });
		expect(store.readScanSummary()?.tracked).toBe(5);

		// biome-ignore lint/suspicious/noExplicitAny: writing a legacy shape is the point.
		store.writeScanSummary({ discovered: 5, claimed: 5 } as any);
		expect(store.readScanSummary()).toBeNull();
	});
});
