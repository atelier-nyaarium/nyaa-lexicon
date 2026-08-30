import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Declaration, GapRowSchema, type Import } from "@nyaa-lexicon/protocol";
import { KNOWLEDGE_SWEEP_EVERY_MS, startLiveIndex } from "../liveIndex";
import { type ProviderClaims, routeModule, routingContextOf } from "../routing";
import { LexiconService } from "../service";
import { sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { ORPHAN_TTL_MS, type SweepPass } from "../subjects";
import type { ProviderSupervisor } from "../supervisor";
import { type FakeClock, fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

let root: string;
let storeDir: string;
let store: IndexStore;
let service: LexiconService;
let clock: FakeClock;

const DAY = 24 * 60 * 60 * 1000;
const CART = "lexicon fake cart.fake Cart#";
const CART_TEXT = "export class Cart {\n  total() { return 1; }\n}\n";
const claims: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };

/** Every module present and parsing, nothing new: the timer's pass. */
const idle: SweepPass = { presence: () => "presentParsing", newModules: new Set() };

function put(module: string, text: string): void {
	const full = path.join(root, module);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function remove(module: string): void {
	rmSync(path.join(root, module));
}

/** Classes with the span of their body, so two identical bodies digest alike and an edited one does not. */
function parseClasses(module: string, text: string): Declaration[] {
	const lines = text.split("\n");
	const out: Declaration[] = [];
	for (const [line, source] of lines.entries()) {
		const match = /^export class ([A-Za-z_$][\w$]*)/.exec(source);
		if (match === null) continue;
		let end = line;
		while (end < lines.length - 1 && !(lines[end] as string).includes("}")) end++;
		const name = match[1] as string;
		out.push({
			symbolId: `lexicon fake ${module} ${name}#`,
			kind: "class",
			name,
			range: { start: { line, character: 0 }, end: { line: end, character: (lines[end] as string).length } },
			selectionRange: { start: { line, character: 13 }, end: { line, character: 13 + name.length } },
			visibility: "public",
			exported: true,
		});
	}
	return out;
}

function importsFrom(text: string): Import[] {
	return [...text.matchAll(/import\s+["']([^"']+)["']/g)].map((match) => ({
		specifier: match[1] as string,
		imported: [],
		reExport: false,
	}));
}

function fakeSupervisor(): ProviderSupervisor {
	let evidence: () => Iterable<string> = () => [];
	let routing: ReturnType<typeof routingContextOf> | undefined;
	const context = () => {
		routing ??= routingContextOf(evidence());
		return routing;
	};
	return {
		running: () => [claims],
		route: (module: string) => routeModule(module, [claims], context()),
		evidenceFrom: (modules: () => Iterable<string>) => {
			evidence = modules;
		},
		observeWorkspace: (modules: Iterable<string>) => {
			routing = routingContextOf(modules);
		},
		observeModule: (module: string) => context().observe(module),
		askProvider: async () => ({ files: [], externalRoots: [], configFiles: [], diagnostics: [] }),
		ask: async (_module: string, method: string, params: unknown) => {
			if (method === "parseFile") {
				const request = params as {
					module: string;
					contentHash: string;
					text: string;
					depth?: "outline" | "surface";
				};
				return {
					module: request.module,
					contentHash: request.contentHash,
					...(request.depth === "outline" ? { depth: "outline" as const } : {}),
					declarations: parseClasses(request.module, request.text),
					references: [],
					imports: importsFrom(request.text),
					literals: [],
					diagnostics: request.text.includes("SYNTAX")
						? [{ severity: "error" as const, message: "syntax error" }]
						: [],
				};
			}
			if (method === "resolveImport") {
				const request = params as { fromModule: string; specifier: string };
				if (!request.specifier.startsWith(".")) return { status: "unresolved", reason: "NotImplemented" };
				return {
					status: "resolved",
					module: path.posix.normalize(
						path.posix.join(path.posix.dirname(request.fromModule), request.specifier),
					),
				};
			}
			throw new Error(`unexpected method ${method}`);
		},
		stopAll: () => {},
	} as unknown as ProviderSupervisor;
}

/** Outside the workspace, so the watcher never sees the store's own writes as a batch. */
function open(compatibility = "major-a"): void {
	store = IndexStore.open(path.join(storeDir, "index.sqlite"), compatibility, undefined, clock).store;
	service = new LexiconService(store, fakeSupervisor(), sourceReader(root), root, clock);
}

async function scan(): Promise<void> {
	await service.indexWorkspace();
}

async function record(symbolId: string, prose = "Holds items until checkout."): Promise<void> {
	const cited = store.declaration(symbolId)?.factId as string;
	const outcome = await service.recordAnswer(symbolId, "describe", prose, [cited]);
	if (!outcome.recorded) throw new Error(outcome.reason);
}

const subject = (symbolId: string) => store.subjects.forAddress(symbolId);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-sweep-"));
	storeDir = mkdtempSync(path.join(tmpdir(), "lexicon-sweep-store-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	clock = fakeClock(1_700_000_000_000);
	open();
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(storeDir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the sweep after a scan", () => {
	it("orphans a subject whose file was deleted, dated and with no evidence, and the queue never leads with it", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);
		clock.advance(DAY);

		remove("cart.fake");
		await scan();

		expect(subject(CART)).toMatchObject({ state: "orphaned", evidence: "none", orphanedAt: clock.now() });
		const gaps = service.knowledgeGaps();
		expect(gaps.total).toBe(0);
		expect(gaps.rows.filter((row) => row.stranded !== true)).toEqual([]);
		expect(service.knowledge.staleAnswerCount()).toBe(0);
		const recalled = service.recallAnswer(CART, "describe");
		expect(recalled?.stranded).toBeDefined();
		const demand = service.demandOf(CART, "describe", recalled);
		if (demand !== null) service.recordDemand(demand);
		expect(store.subjects.stateOf(CART, () => null).gaps).toBe(0);
	});

	it("leaves a subject alone while its file is present and failing to parse", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);

		put("cart.fake", `${CART_TEXT}SYNTAX\n`);
		await scan();

		expect(store.declaration(CART)).not.toBeNull();
		expect(subject(CART)).toMatchObject({ state: "bound", orphanedAt: null });
	});

	it("orphans a subject whose file was recreated without the symbol, and binds it again when the symbol returns", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);

		remove("cart.fake");
		put("cart.fake", "export class Other {}\n");
		await scan();
		expect(subject(CART)).toMatchObject({ state: "orphaned", evidence: "none" });

		put("cart.fake", CART_TEXT);
		await scan();
		expect(subject(CART)).toMatchObject({ state: "bound", orphanedAt: null, evidence: "sameLocator" });
	});

	it("rebinds on an exact digest match when the file moves, undated, and diagnoses the old address as moved", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);

		remove("cart.fake");
		put("shop/cart.fake", CART_TEXT);
		await scan();

		const moved = "lexicon fake shop/cart.fake Cart#";
		expect(subject(CART)).toBeNull();
		expect(subject(moved)).toMatchObject({
			state: "bound",
			evidence: "batchExactMatch",
			orphanedAt: null,
			fromSymbolId: CART,
		});
		expect(service.recallAnswer(moved, "describe")?.answer.prose).toBe("Holds items until checkout.");
		expect(service.diagnoseSubject(CART).kind).toBe("moved");
		expect(store.readScanSummary()?.knowledgeSweep).toMatchObject({ rebound: 1, orphaned: 0 });
	});

	it("orphans with no evidence when the move edits the body in the same save", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);

		remove("cart.fake");
		put("shop/cart.fake", "export class Cart {\n  total() { return 2; }\n}\n");
		await scan();

		expect(subject(CART)).toMatchObject({ state: "orphaned", evidence: "none" });
	});

	it("never rebinds to a different name or kind, whatever the body digests to", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);

		remove("cart.fake");
		put("other.fake", CART_TEXT.replace("class Cart", "class Other"));
		await scan();

		expect(subject(CART)).toMatchObject({ state: "orphaned", evidence: "none" });
	});

	it("forgets a subject's digest when its module is written without one, so an unknown body never matches", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);
		expect(subject(CART)?.lastDigest).not.toBeNull();

		await service.indexFile("cart.fake", "outline");
		expect(subject(CART)).toMatchObject({ state: "bound", lastDigest: null, lastCoverage: null });

		remove("cart.fake");
		put("shop/cart.fake", CART_TEXT);
		await scan();
		expect(subject(CART)).toMatchObject({ state: "orphaned", evidence: "none" });
	});

	it("leaves the surviving twin alone, since its module is not new to the pass, and orphans the deleted one", async () => {
		put("a.fake", CART_TEXT);
		put("b.fake", CART_TEXT);
		await scan();
		const twin = "lexicon fake a.fake Cart#";
		await record(twin);

		remove("a.fake");
		await scan();

		expect(subject(twin)).toMatchObject({ state: "orphaned", evidence: "none" });
		expect(store.declaration("lexicon fake b.fake Cart#")).not.toBeNull();
		expect(subject("lexicon fake b.fake Cart#")).toBeNull();
	});

	it("orphans with ambiguous evidence when two new modules match by digest, naming both", async () => {
		put("a.fake", CART_TEXT);
		await scan();
		const original = "lexicon fake a.fake Cart#";
		await record(original);

		remove("a.fake");
		put("b.fake", CART_TEXT);
		put("c.fake", CART_TEXT);
		await scan();

		expect(subject(original)).toMatchObject({ state: "orphaned", evidence: "ambiguous" });
		const diagnosis = service.diagnoseSubject(original);
		expect(diagnosis.kind).toBe("stranded");
		expect(diagnosis.candidates.sort()).toEqual(["lexicon fake b.fake Cart#", "lexicon fake c.fake Cart#"]);
		expect(store.readScanSummary()?.knowledgeSweep).toMatchObject({ orphaned: 1, ambiguous: 1 });
	});

	it("orphans with ambiguous evidence, naming the holder, when the matching target address is held", async () => {
		put("a.fake", CART_TEXT);
		put("b.fake", CART_TEXT);
		await scan();
		const first = "lexicon fake a.fake Cart#";
		const second = "lexicon fake b.fake Cart#";
		await record(first);
		await record(second, "The other cart.");

		// Forgetting b strands its subject; recreating b in the same batch that deletes a makes b new to
		// the pass, restored at index time, so a's match lands on an address b's subject holds.
		remove("b.fake");
		await service.applyBatch([{ kind: "deleted", module: "b.fake" }]);
		expect(subject(second)).toMatchObject({ state: "orphaned" });
		remove("a.fake");
		put("b.fake", CART_TEXT);
		await service.applyBatch([
			{ kind: "deleted", module: "a.fake" },
			{ kind: "changed", module: "b.fake", contentHash: null },
		]);

		expect(subject(second)).toMatchObject({ state: "bound", evidence: "sameLocator" });
		expect(subject(first)).toMatchObject({ state: "orphaned", evidence: "ambiguous" });
		expect(service.diagnoseSubject(first).candidates).toEqual([second]);
	});

	it("still runs the seeded fallback on a workspace whose only knowledge is stranded, and carries the window", async () => {
		put("cart.fake", CART_TEXT);
		put("hub.fake", "export class Hub {}\n");
		await scan();
		await record(CART);
		remove("cart.fake");
		await scan();

		const gaps = service.knowledgeGaps();

		// Nothing references Hub, so the fallback seeds no candidate; it still ran, and the window follows it.
		expect(gaps).toMatchObject({ seeded: true, filtered: true, total: 0, stranded: 1 });
		expect(gaps.rows.map((row) => [row.symbolId, row.stranded === true])).toEqual([[CART, true]]);
		service.invalidateAnswer(CART, "checkout was rewritten", "describe", "sweep");
		expect(service.knowledgeGaps().rows[0]).toMatchObject({ stranded: true, why: "doubted" });
		expect(gaps.rows[0]).toMatchObject({
			why: "stale",
			strandedAt: clock.now(),
			evidence: "none",
			module: "cart.fake",
		});
	});

	it("reports what it did on the scan summary, which overview carries", async () => {
		put("cart.fake", CART_TEXT);
		await scan();

		expect(service.overview().scan?.knowledgeSweep).toEqual({
			examined: 0,
			rebound: 0,
			orphaned: 0,
			deleted: 0,
			ambiguous: 0,
			stoppedEarly: false,
		});
	});
});

describe("aging", () => {
	it("deletes an orphan thirty days on from the timer, so an idle workspace ages", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);
		remove("cart.fake");
		await scan();
		const orphaned = subject(CART)?.subjectId as string;

		const reports: number[] = [];
		const live = startLiveIndex({
			service,
			workspaceRoot: root,
			clock,
			onSwept: (report) => reports.push(report.deleted),
		});
		try {
			// The first firing finds nothing expired; the re-armed one, thirty days on, deletes.
			clock.advance(KNOWLEDGE_SWEEP_EVERY_MS);
			await Bun.sleep(0);
			expect(reports).toEqual([0]);
			expect(store.subjects.byId(orphaned)).not.toBeNull();
			clock.advance(ORPHAN_TTL_MS);
			await Bun.sleep(0);
		} finally {
			live.stop();
		}

		expect(reports).toEqual([0, 1]);
		expect(store.subjects.byId(orphaned)).toBeNull();
		expect(service.recallAnswer(CART, "describe")).toBeNull();
		expect(service.diagnoseSubject(CART).kind).toBe("unknown");

		// Stopped means stopped: no timer stands and an hour later nothing sweeps.
		expect(clock.pending()).toBe(0);
		const swept = reports.length;
		clock.advance(KNOWLEDGE_SWEEP_EVERY_MS);
		await Bun.sleep(0);
		expect(reports).toHaveLength(swept);
	});

	it("never starts a sweep queued behind a batch once stopped, and the batch still applies", async () => {
		put("cart.fake", CART_TEXT);
		await scan();

		const swept: number[] = [];
		const applied: number[] = [];
		const live = startLiveIndex({
			service,
			workspaceRoot: root,
			clock,
			debounceMs: 10,
			onApplied: (outcomes) => applied.push(outcomes.length),
			onSwept: (report) => swept.push(report.examined),
		});
		put("cart.fake", `${CART_TEXT}export class Other {}\n`);
		live.inject("cart.fake");
		// One advance fires the debounce and then the hour, so the sweep is queued behind the batch.
		clock.advance(KNOWLEDGE_SWEEP_EVERY_MS);
		live.stop();
		await live.settled();

		expect(applied).toEqual([1]);
		expect(swept).toEqual([]);
		expect(store.declaration("lexicon fake cart.fake Other#")).not.toBeNull();
	});

	it("sweeps nothing from the timer before a prune has decided presence", () => {
		const bound = store.subjects.mint(CART, clock.now());

		expect(service.sweepKnowledge()).toMatchObject({ examined: 0, orphaned: 0 });
		expect(store.subjects.byId(bound.subjectId)).toMatchObject({ state: "bound" });
	});

	it("does not delete when the clock reads behind the date", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);
		remove("cart.fake");
		await scan();
		const at = subject(CART)?.orphanedAt as number;

		const report = store.sweepSubjects(10, idle, at - ORPHAN_TTL_MS);

		expect(report.deleted).toBe(0);
		expect(subject(CART)).toMatchObject({ state: "orphaned", orphanedAt: at });
	});

	it("keeps an orphan and its date through a compat rebuild", async () => {
		put("cart.fake", CART_TEXT);
		await scan();
		await record(CART);
		remove("cart.fake");
		await scan();
		const before = subject(CART);
		store.close();

		const reopened = IndexStore.open(path.join(storeDir, "index.sqlite"), "major-b", undefined, clock);
		store = reopened.store;

		expect(reopened.rebuilt).toBe(true);
		expect(store.subjects.byId(before?.subjectId as string)).toMatchObject({
			state: "orphaned",
			orphanedAt: before?.orphanedAt,
		});
	});
});

describe("the cursor", () => {
	function plantOrphans(dates: number[]): string[] {
		return dates.map((at, index) => {
			const minted = store.subjects.mint(`lexicon fake gone.fake Gone${index}#`, at);
			store.subjects.orphan(minted.subjectId, at, "none");
			return minted.subjectId;
		});
	}

	it("stops at the cap, says so, and the next sweep resumes past the key", () => {
		const t0 = clock.now();
		const ids = plantOrphans([t0, t0, t0 + 1]);
		const later = t0 + ORPHAN_TTL_MS + DAY;

		const first = store.sweepSubjects(2, idle, later);
		expect(first).toMatchObject({ examined: 2, deleted: 2, stoppedEarly: true });
		expect(store.subjects.byId(ids[2] as string)).not.toBeNull();

		const second = store.sweepSubjects(2, idle, later);
		expect(second).toMatchObject({ examined: 1, deleted: 1, stoppedEarly: false });
		expect(store.subjects.orphanedCount()).toBe(0);
	});

	it("examines a subject written behind the key within the following epoch", () => {
		const t0 = clock.now();
		plantOrphans([t0 + 1, t0 + 2, t0 + 3]);
		const examined = (report: { examined: number }) => report.examined;

		expect(examined(store.sweepSubjects(2, idle, t0 + DAY))).toBe(2);
		plantOrphans([t0]);
		expect(examined(store.sweepSubjects(2, idle, t0 + DAY))).toBe(1);
		// The epoch turned, so pass A starts from its beginning and reaches the one written behind the key.
		expect(examined(store.sweepSubjects(2, idle, t0 + DAY))).toBe(2);
	});

	it("exempts a subject whose module is present and failing, orphans a malformed and a local address, and rebinds neither", () => {
		const t0 = clock.now();
		const dead = store.subjects.mint(CART, t0);
		const malformed = store.subjects.mint("lexicon", t0);
		const local = store.subjects.mint("lexicon fake gone.fake local0", t0);
		const failing: SweepPass = {
			presence: (module) => (module === "cart.fake" ? "presentFailing" : "absent"),
			newModules: new Set(["cart.fake"]),
		};

		const report = store.sweepSubjects(10, failing, t0 + 1);

		// Pass A examines the two just orphaned in the same sweep and deletes neither.
		expect(report).toMatchObject({ examined: 5, rebound: 0, orphaned: 2, ambiguous: 0, deleted: 0 });
		expect(store.subjects.byId(dead.subjectId)).toMatchObject({ state: "bound", orphanedAt: null });
		expect(store.subjects.byId(malformed.subjectId)).toMatchObject({ state: "orphaned", evidence: "none" });
		expect(store.subjects.byId(local.subjectId)).toMatchObject({ state: "orphaned", evidence: "none" });
	});
});

describe("the wire", () => {
	it("lets an older client strip the stranded fields and read the row as it always did", () => {
		const older = GapRowSchema.omit({ stranded: true, strandedAt: true, evidence: true });
		const row = {
			symbolId: CART,
			question: "describe",
			why: "stale",
			askCount: 0,
			fanIn: 0,
			stranded: true,
			strandedAt: 1,
			evidence: "none",
		};

		expect(older.parse(row)).toEqual({ symbolId: CART, question: "describe", why: "stale", askCount: 0, fanIn: 0 });
	});
});
