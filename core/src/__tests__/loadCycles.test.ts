import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unjudgedLoadCycle } from "@nyaa-lexicon/protocol";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc/node";
import type { Clock } from "../clock.js";
import { createDispatch } from "../dispatch.js";
import type { MethodRequest, MethodResponse, ProviderPort } from "../providerPort.js";
import { LexiconService } from "../service.js";
import { sourceReader } from "../sourceRead.js";
import { IndexStore, type ReplaceFileInput } from "../store.js";
import { fakeClock } from "./fakeClock.js";
import { fakeSupervisor } from "./fakeProvider.js";

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } };
const NEXT_LINE = { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } };
let root: string;
let store: IndexStore;

function file(
	module: string,
	imports: Array<{ target: string; elided?: boolean; loads?: "static" | "deferred"; typeOnly?: boolean }>,
	hash = module,
	references: NonNullable<ReplaceFileInput["references"]> = [],
	runtime: "esm" | "cjs" | null = "cjs",
): ReplaceFileInput {
	return {
		module,
		contentHash: hash,
		provider: "fake",
		...(runtime === null ? {} : { runtime }),
		depth: "full",
		declarations: [],
		references,
		imports: imports.map(({ target, elided, loads, typeOnly }, order) => ({
			specifier: target,
			edges: [
				{
					kind: "sideEffect",
					span: { start: { line: order, character: 0 }, end: { line: order, character: 8 } },
					bindsLocally: false,
					certainty: { status: "known" },
					order,
					loads: loads ?? "static",
					...(elided === undefined ? {} : { elided }),
					...(typeOnly === undefined ? {} : { typeOnly }),
				},
			],
		})),
		resolutions: new Map(
			imports.map(({ target }) => [target, { status: "resolved", landing: { kind: "module", module: target } }]),
		),
	};
}

/** A complete fine answer naming every member as evidence, with `changes` over it. */
function judged(
	request: MethodRequest<"judgeLoadCycle">,
	changes: Partial<Extract<MethodResponse<"judgeLoadCycle">, { verdict: unknown }>> = {},
): MethodResponse<"judgeLoadCycle"> {
	return {
		verdict: "fine",
		bad: [],
		unknowns: [],
		evidence: request.members.map((member) => ({ ...member, landings: [] })),
		settings: [{ project: "fake", fingerprint: "fp" }],
		...changes,
	};
}

function readerOf(entry: string, module: string, order: string[]) {
	return {
		entry,
		order,
		reader: { module, range: RANGE, name: "read" },
		target: { module: order[0]!, name: "A", kind: "const" },
		calls: [],
	};
}

function crossing(name: string) {
	return {
		name,
		range: RANGE,
		role: "read" as const,
		binding: {
			status: "bound" as const,
			symbolId: "lexicon fake downstream.fake Value#",
			provenance: "bound" as const,
		},
		origin: { kind: "import" as const, span: RANGE },
	};
}

function service(provider: ProviderPort = fakeSupervisor(), clock?: Clock): LexiconService {
	return new LexiconService(store, provider, sourceReader(root), root, clock);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-load-cycles-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	store.recordProjectFingerprint("fake", "fp");
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("module load cycles", () => {
	it("finds components and their external entry, tainted only by an undecided edge inside or a missing runtime", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("c.fake", [{ target: "c.fake", elided: false }]));
		store.replaceFile(file("d.fake", [{ target: "e.fake" }]));
		store.replaceFile(file("e.fake", [{ target: "d.fake", elided: false }]));
		store.replaceFile(file("entry.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("f.fake", [{ target: "g.fake", elided: false }, { target: "leaf.fake" }]));
		store.replaceFile(file("g.fake", [{ target: "f.fake", elided: false }]));
		store.replaceFile(file("h.fake", [{ target: "h.fake", elided: false }], "h.fake", [], null));

		const cycles = await service().moduleCycles({ includeUnread: true });
		expect(cycles.map((cycle) => [cycle.modules, cycle.entries, cycle.unknowns])).toEqual([
			[["a.fake", "b.fake"], ["a.fake"], [{ reason: "provider" }]],
			[["c.fake"], ["c.fake"], [{ reason: "provider" }]],
			[["d.fake", "e.fake"], ["d.fake", "e.fake"], [{ reason: "undecided" }]],
			[["f.fake", "g.fake"], ["f.fake", "g.fake"], [{ reason: "provider" }]],
			[["h.fake"], ["h.fake"], [{ reason: "runtime" }]],
		]);
	});

	it("loads through a type-only edge emit keeps, never one it has not decided, and counts no crossing on it", async () => {
		store.replaceFile(
			file("a.fake", [{ target: "b.fake", typeOnly: true, elided: false }], "a.fake", [crossing("T")]),
		);
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("c.fake", [{ target: "d.fake", typeOnly: true }]));
		store.replaceFile(file("d.fake", [{ target: "c.fake", elided: false }]));

		const cycles = await service().moduleCycles({ includeUnread: true });
		expect(cycles.map((cycle) => [cycle.modules, cycle.crossings])).toEqual([[["a.fake", "b.fake"], []]]);
	});

	it("uses the kit default unknown and publishes complete bad and fine judgments", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("c.fake", [{ target: "c.fake", elided: false }]));
		const defaultAnswer = await service().moduleCycles({ module: "a.fake", includeUnread: true });
		expect(defaultAnswer[0]?.verdict).toBe("unknown");

		const requests: MethodRequest<"judgeLoadCycle">[] = [];
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					requests.push(request);
					if (!request.members.some((member) => member.module === "a.fake")) return judged(request);
					const order = request.members.map((member) => member.module);
					return judged(request, { verdict: "bad", bad: [readerOf(request.entries[0]!, "b.fake", order)] });
				},
			},
		});
		const judgedCycles = await service(provider).moduleCycles({ includeUnread: true });
		expect(judgedCycles.map((cycle) => cycle.verdict)).toEqual(["bad", "fine"]);
		expect(
			requests.find((request) => request.members.some((member) => member.module === "a.fake"))?.entries,
		).toEqual(["a.fake", "b.fake"]);
		expect(await service(provider).moduleProblems({ module: "b.fake" })).toHaveLength(1);
	});

	it("continues partial work with a fresh provider request, across unrelated writes between slices", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		const slices: Array<string | undefined> = [];
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					slices.push(request.partial);
					store.replaceFile(file(`unrelated${slices.length}.fake`, []));
					return request.partial === undefined ? { partial: "slice-1" } : judged(request);
				},
			},
		});
		expect((await service(provider).moduleCycles({ includeUnread: true }))[0]?.verdict).toBe("fine");
		expect(slices).toEqual([undefined, "slice-1"]);
	});

	it("discards an answer whose evidence names a hash the index does not hold, with no write between", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		const verdictWith = async (contentHash: (module: string) => string) => {
			const provider = fakeSupervisor({
				answers: {
					judgeLoadCycle: (request) =>
						judged(request, {
							evidence: request.members.map(({ module }) => ({
								module,
								contentHash: contentHash(module),
								landings: [],
							})),
						}),
				},
			});
			return (await service(provider).moduleCycles({ includeUnread: true }))[0]?.verdict;
		};

		expect({
			held: await verdictWith((module) => module),
			stale: await verdictWith((module) => (module === "b.fake" ? "stale" : module)),
		}).toEqual({ held: "fine", stale: "unknown" });
	});

	it("discards evidence after a member hash changes and invalidates a judgment for a new importer", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		let count = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					count++;
					if (count === 1) store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }], "moved"));
					return judged(request);
				},
			},
		});
		const svc = service(provider);
		expect((await svc.moduleCycles({ module: "a.fake", includeUnread: true }))[0]?.verdict).toBe("unknown");
		await svc.moduleCycles({ module: "a.fake", includeUnread: true });
		store.replaceFile(file("entry.fake", [{ target: "a.fake", elided: false }]));
		const updated = await svc.moduleCycles({ module: "a.fake", includeUnread: true });
		expect(updated[0]?.entries).toEqual(["a.fake"]);
		expect(count).toBeGreaterThan(1);
	});

	it("discards a judgment when an evidenced occurrence lands on another module", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					store.replaceFile(file("b.fake", [{ target: "c.fake", elided: false }]));
					store.replaceFile(file("c.fake", [{ target: "a.fake", elided: false }]));
					return judged(request, {
						evidence: request.members.map((member) => ({
							...member,
							landings:
								member.module === "b.fake"
									? [{ range: RANGE, landing: { kind: "module" as const, module: "a.fake" } }]
									: [],
						})),
					});
				},
			},
		});
		expect((await service(provider).moduleCycles({ module: "a.fake", includeUnread: true }))[0]?.verdict).toBe(
			"unknown",
		);
	});

	it("lands and validates each occurrence of one specifier by its resolution mode", async () => {
		writeFileSync(path.join(root, "a.fake"), "import\nrequire\n");
		writeFileSync(path.join(root, "i.fake"), "import a\n");
		store.replaceFile(file("i.fake", [{ target: "a.fake", elided: false }]));
		const edge = { kind: "sideEffect" as const, bindsLocally: false, certainty: { status: "known" as const } };
		const loading = { loads: "static" as const, elided: false };
		const runs = async (requireLanding: string) => {
			const asked: Array<string | undefined> = [];
			const provider = fakeSupervisor({
				answers: {
					parseFile: (request) => ({
						module: request.module,
						contentHash: request.contentHash,
						runtime: "esm",
						declarations: [],
						references: [],
						literals: [],
						diagnostics: [],
						imports:
							request.module === "i.fake"
								? [{ specifier: "a.fake", edges: [{ ...edge, ...loading, span: RANGE, order: 0 }] }]
								: [
										{
											specifier: "pkg",
											edges: [
												{
													...edge,
													...loading,
													span: RANGE,
													order: 0,
													resolutionMode: "import",
												},
												{
													...edge,
													...loading,
													span: NEXT_LINE,
													order: 1,
													resolutionMode: "require",
												},
											],
										},
									],
					}),
					resolveImport: (request) => {
						if (request.specifier !== "pkg")
							return { status: "resolved", landing: { kind: "module", module: request.specifier } };
						asked.push(request.resolutionMode);
						const module = request.resolutionMode === "require" ? "r.fake" : "i.fake";
						return { status: "resolved", landing: { kind: "module", module } };
					},
					judgeLoadCycle: (request) =>
						judged(request, {
							evidence: request.members.map((member) => ({
								...member,
								landings:
									member.module === "a.fake"
										? [
												{
													range: RANGE,
													landing: { kind: "module" as const, module: "i.fake" },
												},
												{
													range: NEXT_LINE,
													landing: { kind: "module" as const, module: requireLanding },
												},
											]
										: [],
							})),
						}),
				},
			});
			const svc = service(provider);
			await createDispatch(svc)("indexFile", { module: "a.fake" });
			// The importer i.fake is parsed again in the background; the judgment reads it settled.
			await svc.upgradeRemaining();
			const landed = store.importsIn("a.fake").map((stored) => [stored.span.start.line, stored.landing]);
			const [cycle] = await svc.moduleCycles({ includeUnread: true });
			return { asked: asked.sort(), landed: landed.sort(), cycle: [cycle?.modules, cycle?.verdict] };
		};

		expect(await runs("r.fake")).toEqual({
			asked: ["import", "require"],
			landed: [
				[0, { kind: "module", module: "i.fake" }],
				[1, { kind: "module", module: "r.fake" }],
			],
			cycle: [["a.fake", "i.fake"], "fine"],
		});
		expect((await runs("i.fake")).cycle).toEqual([["a.fake", "i.fake"], "unknown"]);
	});

	it("names why asking failed: a deadline, a dead provider, a refusal, or no such method", async () => {
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }]));
		const throwing = (error: Error) => fakeSupervisor({ answers: { judgeLoadCycle: () => Promise.reject(error) } });
		const reasonOf = async (provider: ProviderPort) =>
			(await service(provider).moduleCycles({ includeUnread: true }))[0]?.unknowns;

		expect({
			deadline: await reasonOf(
				fakeSupervisor({ fail: { timeoutMs: 1 }, answers: { judgeLoadCycle: () => new Promise(() => {}) } }),
			),
			dead: await reasonOf(fakeSupervisor({ fail: { providerDown: true } })),
			refused: await reasonOf(throwing(new ResponseError(ErrorCodes.InternalError, "cannot judge"))),
			missing: await reasonOf(throwing(new ResponseError(ErrorCodes.MethodNotFound, "Unhandled method"))),
		}).toEqual({
			deadline: [{ reason: "timeout" }],
			dead: [{ reason: "outage" }],
			refused: [{ reason: "refused" }],
			missing: unjudgedLoadCycle({ members: [{ module: "a.fake", contentHash: "a.fake" }], entries: ["a.fake"] })
				.unknowns,
		});
	});

	it("counts deferred external imports as entries and caps entries instead of members", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("outside-static.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("outside.fake", [{ target: "b.fake", loads: "deferred", elided: false }]));
		let memberCount = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					memberCount = request.members.length;
					return judged(request);
				},
			},
		});
		const first = await service(provider).moduleCycles({ module: "a.fake", includeUnread: true });
		expect(first[0]?.entries).toEqual(["a.fake", "b.fake"]);
		const modules = Array.from({ length: 33 }, (_, index) => `m${index}.fake`);
		for (let index = 0; index < modules.length; index++) {
			store.replaceFile(
				file(modules[index]!, [{ target: modules[(index + 1) % modules.length]!, elided: false }]),
			);
		}
		store.replaceFile(file("outside2.fake", [{ target: modules[0]!, elided: false }]));
		await service(provider).moduleCycles({ module: modules[0], includeUnread: true });
		expect(memberCount).toBe(33);
	});

	it("does not return an earlier bad answer after another component finishes", async () => {
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "b.fake", elided: false }]));
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (entered = resolve));
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: async (request) => {
					if (request.members[0]?.module === "b.fake") {
						entered();
						await waiting;
						return judged(request);
					}
					return judged(request, { verdict: "bad", bad: [readerOf("a.fake", "a.fake", ["a.fake"])] });
				},
			},
		});
		const pending = service(provider).moduleCycles({ includeUnread: true });
		await started;
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }], "changed"));
		release();
		const answer = await pending;
		expect(answer.find((item) => item.modules.includes("a.fake"))?.verdict).toBe("unknown");
	});

	it("lets an index write pass between provider slices through dispatch", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		writeFileSync(path.join(root, "a.fake"), "class A {}");
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (entered = resolve));
		let calls = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: async (request) => {
					calls++;
					if (calls === 1) return { partial: "next" };
					entered();
					await blocked;
					return judged(request, { verdict: "unknown", unknowns: [{ reason: "notReady" }], settings: [] });
				},
			},
		});
		const dispatch = createDispatch(service(provider));
		const judgment = dispatch("moduleCycles", { module: "a.fake", includeUnread: true });
		await started;
		await dispatch("indexFile", { module: "a.fake" });
		release();
		await judgment;
		expect(calls).toBe(2);
	});

	it("counts value reads through a runtime edge into the component, bound or not, and lists the first twenty", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(
			file("b.fake", [{ target: "a.fake", elided: false }], "b.fake", [
				crossing("ThroughBarrel"),
				{
					name: "Required",
					range: NEXT_LINE,
					role: "read",
					binding: { status: "unbound", reason: "NotIndexed" },
					origin: { kind: "import", span: RANGE },
				},
				{ ...crossing("Shape"), role: "implements" },
				{
					name: "Local",
					range: RANGE,
					role: "read",
					binding: { status: "bound", symbolId: "lexicon fake a.fake Value#", provenance: "bound" },
					origin: { kind: "declaration" },
				},
			]),
		);
		const reads = Array.from({ length: 25 }, (_, line) => ({
			...crossing(`R${line}`),
			range: { start: { line, character: 0 }, end: { line, character: 2 } },
		}));
		store.replaceFile(file("c.fake", [{ target: "c.fake", elided: false }], "c.fake", reads));

		const [ab, c] = await service().moduleCycles({ includeUnread: true });
		expect({
			ab: [ab?.crossingCount, ab?.crossings],
			c: [c?.crossingCount, c?.crossings.length],
		}).toEqual({
			ab: [
				2,
				[
					{ module: "b.fake", range: RANGE, name: "ThroughBarrel", target: "a.fake" },
					{ module: "b.fake", range: NEXT_LINE, name: "Required", target: "a.fake" },
				],
			],
			c: [25, 20],
		});
	});

	it("rejudges conclusive and failed cache entries when a project fingerprint moves", async () => {
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("r.fake", [{ target: "r.fake", elided: false }]));
		const calls = { a: 0, r: 0 };
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					if (request.members[0]?.module === "r.fake") {
						calls.r++;
						throw new ResponseError(ErrorCodes.InternalError, "cannot judge");
					}
					calls.a++;
					return judged(request, {
						settings: [{ project: "fake", fingerprint: calls.a === 1 ? "fp" : "fp2" }],
					});
				},
			},
		});
		const svc = service(provider);
		const verdicts = async () => (await svc.moduleCycles({ includeUnread: true })).map((cycle) => cycle.verdict);
		const before = await verdicts();
		store.recordProjectFingerprint("fake", "fp2");
		expect({ before, after: await verdicts(), calls }).toEqual({
			before: ["fine", "unknown"],
			after: ["fine", "unknown"],
			calls: { a: 2, r: 2 },
		});
	});

	it("starts one judgment for two simultaneous queries while a changed cache entry is checked", async () => {
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }]));
		let calls = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					calls++;
					return judged(request, {
						settings: [{ project: "fake", fingerprint: calls === 1 ? "fp" : "fp2" }],
					});
				},
			},
		});
		const svc = service(provider);
		await svc.moduleCycles({ includeUnread: true });
		store.recordProjectFingerprint("fake", "fp2");
		await Promise.all([svc.moduleCycles({ includeUnread: true }), svc.moduleCycles({ includeUnread: true })]);
		expect(calls).toBe(2);
	});

	it("never judges an unread component by default, and fills the limit past a filtered verdict", async () => {
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "c.fake", elided: false }]));
		store.replaceFile(file("c.fake", [{ target: "b.fake", elided: false }], "c.fake", [crossing("Imported")]));
		store.replaceFile(file("d.fake", [{ target: "d.fake", elided: false }], "d.fake", [crossing("Self")]));
		const requested: string[][] = [];
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					requested.push(request.members.map((member) => member.module));
					if (request.members[0]?.module !== "d.fake") return judged(request);
					return judged(request, { verdict: "bad", bad: [readerOf("d.fake", "d.fake", ["d.fake"])] });
				},
			},
		});
		const answer = await service(provider).moduleCycles({ limit: 1, verdict: "bad" });
		expect(answer.map((item) => item.modules)).toEqual([["d.fake"]]);
		expect(requested).toEqual([["b.fake", "c.fake"], ["d.fake"]]);
	});

	it("retries a budget judgment after ten minutes or when its evidence moves, not on an unrelated write", async () => {
		// `a` is answered as past its budget; `p` never finishes, so core stops it at the slice cap.
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("p.fake", [{ target: "p.fake", elided: false }]));
		const clock = fakeClock();
		const starts = { a: 0, p: 0 };
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					const budgeted = request.members[0]?.module === "a.fake";
					if (request.partial === undefined) starts[budgeted ? "a" : "p"]++;
					if (!budgeted) return { partial: "again" };
					return judged(request, { verdict: "unknown", unknowns: [{ reason: "budget" }], settings: [] });
				},
			},
		});
		const svc = service(provider, clock);
		const asks: Array<typeof starts> = [];
		for (const [index, wait] of [0, 61_000, 540_000].entries()) {
			clock.advance(wait);
			store.replaceFile(file(`unrelated${index}.fake`, []));
			await svc.moduleCycles({ includeUnread: true });
			asks.push({ ...starts });
		}
		for (const module of ["a.fake", "p.fake"])
			store.replaceFile(file(module, [{ target: module, elided: false }], "moved"));
		await svc.moduleCycles({ includeUnread: true });
		asks.push({ ...starts });
		expect(asks).toEqual([
			{ a: 1, p: 1 },
			{ a: 1, p: 1 },
			{ a: 2, p: 2 },
			{ a: 3, p: 3 },
		]);
	});

	it("asks again after a provider restart rather than holding the discarded answer", async () => {
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }]));
		const incarnation = { current: 1 };
		let calls = 0;
		const provider = fakeSupervisor({
			incarnation,
			answers: {
				judgeLoadCycle: (request) => {
					calls++;
					if (calls === 1) incarnation.current++;
					return judged(request);
				},
			},
		});
		const svc = service(provider);
		const verdicts: Array<string | undefined> = [];
		for (let ask = 0; ask < 2; ask++) verdicts.push((await svc.moduleCycles({ includeUnread: true }))[0]?.verdict);
		expect({ verdicts, calls }).toEqual({ verdicts: ["unknown", "fine"], calls: 2 });
	});

	it("holds provider state for at most four judgments per provider and queues the rest", async () => {
		const modules = Array.from({ length: 8 }, (_, index) => `m${index}.fake`);
		for (const module of modules)
			store.replaceFile(file(module, [{ target: module, elided: false }], module, [crossing("X")]));
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => (release = resolve));
		const open = new Set<string>();
		let most = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: async (request) => {
					const module = request.members[0]!.module;
					if (request.partial === undefined) {
						open.add(module);
						most = Math.max(most, open.size);
						return { partial: module };
					}
					await blocked;
					open.delete(module);
					return judged(request);
				},
			},
		});
		const svc = service(provider);
		const all = Promise.all(modules.map((module) => svc.moduleProblems({ module })));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const held = most;
		release();
		await all;
		expect({ held, judged: open.size }).toEqual({ held: 4, judged: 0 });
	});

	it("joins asks for one component across unrelated writes, and drops a superseded judgment's provider state", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }], "a.fake", [crossing("X")]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		const releasedJudgments: Array<{ providerId: string; partial: string }> = [];
		let release!: () => void;
		let entered!: () => void;
		let replaced!: () => void;
		const blocked = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (entered = resolve));
		const replacement = new Promise<void>((resolve) => (replaced = resolve));
		const slices: string[] = [];
		const provider = fakeSupervisor({
			releasedJudgments,
			answers: {
				judgeLoadCycle: async (request) => {
					slices.push(`${request.entries.join("+")}:${request.partial ?? "start"}`);
					if (request.entries.length === 1) {
						replaced();
						return judged(request);
					}
					if (request.partial === undefined) return { partial: "first" };
					entered();
					await blocked;
					return { partial: "second" };
				},
			},
		});
		const svc = service(provider);
		const ask = () => svc.moduleProblems({ module: "a.fake" });
		const joined = [ask()];
		await started;
		for (let index = 0; index < 3; index++) {
			store.replaceFile(file(`unrelated${index}.fake`, []));
			joined.push(ask());
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		store.replaceFile(file("entry.fake", [{ target: "a.fake", elided: false }]));
		const replacing = ask();
		await replacement;
		release();
		await Promise.all([...joined, replacing]);
		expect({ slices, releasedJudgments }).toEqual({
			slices: ["a.fake+b.fake:start", "a.fake+b.fake:first", "a.fake:start"],
			releasedJudgments: [{ providerId: "fake", partial: "second" }],
		});
	});

	it("joins a run from a newer view when an ask still holds an older one", async () => {
		store.replaceFile(file("a.fake", [{ target: "a.fake", elided: false }], "a.fake", [crossing("X")]));
		store.replaceFile(file("b.fake", [{ target: "c.fake", elided: false }], "b.fake", [crossing("X")]));
		store.replaceFile(file("c.fake", [{ target: "b.fake", elided: false }]));
		const { promise: aBlocked, resolve: releaseA } = Promise.withResolvers<void>();
		const { promise: bBlocked, resolve: releaseB } = Promise.withResolvers<void>();
		const { promise: aStarted, resolve: aEntered } = Promise.withResolvers<void>();
		const { promise: bWaiting, resolve: bEntered } = Promise.withResolvers<void>();
		let runs = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: async (request) => {
					if (request.members[0]?.module === "a.fake") {
						aEntered();
						await aBlocked;
						return judged(request);
					}
					if (request.partial === undefined) {
						runs++;
						return { partial: "first" };
					}
					bEntered();
					await bBlocked;
					return judged(request);
				},
			},
		});
		const svc = service(provider);
		// Reads b and c with both as entries, then waits on a, which sorts first.
		const older = svc.moduleCycles({});
		await aStarted;
		store.replaceFile(file("outside.fake", [{ target: "b.fake", elided: false }]));
		const newer = svc.moduleCycles({ module: "b.fake" });
		await bWaiting;
		releaseA();
		await new Promise((resolve) => setTimeout(resolve, 20));
		releaseB();
		const bc = (answer: Awaited<typeof newer>) => answer.find((cycle) => cycle.modules.includes("b.fake"));
		const [fromOlder, fromNewer] = (await Promise.all([older, newer])).map(bc);
		expect({ runs, fromOlder: [fromOlder?.verdict, fromOlder?.entries], fromNewer: fromNewer?.verdict }).toEqual({
			runs: 1,
			fromOlder: ["fine", ["b.fake"]],
			fromNewer: "fine",
		});
	});

	it("publishes the entries a component holds when its judgment ends, not when it began", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }], "a.fake", [crossing("X")]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		store.replaceFile(file("outside1.fake", [{ target: "a.fake", elided: false }]));
		const asked: string[][] = [];
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					asked.push(request.entries);
					if (asked.length === 1)
						store.replaceFile(file("outside2.fake", [{ target: "b.fake", elided: false }]));
					return judged(request);
				},
			},
		});
		const svc = service(provider);
		const answers = [];
		for (let ask = 0; ask < 2; ask++) {
			const [cycle] = await svc.moduleCycles({});
			answers.push([cycle?.verdict, cycle?.entries]);
		}
		expect({ answers, asked }).toEqual({
			answers: [
				["unknown", ["a.fake", "b.fake"]],
				["fine", ["a.fake", "b.fake"]],
			],
			asked: [["a.fake"], ["a.fake", "b.fake"]],
		});
	});

	it("never fails a judgment, or its other askers, for one asker's gate budget", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }], "a.fake", [crossing("X")]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		const { promise: sliceBlocked, resolve: releaseSlice } = Promise.withResolvers<void>();
		const { promise: started, resolve: entered } = Promise.withResolvers<void>();
		let slices = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: async (request) => {
					slices++;
					if (slices > 1) return judged(request);
					entered();
					await sliceBlocked;
					return { partial: "first" };
				},
			},
		});
		const svc = service(provider);
		const dispatch = createDispatch(svc);
		const budgeted = dispatch("moduleProblems", { module: "a.fake" }, { gateWaitMs: 5 });
		await started;
		const patient = dispatch("moduleProblems", { module: "b.fake" });
		const { promise: writeHeld, resolve: releaseWrite } = Promise.withResolvers<void>();
		const writing = svc.gate.exclusive(() => writeHeld);
		releaseSlice();
		await new Promise((resolve) => setTimeout(resolve, 30));
		releaseWrite();
		await writing;
		const [, patientOutcome] = await Promise.allSettled([budgeted, patient]);
		expect({ patient: patientOutcome.status, slices }).toEqual({ patient: "fulfilled", slices: 2 });
	});

	it("builds the view a query judges from one facts generation while writes land between its reads", async () => {
		store.replaceFile(file("a.fake", [{ target: "b.fake", elided: false }]));
		store.replaceFile(file("b.fake", [{ target: "a.fake", elided: false }]));
		// The first two counting reads each land a write first: the cycle breaks, then closes again.
		let writes = 0;
		const writing = new Proxy(store, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				if (property !== "importUseCounts") return value.bind(target);
				return (...args: Parameters<IndexStore["importUseCounts"]>) => {
					if (writes < 2) {
						writes++;
						const targets = writes === 1 ? [] : [{ target: "a.fake", elided: false }];
						target.replaceFile(file("b.fake", targets, `b${writes}`));
					}
					return target.importUseCounts(...args);
				};
			},
		});
		let judgments = 0;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => {
					judgments++;
					return judged(request);
				},
			},
		});
		const svc = new LexiconService(writing, provider, sourceReader(root), root);
		const cycles = await svc.moduleCycles({ includeUnread: true });
		expect({ cycles: cycles.map((cycle) => [cycle.modules, cycle.verdict]), judgments }).toEqual({
			cycles: [[["a.fake", "b.fake"], "fine"]],
			judgments: 1,
		});
	});

	it("asks the process that answers after a slot wait, and holds the answer for that process", async () => {
		const blockers = ["m0.fake", "m1.fake", "m2.fake", "m3.fake"];
		for (const module of [...blockers, "late.fake"])
			store.replaceFile(file(module, [{ target: module, elided: false }], module, [crossing("X")]));
		const incarnation = { current: 1 };
		const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
		let entered = 0;
		const provider = fakeSupervisor({
			incarnation,
			answers: {
				judgeLoadCycle: async (request) => {
					if (request.members[0]?.module !== "late.fake") {
						entered++;
						await blocked;
					}
					return judged(request);
				},
			},
		});
		const svc = service(provider);
		const held = blockers.map((module) => svc.moduleProblems({ module }));
		while (entered < blockers.length) await new Promise((resolve) => setTimeout(resolve, 1));
		const late = svc.moduleCycles({ module: "late.fake" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		incarnation.current++;
		release();
		await Promise.all(held);
		expect((await late)[0]?.verdict).toBe("fine");
	});
});
