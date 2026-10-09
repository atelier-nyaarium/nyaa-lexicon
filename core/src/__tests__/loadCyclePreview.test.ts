import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ArrangeFile,
	type FileFacts,
	hashContent,
	type PrepareLoadCyclePreviewRequest,
} from "@nyaa-lexicon/protocol";
import { DeadlineError } from "../deadline.js";
import { gateOf } from "../dispatch.js";
import { previewLoadCycles } from "../loadCyclePreview.js";
import { type Cycle, newCycleComponents, previewComponents } from "../loadCycles.js";
import type { ProviderProbe } from "../providerProbe.js";
import { IndexStore, type ReplaceFileInput } from "../store.js";
import { WorkspaceGate } from "../workspaceGate.js";
import { fakeClock } from "./fakeClock.js";
import { fakeSupervisor } from "./fakeProvider.js";

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
let root: string;
let store: IndexStore;

function file(module: string, target?: string, hash = module): ReplaceFileInput {
	return {
		module,
		contentHash: hash,
		provider: "fake",
		runtime: "esm",
		depth: "full",
		declarations: [],
		references: [],
		imports:
			target === undefined
				? []
				: [
						{
							specifier: target,
							edges: [
								{
									kind: "sideEffect",
									span: RANGE,
									bindsLocally: false,
									certainty: { status: "known" },
									order: 0,
									loads: "static",
								},
							],
						},
					],
		resolutions: new Map(
			target === undefined ? [] : [[target, { status: "resolved", landing: { kind: "module", module: target } }]],
		),
	};
}

function facts(module: string, target: string, contentHash: string): FileFacts {
	return {
		module,
		contentHash,
		declarations: [],
		references: [],
		literals: [],
		diagnostics: [],
		imports: [
			{
				specifier: target,
				edges: [
					{
						kind: "sideEffect",
						span: RANGE,
						bindsLocally: false,
						certainty: { status: "known" },
						order: 0,
						loads: "static",
					},
				],
			},
		],
		runtime: "esm",
	} as FileFacts;
}

function cycle(modules: string[]): Cycle {
	return {
		key: modules.join("\u0000"),
		generation: 1,
		modules,
		entries: [modules[0]!],
		crossingCount: 0,
		crossings: [],
		uncertainReason: null,
	};
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-cycle-preview-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("arrangement cycle preview", () => {
	it("calls a component new unless one baseline cycle already contains every member", () => {
		const baseline = [cycle(["a.ts", "b.ts"]), cycle(["d.ts", "e.ts", "f.ts"])];
		const formed = cycle(["x.ts", "y.ts"]);
		const merged = cycle(["a.ts", "b.ts", "d.ts", "e.ts", "f.ts"]);
		expect(
			newCycleComponents(
				[
					cycle(["a.ts", "b.ts"]),
					cycle(["a.ts", "b.ts", "c.ts"]),
					cycle(["d.ts", "e.ts"]),
					formed,
					merged,
					cycle(["d.ts", "e.ts"]),
					cycle(["e.ts", "f.ts"]),
				],
				[...baseline, cycle(["x.ts"]), cycle(["y.ts"]), cycle(["d.ts", "e.ts", "f.ts"])],
			).map(({ modules }) => modules),
		).toEqual([
			["a.ts", "b.ts", "c.ts"],
			["x.ts", "y.ts"],
			["a.ts", "b.ts", "d.ts", "e.ts", "f.ts"],
		]);
	});

	it("extracts candidate components synchronously and rolls all facts back", () => {
		store.replaceFile(file("a.ts", "b.ts"));
		store.replaceFile(file("b.ts"));
		const revision = store.factsRevision();
		const before = previewComponents(store, []);
		const proposed = file("b.ts", "a.ts", "proposed-hash");
		const candidate = previewComponents(store, [proposed]);
		expect(candidate.map(({ modules }) => modules)).toEqual([["a.ts", "b.ts"]]);
		expect(before).toEqual([]);
		expect(store.contentHashOf("b.ts")).toBe("b.ts");
		expect(store.factsRevision()).toBe(revision);
	});

	it("prepares all owner files, judges only a new component, revalidates, and releases the overlay", async () => {
		store.recordProjectFingerprint("fake", "fp");
		store.replaceFile(file("a.fake", "b.fake"));
		store.replaceFile(file("b.fake"));
		const resultHash = hashContent("import './a.fake';");
		const arranged: ArrangeFile = {
			module: "b.fake",
			base: "b.fake",
			created: false,
			text: "import './a.fake';",
			result: resultHash,
		};
		const importFact = (module: string, target: string, contentHash: string): FileFacts =>
			({
				module,
				contentHash,
				declarations: [],
				references: [],
				literals: [],
				diagnostics: [],
				imports: [
					{
						specifier: target,
						edges: [
							{
								kind: "sideEffect",
								span: RANGE,
								bindsLocally: false,
								certainty: { status: "known" },
								order: 0,
								loads: "static",
							},
						],
					},
				],
				runtime: "esm",
			}) as FileFacts;
		let preparedRequest: PrepareLoadCyclePreviewRequest | undefined;
		const probe = {
			prepareLoadCyclePreview: async (_provider: string, request: PrepareLoadCyclePreviewRequest) => {
				preparedRequest = request;
				return {
					status: "ready" as const,
					preview: "preview-token",
					facts: [importFact("a.fake", "b.fake", "a.fake"), importFact("b.fake", "a.fake", resultHash)],
					landings: ["a.fake", "b.fake"].map((module) => ({
						module,
						specifier: module === "a.fake" ? "b.fake" : "a.fake",
						resolution: {
							status: "resolved" as const,
							landing: { kind: "module" as const, module: module === "a.fake" ? "b.fake" : "a.fake" },
						},
					})),
					settings: [{ project: "fake", fingerprint: "fp" }],
				};
			},
		} as unknown as ProviderProbe;
		const releasedPreviews: Array<{ providerId: string; preview: string }> = [];
		let verdict: "bad" | "fine" = "fine";
		let evidenceMode: "valid" | "hash" | "landing" = "valid";
		let beforeAnswer = () => {};
		const incarnation = { current: 1 };
		const provider = fakeSupervisor({
			incarnation,
			releasedPreviews,
			answers: {
				judgeLoadCycle: (request) => {
					beforeAnswer();
					return {
						preview: request.preview,
						verdict,
						bad:
							verdict === "bad"
								? [
										{
											entry: request.entries[0]!,
											order: request.members.map((member) => member.module),
											reader: { module: "b.fake", range: RANGE, name: "useA" },
											target: { module: "a.fake", name: "A", kind: "function" },
											calls: [{ module: "b.fake", range: RANGE, name: "useA" }],
										},
									]
								: [],
						unknowns: [],
						evidence: request.members.map((member) => ({
							...member,
							contentHash: evidenceMode === "hash" ? "substituted" : member.contentHash,
							landings:
								evidenceMode === "landing" && member.module === "b.fake"
									? [{ range: RANGE, landing: { kind: "module" as const, module: "wrong.fake" } }]
									: [],
						})),
						settings: [{ project: "fake", fingerprint: "fp" }],
					} as const;
				},
			},
		});
		const clock = fakeClock();
		const result = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(preparedRequest?.answer).toEqual(["a.fake", "b.fake"]);
		expect(result.map(({ modules, verdict }) => [modules, verdict])).toEqual([[["a.fake", "b.fake"], "fine"]]);
		expect(releasedPreviews).toEqual([{ providerId: "fake", preview: "preview-token" }]);
		expect(store.contentHashOf("b.fake")).toBe("b.fake");
		verdict = "bad";
		const bad = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(bad[0]?.verdict).toBe("bad");
		verdict = "fine";
		evidenceMode = "hash";
		const substituted = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(substituted[0]?.unknowns[0]?.reason).toBe("evidence");
		evidenceMode = "landing";
		const wrongLanding = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(wrongLanding[0]?.unknowns[0]?.reason).toBe("evidence");
		evidenceMode = "valid";
		beforeAnswer = () => {
			store.recordProjectFingerprint("fake", "changed");
			beforeAnswer = () => {};
		};
		const staleSettings = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(staleSettings).toEqual([]);
		store.recordProjectFingerprint("fake", "fp");
		beforeAnswer = () => {
			incarnation.current++;
			beforeAnswer = () => {};
		};
		const staleRestart = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(staleRestart).toEqual([]);
		incarnation.current++;
		beforeAnswer = () => {
			store.replaceFile(file("a.fake", "b.fake", "edited"));
			beforeAnswer = () => {};
		};
		const staleEdit = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(staleEdit).toEqual([]);
		store.replaceFile(file("a.fake", "b.fake", "a.fake"));
		store.replaceFile(file("b.fake", "a.fake", "b.fake"));
		const none = await previewLoadCycles(store, provider, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(none).toEqual([]);
		store.recordProjectFingerprint("fake", "fp");
		store.replaceFile(file("b.fake"));
		const timedOut = fakeSupervisor({
			releasedPreviews,
			answers: { judgeLoadCycle: () => Promise.reject(new DeadlineError("provider deadline")) },
		});
		const beforeTimeoutRelease = releasedPreviews.length;
		const unknown = await previewLoadCycles(store, timedOut, probe, clock, gateOf(new WorkspaceGate(clock)), [
			arranged,
		]);
		expect(unknown[0]?.verdict).toBe("unknown");
		expect(releasedPreviews).toHaveLength(beforeTimeoutRelease + 1);
		const cancelled = fakeSupervisor({
			releasedPreviews,
			answers: { judgeLoadCycle: () => Promise.reject(new Error("request cancelled")) },
		});
		const beforeCancelRelease = releasedPreviews.length;
		const cancelledAnswer = await previewLoadCycles(
			store,
			cancelled,
			probe,
			clock,
			gateOf(new WorkspaceGate(clock)),
			[arranged],
		);
		expect(cancelledAnswer[0]?.verdict).toBe("unknown");
		expect(releasedPreviews).toHaveLength(beforeCancelRelease + 1);
		const releasedJudgments: Array<{ providerId: string; partial: string }> = [];
		let slice = 0;
		const betweenSlices = fakeSupervisor({
			releasedPreviews,
			releasedJudgments,
			answers: {
				judgeLoadCycle: (request) => {
					if (slice++ === 0) return { preview: request.preview, partial: "held-partial" };
					store.recordProjectFingerprint("fake", "changed-between-slices");
					return Promise.reject(new DeadlineError("continuation deadline"));
				},
			},
		});
		store.recordProjectFingerprint("fake", "fp");
		const beforeSliceRelease = releasedPreviews.length;
		const staleBetweenSlices = await previewLoadCycles(
			store,
			betweenSlices,
			probe,
			clock,
			gateOf(new WorkspaceGate(clock)),
			[arranged],
		);
		expect(staleBetweenSlices).toEqual([]);
		expect(releasedPreviews).toHaveLength(beforeSliceRelease + 1);
		expect(releasedJudgments).toEqual([{ providerId: "fake", partial: "held-partial" }]);
	});

	it("includes created destinations in the overlay and notices a new fine cycle", async () => {
		store.recordProjectFingerprint("fake", "fp");
		store.replaceFile(file("a.fake"));
		const aText = 'import "./b.fake";';
		const bText = 'import "./a.fake";';
		const arranged: ArrangeFile[] = [
			{ module: "a.fake", base: "a.fake", created: false, text: aText, result: hashContent(aText) },
			{ module: "b.fake", base: null, created: true, text: bText, result: hashContent(bText) },
		];
		const released: Array<{ providerId: string; preview: string }> = [];
		let token = 0;
		const probe = {
			prepareLoadCyclePreview: async (_owner: string, request: PrepareLoadCyclePreviewRequest) => ({
				status: "ready" as const,
				preview: `created-${++token}`,
				facts: request.answer.map((module) =>
					module === "a.fake"
						? facts(module, "./b.fake", hashContent(aText))
						: facts(module, "./a.fake", hashContent(bText)),
				),
				landings: request.answer.map((module) => ({
					module,
					specifier: module === "a.fake" ? "./b.fake" : "./a.fake",
					resolution: {
						status: "resolved" as const,
						landing: { kind: "module" as const, module: module === "a.fake" ? "b.fake" : "a.fake" },
					},
				})),
				settings: [{ project: "fake", fingerprint: "fp" }],
			}),
		} as unknown as ProviderProbe;
		const provider = fakeSupervisor({
			releasedPreviews: released,
			answers: {
				judgeLoadCycle: (request) => ({
					preview: request.preview,
					verdict: "fine",
					bad: [],
					unknowns: [],
					evidence: request.members.map((member) => ({ ...member, landings: [] })),
					settings: [{ project: "fake", fingerprint: "fp" }],
				}),
			},
		});
		const clock = fakeClock();
		const result = await previewLoadCycles(
			store,
			provider,
			probe,
			clock,
			gateOf(new WorkspaceGate(clock)),
			arranged,
		);
		expect(result.map(({ modules, verdict }) => [modules, verdict])).toEqual([[["a.fake", "b.fake"], "fine"]]);
		expect(released).toEqual([{ providerId: "fake", preview: "created-1" }]);

		const rejectedProbe = {
			prepareLoadCyclePreview: async (_owner: string, request: PrepareLoadCyclePreviewRequest) => ({
				status: "ready" as const,
				preview: `created-${++token}`,
				facts: request.answer.map((module) =>
					module === "a.fake"
						? facts(module, "./b.fake", hashContent(aText))
						: facts(module, "./a.fake", hashContent(bText)),
				),
				landings: [],
				settings: [{ project: "fake", fingerprint: "mismatched" }],
			}),
		} as unknown as ProviderProbe;
		const beforeRejected = released.length;
		const rejected = await previewLoadCycles(
			store,
			provider,
			rejectedProbe,
			clock,
			gateOf(new WorkspaceGate(clock)),
			arranged,
		);
		expect(rejected).toEqual([]);
		expect(released).toHaveLength(beforeRejected + 1);
		expect(released.at(-1)?.preview).toBe("created-2");
	});

	it("drops judged results when an edit lands before the final gate hold", async () => {
		store.recordProjectFingerprint("fake", "fp");
		store.replaceFile(file("a.fake", "b.fake"));
		store.replaceFile(file("b.fake"));
		const text = 'import "./a.fake";';
		const resultHash = hashContent(text);
		const arranged: ArrangeFile = { module: "b.fake", base: "b.fake", created: false, text, result: resultHash };
		const probe = {
			prepareLoadCyclePreview: async () => ({
				status: "ready" as const,
				preview: "gate-race",
				facts: [facts("a.fake", "./b.fake", "a.fake"), facts("b.fake", "./a.fake", resultHash)],
				landings: [],
				settings: [{ project: "fake", fingerprint: "fp" }],
			}),
		} as unknown as ProviderProbe;
		const provider = fakeSupervisor({
			answers: {
				judgeLoadCycle: (request) => ({
					preview: request.preview,
					verdict: "fine",
					bad: [],
					unknowns: [],
					evidence: request.members.map((member) => ({ ...member, landings: [] })),
					settings: [{ project: "fake", fingerprint: "fp" }],
				}),
			},
		});
		const clock = fakeClock();
		const base = gateOf(new WorkspaceGate(clock));
		let writes = 0;
		const gate = {
			...base,
			write: <T>(work: () => T | Promise<T>) => {
				if (++writes === 3) store.replaceFile(file("b.fake", undefined, "edited-before-final-hold"));
				return base.write(work);
			},
		};
		const result = await previewLoadCycles(store, provider, probe, clock, gate, [arranged]);
		expect(result).toEqual([]);
		expect(store.contentHashOf("b.fake")).toBe("edited-before-final-hold");
	});
});
