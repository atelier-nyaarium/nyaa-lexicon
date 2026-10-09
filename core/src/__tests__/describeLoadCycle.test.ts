import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DescribeResult, LoadCycleHazard } from "@nyaa-lexicon/protocol";
import { type Clock, systemClock } from "../clock.js";
import { involves } from "../describeLoadCycle.js";
import { createDispatch } from "../dispatch.js";
import type { MethodRequest, MethodResponse } from "../providerPort.js";
import { LexiconService } from "../service.js";
import { sourceReader } from "../sourceRead.js";
import { IndexStore, type ReplaceFileInput } from "../store.js";
import { fakeSupervisor } from "./fakeProvider.js";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;

/** Each module's edge to its partner sits on line 0. */
const EDGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } };

const line = (from: number, to = from) => ({ start: { line: from, character: 0 }, end: { line: to, character: 20 } });

const idOf = (module: string, name: string) => `lexicon fake ${module} ${name}#`;

function declared(module: string, name: string, range: ReturnType<typeof line>, container?: string) {
	return {
		symbolId: idOf(module, name),
		kind: "variable" as const,
		name,
		range,
		selectionRange: range,
		visibility: "public" as const,
		...(container === undefined ? {} : { containerId: idOf(module, container) }),
	};
}

/** A value read through the edge into the partner, which makes the component one a describe judges. */
function crossing(name: string, at: number) {
	return {
		name,
		range: line(at),
		role: "read" as const,
		binding: { status: "unbound" as const, reason: "NotIndexed" as const },
		origin: { kind: "import" as const, span: EDGE },
	};
}

function file(
	module: string,
	partner: string | null,
	declarations: ReturnType<typeof declared>[],
	reads: ReturnType<typeof crossing>[],
): ReplaceFileInput {
	const imports =
		partner === null
			? []
			: [
					{
						specifier: partner,
						edges: [
							{
								kind: "sideEffect" as const,
								span: EDGE,
								bindsLocally: false,
								certainty: { status: "known" as const },
								order: 0,
								loads: "static" as const,
								elided: false,
							},
						],
					},
				];
	return {
		module,
		contentHash: module,
		provider: "fake",
		runtime: "cjs",
		depth: "full",
		declarations,
		references: reads,
		imports,
		resolutions: new Map(
			partner === null ? [] : [[partner, { status: "resolved", landing: { kind: "module", module: partner } }]],
		),
	};
}

/** `a` reads `b`'s `B` inside `useB`, and `NS.member` at module level; `b` reads `a`'s `A`. */
const READS_B: LoadCycleHazard = {
	entry: "a.fake",
	order: ["b.fake", "a.fake"],
	reader: { module: "a.fake", range: line(3), name: "B" },
	target: { module: "b.fake", name: "B", kind: "const" },
	calls: [],
};

const READS_MEMBER: LoadCycleHazard = {
	entry: "a.fake",
	order: ["b.fake", "a.fake"],
	reader: { module: "a.fake", range: line(9), name: "member" },
	target: { module: "b.fake", name: "NS.member", kind: "const" },
	calls: [],
};

function judged(request: MethodRequest<"judgeLoadCycle">, verdict: "bad" | "fine"): MethodResponse<"judgeLoadCycle"> {
	return {
		verdict,
		bad: verdict === "bad" ? [READS_B, READS_MEMBER] : [],
		unknowns: [],
		evidence: request.members.map((member) => ({ ...member, landings: [] })),
		settings: [{ project: "fake", fingerprint: "fp" }],
	};
}

/** A clock whose timers, describe's wait among them, fire at once or never, as the test sets it. */
function waiting(): { clock: Clock; wait: { ends: boolean } } {
	const wait = { ends: false };
	const clock: Clock = {
		...systemClock,
		setTimer: (fn) => {
			if (wait.ends) fn();
			return systemClock.setTimer(() => {}, 0);
		},
		clearTimer: () => {},
	};
	return { clock, wait };
}

function service(verdict: "bad" | "fine", clock: Clock) {
	const provider = fakeSupervisor({ answers: { judgeLoadCycle: (request) => judged(request, verdict) } });
	const lexicon = new LexiconService(store, provider, sourceReader(root), root, clock);
	const dispatch = createDispatch(lexicon);
	const loadCycleOf = async (module: string, name: string) =>
		((await dispatch("describe", { symbolId: idOf(module, name) })) as DescribeResult | null)?.loadCycle;
	return { lexicon, loadCycleOf };
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-describe-cycle-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	store.recordProjectFingerprint("fake", "fp");
	store.replaceFile(
		file(
			"a.fake",
			"b.fake",
			[declared("a.fake", "A", line(1)), declared("a.fake", "useB", line(2, 4))],
			[crossing("B", 3)],
		),
	);
	store.replaceFile(
		file(
			"b.fake",
			"a.fake",
			[
				declared("b.fake", "B", line(1)),
				declared("b.fake", "NS", line(2, 4)),
				declared("b.fake", "member", line(3), "NS"),
			],
			[crossing("A", 5)],
		),
	);
	store.replaceFile(file("c.fake", null, [declared("c.fake", "C", line(1))], []));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("describe's load cycle", () => {
	it("matches a named target by symbol id despite a same-named top-level declaration", () => {
		const target = { symbolId: "member-id", module: "b.fake", range: line(3), chain: ["NS", "Y"] };
		const hazard: LoadCycleHazard = {
			...READS_MEMBER,
			target: { module: "b.fake", name: "Y", kind: "property", symbolId: "member-id" },
		};
		expect({
			member: involves(target, hazard),
			topLevel: involves({ ...target, symbolId: "top-id", chain: ["Y"] }, hazard),
		}).toEqual({
			member: true,
			topLevel: false,
		});
	});

	it("matches a renamed target by symbol id", () => {
		const symbol = { symbolId: "export-id", module: "b.fake", range: line(3), chain: ["currentName"] };
		const hazard: LoadCycleHazard = {
			...READS_MEMBER,
			target: { module: "b.fake", name: "oldExportName", kind: "const", symbolId: "export-id" },
		};
		expect(involves(symbol, hazard)).toBe(true);
	});

	it("falls back to the target name and container chain without a symbol id", () => {
		const symbol = { symbolId: "member-id", module: "b.fake", range: line(3), chain: ["NS", "member"] };
		expect(involves(symbol, READS_MEMBER)).toBe(true);
	});

	it("names the hazards a symbol reads in or is the target of, by plain name or container chain", async () => {
		const { loadCycleOf } = service("bad", waiting().clock);
		const modules = ["a.fake", "b.fake"];

		expect({
			reader: await loadCycleOf("a.fake", "useB"),
			target: await loadCycleOf("b.fake", "B"),
			member: await loadCycleOf("b.fake", "member"),
		}).toEqual({
			reader: { verdict: "bad", modules, hazards: [READS_B] },
			target: { verdict: "bad", modules, hazards: [READS_B] },
			member: { verdict: "bad", modules, hazards: [READS_MEMBER] },
		});
	});

	it("is absent for a symbol no hazard involves, a fine component, and a module in no cycle", async () => {
		const bad = service("bad", waiting().clock);
		const fine = service("fine", waiting().clock);

		expect({
			uninvolved: await bad.loadCycleOf("a.fake", "A"),
			container: await bad.loadCycleOf("b.fake", "NS"),
			fine: await fine.loadCycleOf("a.fake", "useB"),
			outside: await bad.loadCycleOf("c.fake", "C"),
		}).toEqual({ uninvolved: undefined, container: undefined, fine: undefined, outside: undefined });
	});

	it("answers pending past its wait, and the judgment that ran on answers the next describe", async () => {
		const { clock, wait } = waiting();
		const { lexicon, loadCycleOf } = service("bad", clock);

		wait.ends = true;
		const pending = await loadCycleOf("a.fake", "useB");
		await lexicon.moduleCycles({ module: "a.fake" });
		wait.ends = false;

		expect({ pending, landed: (await loadCycleOf("a.fake", "useB"))?.verdict }).toEqual({
			pending: { verdict: "pending", modules: ["a.fake", "b.fake"] },
			landed: "bad",
		});
	});
});
