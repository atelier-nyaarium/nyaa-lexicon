// Load-order cycles: candidate components from runtime import edges, judged by their provider.

import {
	hashContent,
	type JudgeLoadCycleAnswer,
	type JudgeLoadCycleRequest,
	type LoadCycleHazard,
	type ModuleCycle,
	ModuleCycleSchema,
	ModuleCyclesRequestSchema,
	ModuleProblemsRequestSchema,
	sameRange,
	unjudgedLoadCycle,
} from "@nyaa-lexicon/protocol";
import { ErrorCodes } from "vscode-jsonrpc/node";
import type { Clock } from "./clock.js";
import { DeadlineError } from "./deadline.js";
import { landingKey } from "./exportProjection.js";
import { FifoSemaphore } from "./fifoSemaphore.js";
import { previewLoadCycles } from "./loadCyclePreview.js";
import { type Cycle, type Held, LoadCycleView } from "./loadCycleView.js";
import type { ProviderPort } from "./providerPort.js";
import type { ProviderProbe } from "./providerProbe.js";
import type { Gate } from "./stepRunners.js";
import type { IndexStore } from "./store.js";
import { ProviderUnavailableError } from "./supervisor.js";
import type { WorkspaceGate } from "./workspaceGate.js";

export {
	buildIn,
	type Cycle,
	componentsOf,
	type Graph,
	graphOf,
	newCycleComponents,
	previewComponents,
	withPreviewComponents,
} from "./loadCycleView.js";

////////////////////////////////
//  Interfaces & Types

type Unknown = ModuleCycle["unknowns"][number];

type Answered = Extract<JudgeLoadCycleAnswer, { verdict: unknown }>;

type Members = JudgeLoadCycleRequest["members"];

type Judgment = {
	cycle: Cycle;
	verdict: ModuleCycle["verdict"];
	bad: LoadCycleHazard[];
	unknowns: Unknown[];
	expires: number;
	/** What the provider was asked and answered; absent, the judgment is core's own and never cached. */
	basis?: Basis;
};

type Basis = {
	provider: { id: string; incarnation: number };
	members: Members;
	/** The provider's project settings when asked; null when it recorded none. */
	fingerprint: string | null;
	/**
	 * The modules the provider wrote when asked, as one key. Evidence covers what the judgment read;
	 * a module admitted since, new or brought in by a changed scope, was read by no one.
	 */
	written: string;
	reply?: Answered;
};

type Running = { cycle: Cycle; state: { superseded: boolean }; work: Promise<Judgment> };

////////////////////////////////
//  Constants

const MAX_ENTRIES = 32;
const MAX_SLICES = 40;
/** Judgments holding provider state at once, per provider. */
const PROVIDER_SLOTS = 4;
const HOLD_MS = 60_000;
/** A judgment past a budget is retried no sooner, unless its evidence moves. */
const RETRY_MS = 600_000;
/** Publish checks tried against a view a write keeps outdating before the answer reads as unknown. */
const PUBLISH_ATTEMPTS = 3;

////////////////////////////////
//  Functions & Helpers

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
	private readonly view: LoadCycleView;
	private readonly cache = new Map<string, Judgment>();
	private readonly running = new Map<string, Running>();
	private readonly providerSlots = new Map<string, FifoSemaphore>();
	/** Each provider's written-modules key, for the facts generation they were read at. */
	private writtenAt: { generation: number; keys: Map<string, string> } = { generation: -1, keys: new Map() };

	constructor(
		private readonly store: IndexStore,
		private readonly providers: ProviderPort,
		private readonly clock: Clock,
		private readonly gate: WorkspaceGate,
	) {
		this.view = new LoadCycleView(
			store,
			() => this.held,
			(dispatchGate, work) => this.shortRead(dispatchGate, work),
			(built) => this.keep(built),
		);
	}

	previewArrange(
		files: readonly import("@nyaa-lexicon/protocol").ArrangeFile[],
		probe: ProviderProbe,
		gate: Gate,
	): Promise<ModuleCycle[]> {
		return previewLoadCycles(this.store, this.providers, probe, this.clock, gate, files);
	}

	async moduleCycles(raw: unknown, dispatchGate?: Gate): Promise<ModuleCycle[]> {
		const query = ModuleCyclesRequestSchema.parse(raw);
		const shown = (judgment: Judgment) => query.verdict === undefined || judgment.verdict === query.verdict;
		// Nothing crosses an unread component, so it is never judged unless asked for.
		const asked = (cycle: Cycle) =>
			(query.module === undefined || cycle.modules.includes(query.module)) &&
			(query.includeUnread === true || cycle.crossingCount > 0);
		const knownBad = (cycle: Cycle) => Number(this.cache.get(cycle.key)?.verdict === "bad");
		const candidates = (await this.componentsNow(dispatchGate)).cycles
			.filter(asked)
			.sort((a, b) => knownBad(b) - knownBad(a) || a.modules[0]!.localeCompare(b.modules[0]!));
		const judged: Array<{ cycle: Cycle; judgment: Judgment }> = [];
		for (const cycle of candidates) {
			if (judged.length >= query.limit) break;
			const judgment = await this.judge(cycle);
			if (shown(judgment)) judged.push({ cycle, judgment });
		}
		// A component can stand differently at publish time, so the query holds it to the same filters.
		return (await this.published(judged, dispatchGate))
			.filter(({ cycle, judgment }) => asked(cycle) && shown(judgment))
			.sort(
				(a, b) =>
					Number(b.judgment.verdict === "bad") - Number(a.judgment.verdict === "bad") ||
					a.cycle.modules[0]!.localeCompare(b.cycle.modules[0]!),
			)
			.slice(0, query.limit)
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
		const current = (await this.published([{ cycle, judgment: await this.judge(cycle) }], dispatchGate)).find(
			(answer) => answer.cycle.modules.includes(query.module),
		);
		return (current?.judgment.bad ?? []).filter((hazard) => hazard.reader.module === query.module);
	}

	/** The component holding `module` as of now, without judging it; null when it sits in none. */
	async componentOf(
		module: string,
		dispatchGate?: Gate,
	): Promise<{ modules: string[]; crossingCount: number } | null> {
		const cycle = (await this.componentsNow(dispatchGate)).cycles.find((each) => each.modules.includes(module));
		return cycle === undefined ? null : { modules: cycle.modules, crossingCount: cycle.crossingCount };
	}

	/**
	 * Each judgment checked at publish time against the components as they are then, read again when
	 * a write outdated them. One whose membership, entries or evidence moved reads as unknown, with
	 * the component as it now stands; a component that dissolved, as the ones its members joined.
	 */
	private async published(
		judged: ReadonlyArray<{ cycle: Cycle; judgment: Judgment }>,
		dispatchGate?: Gate,
	): Promise<Array<{ cycle: Cycle; judgment: Judgment }>> {
		for (let attempt = 1; ; attempt++) {
			const now = await this.componentsNow(dispatchGate);
			const checked = await this.shortRead(dispatchGate, () => {
				const fresh = this.store.factsGeneration() === now.generation;
				if (!fresh && attempt < PUBLISH_ATTEMPTS) return null;
				const answers = new Map<string, { cycle: Cycle; judgment: Judgment }>();
				for (const { cycle, judgment } of judged) {
					const view = now.byKey.get(cycle.key);
					if (view === undefined) continue;
					const held = fresh && this.valid(judgment, view);
					answers.set(view.key, { cycle: view, judgment: held ? judgment : this.unknown(view, "evidence") });
				}
				for (const { cycle } of judged) {
					if (now.byKey.has(cycle.key)) continue;
					for (const joined of now.cycles) {
						if (answers.has(joined.key) || !joined.modules.some((module) => cycle.modules.includes(module)))
							continue;
						answers.set(joined.key, { cycle: joined, judgment: this.unknown(joined, "evidence") });
					}
				}
				return [...answers.values()];
			});
			if (checked !== null) return checked;
		}
	}

	private async componentsNow(dispatchGate?: Gate): Promise<Held> {
		return this.view.componentsNow(dispatchGate);
	}

	private keep(built: Held): Held {
		if (this.held === null || this.held.generation <= built.generation) {
			this.held = built;
			for (const key of this.cache.keys()) if (!built.byKey.has(key)) this.cache.delete(key);
		}
		return built;
	}

	/**
	 * One judgment per component at a time. An ask joins the running one unless it holds a newer view
	 * of a changed component, which replaces it. The work reads through the service's own gate, so no
	 * asker's wait budget can fail it for the others.
	 */
	private judge(cycle: Cycle): Promise<Judgment> {
		const held = this.running.get(cycle.key);
		if (held !== undefined && !held.state.superseded) {
			if (sameComponent(held.cycle, cycle) || held.cycle.generation >= cycle.generation) return held.work;
			held.state.superseded = true;
		}
		const state = { superseded: false };
		// Reserved before the cache check's await, so a concurrent asker never starts a second judgment.
		const entry: Running = { cycle, state, work: this.judgeHeld(cycle, () => state.superseded) };
		this.running.set(cycle.key, entry);
		const release = () => {
			if (this.running.get(cycle.key) === entry) this.running.delete(cycle.key);
		};
		void entry.work.then(release, release);
		return entry.work;
	}

	private async judgeHeld(cycle: Cycle, superseded: () => boolean): Promise<Judgment> {
		const cached = this.cache.get(cycle.key);
		if (
			cached !== undefined &&
			cached.expires > this.clock.now() &&
			(await this.shortRead(undefined, () => this.valid(cached, this.held?.byKey.get(cycle.key))))
		)
			return cached;
		const judgment = await this.run(cycle, superseded);
		const [current] = await this.published([{ cycle, judgment }]);
		if (current?.judgment !== judgment) return this.unknown(cycle, "evidence");
		if (judgment.basis !== undefined) this.cache.set(cycle.key, judgment);
		return judgment;
	}

	/**
	 * Asks the provider owning every member, one slice per request, holding one of its slots from the
	 * first slice to the last. Stops when superseded or when a member moves, and tells the provider to
	 * drop whatever partial state it still holds.
	 */
	private async run(cycle: Cycle, superseded: () => boolean): Promise<Judgment> {
		const { owner, members } = await this.shortRead(undefined, () => {
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
				members: cycle.modules.map((module) => ({ module, contentHash: this.store.contentHashOf(module) })),
			};
		});
		if (owner === null) return this.unknown(cycle, "provider");
		if (cycle.uncertainReason !== null) return this.unknown(cycle, cycle.uncertainReason);
		if (cycle.entries.length > MAX_ENTRIES) return this.unknown(cycle, "budget");
		const asked: Members = [];
		for (const member of members) {
			if (member.contentHash === null) return this.unknown(cycle, "evidence");
			asked.push({ module: member.module, contentHash: member.contentHash });
		}
		const release = await this.slots(owner).acquire();
		// Read after the wait: the process answering now is the one that will hold the partial state.
		const incarnation = this.providers.incarnationOf(owner);
		if (incarnation === null) {
			release();
			return this.unknown(cycle, "outage");
		}
		const { fingerprint, written } = await this.shortRead(undefined, () => ({
			fingerprint: this.store.projectFingerprint(owner),
			written: this.written(owner),
		}));
		const basis: Basis = { provider: { id: owner, incarnation }, members: asked, fingerprint, written };
		const failed = (reason: Unknown["reason"]): Judgment => ({ ...this.unknown(cycle, reason), basis });
		let partial: string | undefined;
		try {
			for (let slice = 0; slice < MAX_SLICES; slice++) {
				if (superseded() || !(await this.shortRead(undefined, () => this.membersHold(asked))))
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

	/** Whether a judgment still describes `view`, the component now: its provider, settings and evidence. */
	private valid(judgment: Judgment, view: Cycle | undefined): boolean {
		if (view === undefined || !sameComponent(view, judgment.cycle)) return false;
		const { basis } = judgment;
		if (basis === undefined) return true;
		if (this.providers.incarnationOf(basis.provider.id) !== basis.provider.incarnation) return false;
		if (this.store.projectFingerprint(basis.provider.id) !== basis.fingerprint) return false;
		if (this.written(basis.provider.id) !== basis.written) return false;
		if (!this.membersHold(basis.members)) return false;
		return basis.reply === undefined || this.answerHolds(view, basis.provider.id, basis.reply);
	}

	/** Every module the provider writes, as one key: an admission or removal moves it, an edit does not. */
	private written(providerId: string): string {
		const generation = this.store.factsGeneration();
		if (this.writtenAt.generation !== generation) this.writtenAt = { generation, keys: new Map() };
		let key = this.writtenAt.keys.get(providerId);
		if (key === undefined) {
			const modules = [...this.store.writers()].flatMap(([module, writer]) =>
				writer === providerId ? [module] : [],
			);
			key = hashContent(modules.sort().join("\u0000"));
			this.writtenAt.keys.set(providerId, key);
		}
		return key;
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
