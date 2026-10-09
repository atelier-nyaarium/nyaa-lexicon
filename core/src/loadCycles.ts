// Load-order cycles: candidate components from runtime import edges, judged by their provider.

import {
	type JudgeLoadCycleAnswer,
	type JudgeLoadCycleRequest,
	type LoadCycleHazard,
	type ModuleCycle,
	ModuleCycleSchema,
	ModuleCyclesRequestSchema,
	ModuleProblemsRequestSchema,
	type Range,
	type ReferenceRole,
	sameRange,
	unjudgedLoadCycle,
} from "@nyaa-lexicon/protocol";
import { ErrorCodes } from "vscode-jsonrpc/node";
import type { Clock } from "./clock.js";
import { DeadlineError } from "./deadline.js";
import { landingKey } from "./exportProjection.js";
import { spanKey } from "./factAdmission.js";
import { FifoSemaphore } from "./fifoSemaphore.js";
import { type Edge, findCycles } from "./graph.js";
import type { ProviderPort } from "./providerPort.js";
import type { Gate } from "./stepRunners.js";
import type { IndexStore } from "./store.js";
import { ProviderUnavailableError } from "./supervisor.js";
import type { WorkspaceGate } from "./workspaceGate.js";

////////////////////////////////
//  Interfaces & Types

type Unknown = ModuleCycle["unknowns"][number];

type Answered = Extract<JudgeLoadCycleAnswer, { verdict: unknown }>;

type Members = JudgeLoadCycleRequest["members"];

type LoadEdge = ReturnType<IndexStore["loadEdges"]>[number];

type Cycle = {
	key: string;
	modules: string[];
	entries: string[];
	crossingCount: number;
	crossings: ModuleCycle["crossings"];
	uncertainReason: "undecided" | "runtime" | null;
};

/** The components of one facts generation. */
type Held = { generation: number; cycles: Cycle[]; byKey: Map<string, Cycle> };

/** The candidate graph and what components read from it. */
type Graph = {
	edges: Edge[];
	/** By module and span. A kept type-only edge loads but carries no value. */
	valueEdges: Map<string, Map<string, string>>;
	importers: Map<string, Set<string>>;
	/** Targets each module reaches through a static edge emit has not decided. */
	undecided: Map<string, Set<string>>;
};

type Judgment = {
	cycle: Cycle;
	verdict: ModuleCycle["verdict"];
	bad: LoadCycleHazard[];
	unknowns: Unknown[];
	expires: number;
	/** What the provider was asked and answered; absent, the judgment is core's own and never cached. */
	basis?: { provider: { id: string; incarnation: number }; members: Members; reply?: Answered };
};

type Running = { cycle: Cycle; state: { superseded: boolean }; work: Promise<Judgment> };

////////////////////////////////
//  Constants

const MAX_ENTRIES = 32;
const MAX_DOWNSTREAM = 2_000;
const MAX_SLICES = 40;
/** Judgments holding provider state at once, per provider. */
const PROVIDER_SLOTS = 4;
const CROSSINGS_LISTED = 20;
const HOLD_MS = 60_000;
/** A judgment past a budget is retried no sooner, unless its evidence moves. */
const RETRY_MS = 600_000;
/** Uses that read no value. */
const NOT_READS: readonly ReferenceRole[] = ["typeUse", "import", "export"];

////////////////////////////////
//  Functions & Helpers

/** Emit's decision wins; a type-only edge it has not decided loads nothing. */
function loadsAtRuntime(edge: LoadEdge): boolean {
	return edge.elided === undefined ? !edge.typeOnly : !edge.elided;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
	const set = map.get(key);
	if (set === undefined) map.set(key, new Set([value]));
	else set.add(value);
}

function graphOf(rows: readonly LoadEdge[]): Graph {
	const graph: Graph = { edges: [], valueEdges: new Map(), importers: new Map(), undecided: new Map() };
	for (const edge of rows) {
		if (!loadsAtRuntime(edge)) continue;
		const { module, target } = edge;
		if (!edge.typeOnly) {
			const bySpan = graph.valueEdges.get(module) ?? new Map<string, string>();
			const span = spanKey(edge.span);
			if (!bySpan.has(span)) bySpan.set(span, target);
			graph.valueEdges.set(module, bySpan);
		}
		addTo(graph.importers, target, module);
		if (edge.loads !== "static") continue;
		if (edge.elided === undefined) addTo(graph.undecided, module, target);
		graph.edges.push({ from: module, to: target });
	}
	return graph;
}

/**
 * Each component's value reads through a runtime edge landing inside it, bound or not, and every
 * member's runtime. Inside the gate, so it counts in the store and lists only the first few.
 */
function readDetail(store: IndexStore, components: readonly string[][], graph: Graph) {
	const members = components.flat();
	const counted = new Map<string, Array<{ origin: Range; count: number }>>();
	for (const { module, origin, count } of store.importUseCounts(members, NOT_READS)) {
		const list = counted.get(module);
		if (list === undefined) counted.set(module, [{ origin, count }]);
		else list.push({ origin, count });
	}
	const crossings = components.map((modules) => {
		const group = new Set(modules);
		let crossingCount = 0;
		const listed: Cycle["crossings"] = [];
		for (const module of modules) {
			for (const { origin, count } of counted.get(module) ?? []) {
				const target = graph.valueEdges.get(module)?.get(spanKey(origin));
				if (target === undefined || !group.has(target)) continue;
				crossingCount += count;
				const room = CROSSINGS_LISTED - listed.length;
				if (room <= 0) continue;
				for (const use of store.importUsesThrough(module, origin, NOT_READS, room))
					listed.push({ module, name: use.name, range: use.range, target });
			}
		}
		return { crossingCount, crossings: listed };
	});
	return { generation: store.factsGeneration(), crossings, runtimes: store.runtimesOf(members) };
}

function assemble(
	generation: number,
	components: readonly string[][],
	graph: Graph,
	detail: ReturnType<typeof readDetail>,
): Held {
	const cycles = components.map((modules, index): Cycle => {
		const group = new Set(modules);
		const reached = modules.filter((member) => {
			const from = graph.importers.get(member);
			return from === undefined || [...from].some((importer) => !group.has(importer));
		});
		const undecided = modules.some((member) =>
			[...(graph.undecided.get(member) ?? [])].some((to) => group.has(to)),
		);
		const { crossingCount, crossings } = detail.crossings[index]!;
		return {
			key: modules.join("\u0000"),
			modules,
			entries: reached.length === 0 ? modules : reached,
			crossingCount,
			crossings,
			uncertainReason: undecided
				? "undecided"
				: modules.some((member) => (detail.runtimes.get(member) ?? null) === null)
					? "runtime"
					: null,
		};
	});
	return { generation, cycles, byKey: new Map(cycles.map((cycle) => [cycle.key, cycle])) };
}

/** Membership, entries and uncertainty: what a judgment was asked about. */
function sameComponent(a: Cycle, b: Cycle): boolean {
	return (
		a.key === b.key &&
		a.uncertainReason === b.uncertainReason &&
		a.entries.length === b.entries.length &&
		a.entries.every((entry, index) => b.entries[index] === entry)
	);
}

////////////////////////////////
//  Class

export class LoadCycleRead {
	private held: Held | null = null;
	private readonly cache = new Map<string, Judgment>();
	private readonly running = new Map<string, Running>();
	private readonly providerSlots = new Map<string, FifoSemaphore>();

	constructor(
		private readonly store: IndexStore,
		private readonly providers: ProviderPort,
		private readonly clock: Clock,
		private readonly gate: WorkspaceGate,
	) {}

	async moduleCycles(raw: unknown, dispatchGate?: Gate): Promise<ModuleCycle[]> {
		const query = ModuleCyclesRequestSchema.parse(raw);
		const shown = (judgment: Judgment) => query.verdict === undefined || judgment.verdict === query.verdict;
		const knownBad = (cycle: Cycle) => Number(this.cache.get(cycle.key)?.verdict === "bad");
		const candidates = (await this.componentsNow(dispatchGate)).cycles
			.filter((cycle) => query.module === undefined || cycle.modules.includes(query.module))
			// Nothing crosses an unread component, so it is never judged unless asked for.
			.filter((cycle) => query.includeUnread === true || cycle.crossingCount > 0)
			.sort((a, b) => knownBad(b) - knownBad(a) || a.modules[0]!.localeCompare(b.modules[0]!));
		const judged: Array<{ cycle: Cycle; judgment: Judgment }> = [];
		for (const cycle of candidates) {
			if (judged.length >= query.limit) break;
			const judgment = await this.judge(cycle, dispatchGate);
			if (shown(judgment)) judged.push({ cycle, judgment });
		}
		const current = await this.shortRead(dispatchGate, () =>
			judged.map(({ cycle, judgment }) => ({
				cycle,
				judgment: this.valid(judgment) ? judgment : this.unknown(cycle, "evidence"),
			})),
		);
		return current
			.filter(({ judgment }) => shown(judgment))
			.sort(
				(a, b) =>
					Number(b.judgment.verdict === "bad") - Number(a.judgment.verdict === "bad") ||
					a.cycle.modules[0]!.localeCompare(b.cycle.modules[0]!),
			)
			.map(({ cycle, judgment }) =>
				ModuleCycleSchema.parse({
					modules: cycle.modules,
					verdict: judgment.verdict,
					entries: cycle.entries,
					crossingCount: cycle.crossingCount,
					crossings: cycle.crossings,
					bad: judgment.bad,
					unknowns: judgment.unknowns,
				}),
			);
	}

	async moduleProblems(raw: unknown, dispatchGate?: Gate): Promise<LoadCycleHazard[]> {
		const query = ModuleProblemsRequestSchema.parse(raw);
		const cycle = (await this.componentsNow(dispatchGate)).cycles.find((candidate) =>
			candidate.modules.includes(query.module),
		);
		if (cycle === undefined) return [];
		const judgment = await this.judge(cycle, dispatchGate);
		return this.shortRead(dispatchGate, () =>
			(this.valid(judgment) ? judgment : this.unknown(cycle, "evidence")).bad.filter(
				(hazard) => hazard.reader.module === query.module,
			),
		);
	}

	/**
	 * The components as of now, built once per facts generation. Rows are read inside the gate and
	 * the graph is built outside it; a write between the two reads builds once more.
	 */
	private async componentsNow(dispatchGate?: Gate): Promise<Held> {
		for (let attempt = 0; ; attempt++) {
			const read = await this.shortRead(dispatchGate, () => {
				const generation = this.store.factsGeneration();
				const held = this.held;
				return held?.generation === generation ? { held } : { generation, rows: this.store.loadEdges() };
			});
			if ("held" in read) return read.held;
			const graph = graphOf(read.rows);
			const components = findCycles(graph.edges).map(({ members }) => [...members].sort());
			const detail = await this.shortRead(dispatchGate, () => readDetail(this.store, components, graph));
			if (detail.generation !== read.generation && attempt === 0) continue;
			const built = assemble(read.generation, components, graph, detail);
			if (this.held === null || this.held.generation <= built.generation) {
				this.held = built;
				for (const key of this.cache.keys()) if (!built.byKey.has(key)) this.cache.delete(key);
			}
			return built;
		}
	}

	/** One judgment per component at a time; an ask for the same component joins it, a changed one replaces it. */
	private judge(cycle: Cycle, dispatchGate?: Gate): Promise<Judgment> {
		const held = this.running.get(cycle.key);
		if (held !== undefined && !held.state.superseded && sameComponent(held.cycle, cycle)) return held.work;
		if (held !== undefined) held.state.superseded = true;
		const state = { superseded: false };
		// Reserved before the cache check's await, so a concurrent asker never starts a second judgment.
		const entry: Running = { cycle, state, work: this.judgeHeld(cycle, () => state.superseded, dispatchGate) };
		this.running.set(cycle.key, entry);
		const release = () => {
			if (this.running.get(cycle.key) === entry) this.running.delete(cycle.key);
		};
		void entry.work.then(release, release);
		return entry.work;
	}

	private async judgeHeld(cycle: Cycle, superseded: () => boolean, dispatchGate?: Gate): Promise<Judgment> {
		const cached = this.cache.get(cycle.key);
		if (
			cached !== undefined &&
			cached.expires > this.clock.now() &&
			(await this.shortRead(dispatchGate, () => this.valid(cached)))
		)
			return cached;
		const judgment = await this.run(cycle, superseded, dispatchGate);
		return this.shortRead(dispatchGate, () => {
			if (!this.valid(judgment)) return this.unknown(cycle, "evidence");
			if (judgment.basis !== undefined) this.cache.set(cycle.key, judgment);
			return judgment;
		});
	}

	/**
	 * Asks the provider owning every member, one slice per request, holding one of its slots from the
	 * first slice to the last. Stops when superseded or when a member moves, and tells the provider to
	 * drop whatever partial state it still holds.
	 */
	private async run(cycle: Cycle, superseded: () => boolean, dispatchGate?: Gate): Promise<Judgment> {
		const { owner, incarnation, members } = await this.shortRead(dispatchGate, () => {
			const providerIds = new Set(cycle.modules.map((module) => this.store.writerOf(module)));
			const [only] = providerIds;
			const owner =
				providerIds.size === 1 &&
				only !== null &&
				only !== undefined &&
				cycle.modules.every((module) => {
					const route = this.providers.route(module);
					return route.owned && route.providerId === only;
				})
					? only
					: null;
			return {
				owner,
				incarnation: owner === null ? null : this.providers.incarnationOf(owner),
				members: cycle.modules.map((module) => ({ module, contentHash: this.store.contentHashOf(module) })),
			};
		});
		if (owner === null) return this.unknown(cycle, "provider");
		if (incarnation === null) return this.unknown(cycle, "outage");
		if (cycle.uncertainReason !== null) return this.unknown(cycle, cycle.uncertainReason);
		if (cycle.entries.length > MAX_ENTRIES) return this.unknown(cycle, "budget");
		const asked: Members = [];
		for (const member of members) {
			if (member.contentHash === null) return this.unknown(cycle, "evidence");
			asked.push({ module: member.module, contentHash: member.contentHash });
		}
		const basis = { provider: { id: owner, incarnation }, members: asked };
		const failed = (reason: Unknown["reason"]): Judgment => ({ ...this.unknown(cycle, reason), basis });
		const release = await this.slots(owner).acquire();
		let partial: string | undefined;
		try {
			for (let slice = 0; slice < MAX_SLICES; slice++) {
				if (superseded() || !(await this.shortRead(dispatchGate, () => this.membersHold(asked))))
					return this.unknown(cycle, "evidence");
				const request: JudgeLoadCycleRequest = {
					members: asked,
					entries: cycle.entries,
					...(partial === undefined ? {} : { partial }),
				};
				let reply: JudgeLoadCycleAnswer;
				try {
					reply = await this.providers.askProvider(owner, "judgeLoadCycle", request);
				} catch (error) {
					// A provider without the method answers as the kit's default would.
					if ((error as { code?: unknown }).code !== ErrorCodes.MethodNotFound)
						return failed(this.failure(error, basis.provider));
					reply = unjudgedLoadCycle(request);
				}
				if ("partial" in reply) {
					partial = reply.partial;
					continue;
				}
				partial = undefined;
				const downstream = new Set(
					reply.evidence.map((row) => row.module).filter((module) => !cycle.modules.includes(module)),
				);
				if (downstream.size > MAX_DOWNSTREAM) return failed("budget");
				return {
					cycle,
					verdict: reply.verdict,
					bad: reply.bad,
					unknowns: reply.unknowns,
					expires: this.expiry(reply.unknowns),
					basis: { ...basis, reply },
				};
			}
			return failed("budget");
		} finally {
			if (partial !== undefined) this.providers.releaseJudgment(owner, incarnation, partial);
			release();
		}
	}

	/** Whether a judgment still describes the index: its component, its provider and its own evidence. */
	private valid(judgment: Judgment): boolean {
		const current = this.held?.byKey.get(judgment.cycle.key);
		if (current === undefined || !sameComponent(current, judgment.cycle)) return false;
		const { basis } = judgment;
		if (basis === undefined) return true;
		if (this.providers.incarnationOf(basis.provider.id) !== basis.provider.incarnation) return false;
		if (!this.membersHold(basis.members)) return false;
		return basis.reply === undefined || this.answerHolds(current, basis.provider.id, basis.reply);
	}

	private membersHold(members: Members): boolean {
		return members.every((member) => this.store.contentHashOf(member.module) === member.contentHash);
	}

	private answerHolds(cycle: Cycle, providerId: string, reply: Answered): boolean {
		const modules = reply.evidence.map((row) => row.module);
		const memberEvidence = new Set(modules.filter((module) => cycle.modules.includes(module)));
		if (new Set(modules).size !== modules.length || memberEvidence.size !== cycle.modules.length) return false;
		for (const evidence of reply.evidence) {
			if (this.store.contentHashOf(evidence.module) !== evidence.contentHash) return false;
			const current = this.store.importsIn(evidence.module);
			for (const { range, landing } of evidence.landings) {
				const edge = current.find((item) => sameRange(item.span, range));
				if (edge === undefined) return false;
				const stored = edge.landing === null ? null : landingKey(edge.landing);
				if (stored !== (landing === null ? null : landingKey(landing))) return false;
			}
		}
		const settings = new Map(reply.settings.map((setting) => [setting.project, setting.fingerprint]));
		if (settings.size !== reply.settings.length || (reply.verdict !== "unknown" && settings.size !== 1))
			return false;
		for (const [project, fingerprint] of settings) {
			if (project !== providerId || this.store.projectFingerprint(providerId) !== fingerprint) return false;
		}
		for (const hazard of reply.bad) {
			if (
				!cycle.entries.includes(hazard.entry) ||
				!cycle.modules.includes(hazard.reader.module) ||
				!modules.includes(hazard.target.module) ||
				!hazard.order.every((module) => cycle.modules.includes(module))
			)
				return false;
		}
		return (reply.verdict === "bad") === reply.bad.length > 0;
	}

	private unknown(cycle: Cycle, reason: Unknown["reason"]): Judgment {
		return { cycle, verdict: "unknown", bad: [], unknowns: [{ reason }], expires: this.expiry([{ reason }]) };
	}

	/** Why a request failed: its deadline, its process, or the provider refusing it. */
	private failure(error: unknown, provider: { id: string; incarnation: number }): Unknown["reason"] {
		if (error instanceof DeadlineError) return "timeout";
		if (error instanceof ProviderUnavailableError) return "outage";
		return this.providers.incarnationOf(provider.id) === provider.incarnation ? "refused" : "outage";
	}

	/** One retry rule for every judgment, whoever named the budget. */
	private expiry(unknowns: readonly Unknown[]): number {
		return this.clock.now() + (unknowns.some((item) => item.reason === "budget") ? RETRY_MS : HOLD_MS);
	}

	private shortRead<T>(dispatchGate: Gate | undefined, work: () => T): Promise<T> {
		return dispatchGate === undefined
			? this.gate.shared(async () => work())
			: dispatchGate.read(async () => work());
	}

	private slots(providerId: string): FifoSemaphore {
		let semaphore = this.providerSlots.get(providerId);
		if (semaphore === undefined) {
			semaphore = new FifoSemaphore(PROVIDER_SLOTS);
			this.providerSlots.set(providerId, semaphore);
		}
		return semaphore;
	}
}
