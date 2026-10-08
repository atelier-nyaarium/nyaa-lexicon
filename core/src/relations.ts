// Computes relation evidence on read and combines it with statements from people, agents and models.

import type {
	NoteAuthor,
	Relation,
	RelationBetween,
	RelationCandidate,
	RelationCandidates,
	RelationEvidence,
	RelationGapAnswer,
	RelationGaps,
	RelationKind,
	RelationOutcome,
	RelationParts,
	Relations,
	StatedRelation,
} from "@nyaa-lexicon/protocol";
import { languageOf } from "@nyaa-lexicon/protocol";
import { authorOf, authorText, isPerson } from "./authors.js";
import type { Clock } from "./clock.js";
import type { CoChangeIndex } from "./history.js";
import { ReadContext, toSummary } from "./readContext.js";
import * as refusal from "./refusals.js";
import { orderedPair, type RelationProvenanceColumn, type StatedColumns, type StatedRow } from "./relationRows.js";
import {
	callerWeight,
	combine,
	computedHealth,
	feedbackFactor,
	jaccard,
	kindOf,
	overlap,
	RELATION_FLOOR,
	statedHealth,
	typeWordsOf,
	wordsOf,
} from "./relationScore.js";
import type { IndexStore, StoredDeclaration, StoredReference } from "./store.js";

////////////////////////////////
//  Interfaces & Types

export interface RelationOptions {
	limit?: number | undefined;
	kinds?: readonly RelationKind[] | undefined;
	intent?: string | undefined;
	withDoubted?: boolean | undefined;
}

export interface RelationWrite {
	symbolId: string;
	otherId: string;
	action: "state" | "confirm" | "doubt" | "remove";
	why?: string | undefined;
	reason?: string | undefined;
	expectedRevision: number;
	author?: NoteAuthor | undefined;
}

type Refused = Extract<RelationOutcome, { outcome: "refused" }>;

/** The wire shape with its reason slot narrowed to the catalog's brand. */
export type LedgerRelationOutcome =
	| Exclude<RelationOutcome, Refused>
	| (Omit<Refused, "reason"> & { reason: refusal.Refusal });

/** A candidate's evidence before feedback and stated rows are applied. */
interface Scored {
	other: StoredDeclaration;
	parts: RelationParts;
	evidence: RelationEvidence;
	base: number;
}

/** What a stated row says from one end: the other end and the row. */
interface StatedEnd {
	otherId: string;
	bound: boolean;
	row: StatedRow;
}

/** A waiting export, and the facts generation it was read at. */
export interface QueuedExport {
	symbolId: string;
	module: string;
	generation: number;
}

/** The modules an export would suit, and how strongly anything relates to it. */
export interface Discovery {
	modules: Array<{ module: string; score: number; via: string[] }>;
	best: number;
	stated: boolean;
}

////////////////////////////////
//  Constants

const DEFAULT_LIMIT = 20;

/** Uses of the focus read, and how many of their callers are followed. */
const USES_READ = 2_000;
const HOLDERS_READ = 60;

/** Candidates kept from each source before scoring. */
const CO_TARGETS_KEPT = 40;
const SIBLINGS_KEPT = 30;
const NAMED_WORDS = 2;
const NAMED_READ = 30;
const PARTNER_MODULES = 5;
const PARTNER_EXPORTS = 10;
const IMPORTED_MODULES = 5;
const IMPORTED_EXPORTS = 8;
const CANDIDATES_MAX = 150;

/** Rank lift for confirmed and proposed statements over computed relations. */
const CONFIRMED_LIFT = 0.5;
const PROPOSED_LIFT = 0.1;

/** Computed answers kept per facts generation. */
const MEMO_SIZE = 256;

/** Relations of an export that discovery follows, the modules it suggests the export to, and the
 * related symbols each suggestion names. */
export const DISCOVERY_RELATED = 10;
export const DISCOVERY_MODULES = 3;
const DISCOVERY_VIA = 3;

/** Discovery suggestion lifetime in milliseconds. */
export const DISCOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** What a module already using the export's module earns toward a suggestion. */
const NEIGHBOUR_LIFT = 0.5;

/** Below this best relation score, an export with no statement is a model gap. */
export const GAP_SCORE = 0.25;

/** Symbols a gap offers a model to judge. */
const GAP_CANDIDATES = 16;

/** Exports one module queues per batch, and suggestions one module keeps. */
const QUEUED_PER_MODULE = 20;
const DISCOVERY_PER_MODULE = 10;

/** Exports a new store's backfill queues. */
const BACKFILL_EXPORTS = 30;

const NO_EVIDENCE: RelationEvidence = { holders: 0, commits: null, words: [], imports: 0, sameModule: false };
const NO_PARTS: RelationParts = { callers: 0, cochange: null, words: 0, imports: 0, file: 0 };

////////////////////////////////
//  Functions & Helpers

function refused(reason: refusal.Refusal, current?: Relation | null): LedgerRelationOutcome {
	return { outcome: "refused", reason, ...(current === undefined ? {} : { current }) };
}

/** The declaration a use's evidence belongs to, or its module for a use at the top level. */
function holderOf(context: ReadContext, use: StoredReference): string {
	const owner = use.fromId === null ? null : context.ownerIn(use.module, use.fromId);
	return owner === null ? `module ${use.module}` : owner.symbolId;
}

function renderStated(row: StatedRow): StatedRelation {
	return {
		provenance: row.provenance,
		status: row.status,
		revision: row.revision,
		why: row.why,
		author: authorOf(row.author),
		at: row.authoredAt,
		judgedBy: authorOf(row.judgedBy),
		judgedAt: row.judgedAt,
		reason: row.reason,
	};
}

/** What another module sees of an export; a body edit leaves it alone. */
function shapeOf(declaration: StoredDeclaration): string {
	return `${declaration.kind}\n${declaration.signature ?? ""}`;
}

function rankOf(relation: Relation): number {
	const lift =
		relation.stated?.status === "confirmed"
			? CONFIRMED_LIFT
			: relation.stated?.status === "proposed"
				? PROPOSED_LIFT
				: 0;
	return relation.score + lift;
}

////////////////////////////////
//  Class

export class RelationLedger {
	private memo = new Map<string, Scored[]>();
	private memoGeneration = -1;
	private memoHistory: CoChangeIndex | null = null;
	/** Modules with exports past the queue cap, noticed again once their queue drains. */
	private overflowed = new Set<string>();

	constructor(
		private readonly store: IndexStore,
		private readonly clock: Clock,
	) {}

	////////////////////////////////
	//  Reads

	/** Each kind keeps its `limit` best; a doubted relation shows only when asked for. */
	relationsOf(symbolId: string, history: CoChangeIndex | null, options: RelationOptions = {}): Relations {
		const limit = options.limit ?? DEFAULT_LIMIT;
		const stated = this.statedEnds(symbolId);
		const relations = this.merged(symbolId, history, stated, options);
		const kept: Relation[] = [];
		const perKind = new Map<RelationKind, number>();
		let truncated = false;
		for (const relation of relations) {
			if (options.kinds !== undefined && !options.kinds.includes(relation.kind)) continue;
			const count = perKind.get(relation.kind) ?? 0;
			if (count >= limit) {
				truncated = true;
				continue;
			}
			perKind.set(relation.kind, count + 1);
			kept.push(relation);
		}
		return { symbolId, relations: kept, truncated, unavailable: history === null ? ["history"] : [] };
	}

	/** One pair, whatever it scores. */
	between(symbolId: string, otherId: string, history: CoChangeIndex | null, intent?: string): RelationBetween {
		if (symbolId === otherId) return { relation: null, reason: refusal.relationToItself(symbolId) };
		if (this.store.declaration(symbolId) === null) {
			return { relation: null, reason: refusal.subjectRefused(symbolId, this.store) };
		}
		const stated = this.statedEnds(symbolId).filter((end) => end.otherId === otherId);
		const found = this.merged(symbolId, history, stated, { intent, withDoubted: true }, [otherId], true).find(
			(relation) => relation.symbolId === otherId,
		);
		if (found !== undefined) return { relation: found };
		if (this.store.declaration(otherId) === null) {
			return { relation: null, reason: refusal.subjectRefused(otherId, this.store) };
		}
		return { relation: null };
	}

	/** Exports discovery suggested to a module that it still does not use, through symbols it still does, best first. */
	candidatesForModule(module: string, limit: number, intent?: string): RelationCandidates {
		const now = this.clock.now();
		const candidates: RelationCandidate[] = [];
		for (const row of this.store.relations.discoveryFor(module, now - DISCOVERY_TTL_MS)) {
			const exported = this.store.declaration(row.symbolId);
			if (exported === null || this.store.moduleUses(module, row.symbolId)) continue;
			const via = row.via.flatMap((id) => {
				const declaration = this.store.declaration(id);
				return declaration === null || !this.store.moduleUses(module, id) ? [] : [declaration];
			});
			if (via.length === 0) continue;
			const feedback = this.store.relations.feedbackFor(row.symbolId, intent ?? null, now);
			const factor = Math.max(...via.map((each) => feedbackFactor(feedback.get(each.symbolId) ?? null)));
			candidates.push({
				export: toSummary(exported),
				module,
				score: Math.min(1, row.score * factor),
				via: via.map(toSummary),
				at: row.at,
			});
		}
		candidates.sort((a, b) => b.score - a.score || a.export.symbolId.localeCompare(b.export.symbolId));
		return { candidates: candidates.slice(0, limit), unavailable: [] };
	}

	/** The modules an export would suit, computed now. */
	candidatesForSymbol(
		symbolId: string,
		limit: number,
		history: CoChangeIndex | null,
		intent?: string,
	): RelationCandidates {
		const exported = this.store.declaration(symbolId);
		const unavailable: Array<"history"> = history === null ? ["history"] : [];
		if (exported === null) return { candidates: [], unavailable };
		const found = this.discover(symbolId, history, intent, limit);
		const candidates = found.modules.map(
			(each): RelationCandidate => ({
				export: toSummary(exported),
				module: each.module,
				score: each.score,
				via: each.via.flatMap((id) => {
					const declaration = this.store.declaration(id);
					return declaration === null ? [] : [toSummary(declaration)];
				}),
			}),
		);
		return { candidates, unavailable };
	}

	/**
	 * The modules an export would suit: each module using what relates to it, but not it, scored by
	 * those relations, and lifted when it already uses something the export's module declares.
	 * `best` is its strongest relation, for telling a gap.
	 */
	discover(symbolId: string, history: CoChangeIndex | null, intent?: string, limit = DISCOVERY_MODULES): Discovery {
		const exported = this.store.declaration(symbolId);
		if (exported === null) return { modules: [], best: 0, stated: false };
		// A file adopts an export only in its own language, however alike a twin in another reads.
		const language = languageOf(symbolId);
		const related = this.relationsOf(symbolId, history, { limit: DISCOVERY_RELATED, intent })
			.relations.filter(
				(relation) =>
					relation.symbol !== undefined &&
					relation.stated?.status !== "doubted" &&
					languageOf(relation.symbolId) === language,
			)
			.sort((a, b) => b.score - a.score)
			.slice(0, DISCOVERY_RELATED);
		const using = new Set([exported.module, ...this.store.usingModules(symbolId).keys()]);
		const fromTest = this.store.testModule(exported.module);
		const byModule = new Map<string, { score: number; via: string[] }>();
		const add = (module: string, score: number, via: readonly string[]) => {
			if (using.has(module) || (!fromTest && this.store.testModule(module))) return;
			const held = byModule.get(module) ?? { score: 0, via: [] };
			held.score += score;
			for (const id of via) if (held.via.length < DISCOVERY_VIA && !held.via.includes(id)) held.via.push(id);
			byModule.set(module, held);
		};
		for (const relation of related) {
			for (const module of this.store.usingModules(relation.symbolId).keys()) {
				add(module, relation.score, [relation.symbolId]);
			}
		}
		for (const [module, siblings] of this.store.usesInto(exported.module, symbolId)) {
			add(module, NEIGHBOUR_LIFT, siblings);
		}
		// Ranked on the raw sums, so two strong candidates never tie at the cap.
		const modules = [...byModule]
			.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
			.slice(0, limit)
			.map(([module, held]) => ({ module, score: Math.min(1, held.score), via: held.via }));
		return {
			modules,
			best: related.reduce((top, relation) => Math.max(top, relation.score), 0),
			stated: related.some((relation) => relation.stated !== null),
		};
	}

	/** Open gaps, each with the symbols a model may judge it against. */
	gaps(limit: number, history: CoChangeIndex | null): RelationGaps {
		const { rows, total } = this.store.relations.gaps(limit);
		const gaps = rows.flatMap((row) => {
			const declaration = this.store.declaration(row.symbolId);
			if (declaration === null) return [];
			const candidates = this.scored(row.symbolId, history, [])
				.sort((a, b) => b.base - a.base)
				.slice(0, GAP_CANDIDATES)
				.map((each) => toSummary(each.other));
			return [{ symbol: toSummary(declaration), candidates, at: row.at }];
		});
		return { gaps, total };
	}

	////////////////////////////////
	//  Writes

	/** A person's word stands; an agent's over a pair a person judged changes nothing. */
	write(request: RelationWrite, provenance: "agent" | "model" = "agent"): LedgerRelationOutcome {
		const { symbolId, otherId, action } = request;
		if (symbolId === otherId) return refused(refusal.relationToItself(symbolId));
		const writer = request.author ?? null;
		const person = isPerson(writer);
		const now = this.clock.now();
		const near = this.store.subjects.forAddress(symbolId);
		const far = this.store.subjects.forAddress(otherId);
		const row =
			near === null || far === null ? null : this.store.relations.statedBetween(near.subjectId, far.subjectId);
		const revision = row?.revision ?? 0;
		const current = () => this.between(symbolId, otherId, null).relation;
		if (request.expectedRevision !== revision) {
			return refused(refusal.relationRevisionMoved(request.expectedRevision, revision), current());
		}
		if (action !== "state" && !person) return refused(refusal.relationNeedsPerson(action));

		if (action === "remove") {
			if (row === null) return refused(refusal.noRelationStands(symbolId, otherId));
			this.store.relationWrite(() => this.store.relations.remove(row.subjectId, row.otherId));
			this.forget();
			return { outcome: "saved", relation: current() };
		}

		if (action === "state") {
			const why = request.why?.trim() ?? "";
			if (why === "") return refused(refusal.relationNeedsWhy());
			if (!person && row !== null && (row.status !== "proposed" || row.provenance === "person")) {
				const standing = current();
				if (standing !== null) return { outcome: "kept", relation: standing };
			}
			const saved = this.save(symbolId, otherId, row, now, {
				provenance: person ? "person" : provenance,
				status: person ? "confirmed" : "proposed",
				why,
				author: authorText(writer),
				authoredAt: now,
				judgedBy: person ? authorText(writer) : null,
				judgedAt: person ? now : null,
				reason: null,
			});
			if (saved !== null) return refused(saved);
			const relation = current();
			if (relation === null) return refused(refusal.subjectRefused(symbolId, this.store));
			return person ? { outcome: "saved", relation } : { outcome: "proposed", relation };
		}

		const reason = request.reason?.trim() ?? "";
		if (action === "doubt" && reason === "") return refused(refusal.doubtNeedsReason());
		const saved = this.save(symbolId, otherId, row, now, {
			provenance: row?.provenance ?? "computed",
			status: action === "confirm" ? "confirmed" : "doubted",
			why: row?.why ?? null,
			author: row?.author ?? authorText(writer),
			authoredAt: row?.authoredAt ?? now,
			judgedBy: authorText(writer),
			judgedAt: now,
			reason: action === "doubt" ? reason : null,
		});
		if (saved !== null) return refused(saved);
		return { outcome: "saved", relation: current() };
	}

	/** A model's judgment of a gap: each relation a proposal, and the gap answered. */
	answerGap(symbolId: string, related: ReadonlyArray<{ symbolId: string; why: string }>, author?: NoteAuthor) {
		const answer: RelationGapAnswer = { proposed: 0, kept: 0, refused: [] };
		for (const each of related) {
			const standing = this.between(symbolId, each.symbolId, null).relation?.stated ?? null;
			const outcome = this.write(
				{
					symbolId,
					otherId: each.symbolId,
					action: "state",
					why: each.why,
					expectedRevision: standing?.revision ?? 0,
					author,
				},
				"model",
			);
			if (outcome.outcome === "proposed" || outcome.outcome === "saved") answer.proposed++;
			else if (outcome.outcome === "kept") answer.kept++;
			else answer.refused.push({ symbolId: each.symbolId, reason: outcome.reason });
		}
		if (this.store.relations.isOpenGap(symbolId)) {
			this.store.relationWrite(() => this.store.relations.answerGap(symbolId, this.clock.now()));
		}
		return answer;
	}

	feedback(
		pairs: ReadonlyArray<{ symbolId: string; otherId: string }>,
		intent: string,
		outcome: "accepted" | "rejected",
	): { recorded: number } {
		const now = this.clock.now();
		let recorded = 0;
		const held = (symbolId: string) => this.store.declaration(symbolId) !== null;
		this.store.relationWrite(() => {
			for (const pair of pairs) {
				if (pair.symbolId === pair.otherId || !held(pair.symbolId) || !held(pair.otherId)) continue;
				this.store.relations.addFeedback(pair.symbolId, pair.otherId, intent, outcome, now);
				recorded++;
			}
		});
		return { recorded };
	}

	////////////////////////////////
	//  Discovery's upkeep

	/**
	 * Seeds the export snapshot without queueing, once per store, so an existing workspace starts
	 * quiet. `unseen` modules stay out of it, for `notice` to queue whole.
	 */
	seedExports(unseen: readonly string[] = []): boolean {
		if (this.store.relations.hasExports()) return false;
		const context = new ReadContext(this.store);
		const skipped = new Set(unseen);
		this.store.relationWrite(() => {
			for (const module of this.store.exportingModules()) {
				if (skipped.has(module)) continue;
				const exports = new Map(this.exportsIn(context, module).map((each) => [each.symbolId, shapeOf(each)]));
				this.store.relations.setExports(module, exports);
			}
		});
		return true;
	}

	/** Queues added or reshaped exports, all of a module discovery never saw; a gone export takes its suggestions along. */
	notice(indexed: readonly string[], forgotten: readonly string[]): number {
		const now = this.clock.now();
		const context = new ReadContext(this.store);
		let queued = 0;
		this.store.relationWrite(() => {
			for (const module of forgotten) {
				this.store.relations.forgetModule(module);
				this.overflowed.delete(module);
			}
			for (const module of indexed) {
				const held = this.store.relations.exportsOf(module);
				const current = new Map(this.exportsIn(context, module).map((each) => [each.symbolId, shapeOf(each)]));
				const fresh = [...current].filter(([symbolId, shape]) => held?.get(symbolId) !== shape);
				const taken = fresh.slice(0, QUEUED_PER_MODULE).map(([symbolId]) => ({ symbolId, module }));
				// Past the cap, old shapes stay until the drain re-notices.
				if (fresh.length > QUEUED_PER_MODULE) this.overflowed.add(module);
				else this.overflowed.delete(module);
				const seen = new Map(current);
				for (const [symbolId] of fresh.slice(QUEUED_PER_MODULE)) {
					const before = held?.get(symbolId);
					if (before === undefined) seen.delete(symbolId);
					else seen.set(symbolId, before);
				}
				for (const symbolId of held?.keys() ?? []) {
					if (!current.has(symbolId)) this.store.relations.forgetExport(symbolId);
				}
				this.store.relations.enqueue(taken, now);
				this.store.relations.setExports(module, seen);
				queued += taken.length;
			}
		});
		return queued;
	}

	/** Queues export changes made while no daemon watched. */
	reconcile(): number {
		const modules = new Set([...this.store.exportingModules(), ...this.store.relations.exportModules()]);
		return this.notice([...modules], []);
	}

	/** Queues up to `BACKFILL_EXPORTS` exports in files the newest commits touched, newest first, so a new store samples recent work. */
	backfill(modules: readonly string[]): number {
		const context = new ReadContext(this.store);
		const entries = [...new Set(modules)]
			.flatMap((module) => this.exportsIn(context, module).map((each) => ({ symbolId: each.symbolId, module })))
			.slice(0, BACKFILL_EXPORTS);
		this.store.relationWrite(() => this.store.relations.enqueue(entries, this.clock.now()));
		return entries.length;
	}

	/** The oldest waiting export and the facts generation it is read at, or null when none waits. */
	nextQueued(): QueuedExport | null {
		const queued = this.store.relations.nextQueued();
		return queued === null ? null : { ...queued, generation: this.store.factsGeneration() };
	}

	/**
	 * One export's discovery written, only over the facts it was scored on; otherwise it stays queued
	 * for another slice. A gap opens while nothing relates to it strongly, and closes once something does.
	 */
	settleQueued(queued: QueuedExport, found: Discovery | null): boolean {
		if (this.store.factsGeneration() !== queued.generation) return false;
		const { symbolId, module } = queued;
		const now = this.clock.now();
		this.store.relationWrite(() => {
			this.store.relations.dequeue(symbolId);
			if (found === null || this.store.declaration(symbolId) === null) return;
			this.store.relations.replaceDiscovery(symbolId, module, found.modules, now, DISCOVERY_PER_MODULE);
			if (found.best < GAP_SCORE && !found.stated) this.store.relations.addGap(symbolId, module, now);
			else this.store.relations.closeGap(symbolId);
		});
		if (this.overflowed.has(module) && this.store.relations.queuedIn(module) === 0) this.notice([module], []);
		return true;
	}

	/** Stale suggestions and faded feedback, gone. */
	tidy(): void {
		const now = this.clock.now();
		this.store.relationWrite(() => {
			this.store.relations.expireDiscovery(now - DISCOVERY_TTL_MS);
			this.store.relations.pruneFeedback(now);
		});
	}

	////////////////////////////////
	//  Scoring

	/** Computed answers, then stated rows, feedback and health, ranked. */
	private merged(
		symbolId: string,
		history: CoChangeIndex | null,
		stated: readonly StatedEnd[],
		options: RelationOptions,
		forced: readonly string[] = [],
		keepWeak = false,
	): Relation[] {
		const now = this.clock.now();
		const byOther = new Map(stated.map((end) => [end.otherId, end]));
		const feedback = this.store.relations.feedbackFor(symbolId, options.intent ?? null, now);
		const scored = this.scored(symbolId, history, [
			...forced,
			...stated.filter((end) => end.bound).map((end) => end.otherId),
		]);
		const relations: Relation[] = [];
		const shown = new Set<string>();
		for (const each of scored) {
			const id = each.other.symbolId;
			const end = byOther.get(id) ?? null;
			if (end?.row.status === "doubted" && options.withDoubted !== true) continue;
			const counts = feedback.get(id) ?? null;
			const score = Math.min(1, each.base * feedbackFactor(counts));
			// Feedback can cross the floor.
			const weak = score < RELATION_FLOOR;
			if (end === null && weak && !(keepWeak && forced.includes(id))) continue;
			shown.add(id);
			relations.push({
				symbolId: id,
				symbol: toSummary(each.other),
				score,
				kind: weak && end !== null ? "stated" : kindOf(each.parts),
				parts: each.parts,
				evidence: each.evidence,
				health: end === null ? computedHealth(each.evidence) : statedHealth(end.row),
				stated: end === null ? null : renderStated(end.row),
				feedback: counts,
			});
		}
		for (const end of stated) {
			if (shown.has(end.otherId) || (end.row.status === "doubted" && options.withDoubted !== true)) continue;
			// An end the index no longer holds still names what was stated.
			relations.push({
				symbolId: end.otherId,
				score: 0,
				kind: "stated",
				parts: NO_PARTS,
				evidence: NO_EVIDENCE,
				health: end.bound ? statedHealth(end.row) : "orphaned",
				stated: renderStated(end.row),
				feedback: null,
			});
		}
		return relations.sort((a, b) => rankOf(b) - rankOf(a) || a.symbolId.localeCompare(b.symbolId));
	}

	/** Every stated row naming `symbolId`, from that end. */
	private statedEnds(symbolId: string): StatedEnd[] {
		return this.store.relations.statedFor(symbolId).map((row) => {
			const near = row.symbolId === symbolId;
			const otherId = near ? row.otherSymbolId : row.symbolId;
			const otherState = near ? row.otherState : row.state;
			return {
				otherId,
				bound: otherState === "bound" && this.store.declaration(otherId) !== null,
				row,
			};
		});
	}

	/** Remembered per facts generation and history read; `forced` pairs score whatever their source. */
	private scored(symbolId: string, history: CoChangeIndex | null, forced: readonly string[]): Scored[] {
		const generation = this.store.factsGeneration();
		if (generation !== this.memoGeneration || history !== this.memoHistory) this.forget(generation, history);
		const key = `${symbolId}\n${[...forced].sort().join("\n")}`;
		const held = this.memo.get(key);
		if (held !== undefined) return held;
		const computed = this.compute(symbolId, history, forced);
		if (this.memo.size >= MEMO_SIZE) this.memo.delete(this.memo.keys().next().value as string);
		this.memo.set(key, computed);
		return computed;
	}

	private forget(generation = this.store.factsGeneration(), history = this.memoHistory): void {
		this.memo.clear();
		this.memoGeneration = generation;
		this.memoHistory = history;
	}

	private compute(symbolId: string, history: CoChangeIndex | null, forced: readonly string[]): Scored[] {
		const context = new ReadContext(this.store);
		const focus = context.declaration(symbolId);
		if (focus === null || context.isLocal(focus)) return [];
		const inside = context.descendantIds(symbolId);

		// Callers of the focus, each counted once, then what each of them also uses.
		const holders = new Set<string>();
		for (const use of this.store.usesTo(symbolId).slice(0, USES_READ)) {
			const holder = holderOf(context, use);
			if (!inside.has(holder)) holders.add(holder);
		}
		const followed = [...holders].slice(0, HOLDERS_READ);
		const coTargets = new Map<string, { weight: number; holders: number }>();
		for (const holder of followed) {
			const targets = this.targetsOf(context, holder);
			const weight = callerWeight(targets.size);
			for (const target of targets) {
				if (inside.has(target)) continue;
				const held = coTargets.get(target) ?? { weight: 0, holders: 0 };
				coTargets.set(target, { weight: held.weight + weight, holders: held.holders + 1 });
			}
		}

		// A test's helpers relate to code under test, never the other way round.
		const testFocus = this.store.testModule(focus.module);
		const tests = new Map<string, boolean>();
		const apart = (module: string): boolean => {
			if (testFocus) return false;
			let test = tests.get(module);
			if (test === undefined) {
				test = this.store.testModule(module);
				tests.set(module, test);
			}
			return test;
		};

		const nameWords = wordsOf(focus.name);
		const stated = new Set(forced);
		const candidates = new Set<string>(forced);
		for (const [id] of [...coTargets].sort((a, b) => b[1].weight - a[1].weight).slice(0, CO_TARGETS_KEPT)) {
			candidates.add(id);
		}
		for (const sibling of context.moduleLevel(focus.module).declarations.slice(0, SIBLINGS_KEPT)) {
			candidates.add(sibling.symbolId);
		}
		for (const word of [...nameWords].sort((a, b) => b.length - a.length).slice(0, NAMED_WORDS)) {
			for (const named of this.store.symbolsNamedLike(word, NAMED_READ)) candidates.add(named.symbolId);
		}
		for (const partner of history?.partners(focus.module, PARTNER_MODULES) ?? []) {
			if (apart(partner.file)) continue;
			for (const each of this.exportsIn(context, partner.file).slice(0, PARTNER_EXPORTS)) {
				candidates.add(each.symbolId);
			}
		}
		const focusImports = this.store.importTargets(focus.module);
		for (const module of focusImports.slice(0, IMPORTED_MODULES)) {
			for (const each of this.exportsIn(context, module).slice(0, IMPORTED_EXPORTS))
				candidates.add(each.symbolId);
		}
		for (const id of inside) candidates.delete(id);

		const ids = [...candidates].slice(0, Math.max(CANDIDATES_MAX, forced.length));
		const users = this.store.holderCounts(ids);
		const focusNames = new Set(nameWords);
		const focusTypes = new Set(typeWordsOf(focus.signature));
		const importsBy = new Map<string, Set<string>>([[focus.module, new Set([...focusImports, focus.module])]]);
		const importsOf = (module: string): Set<string> => {
			let held = importsBy.get(module);
			if (held === undefined) {
				held = new Set([...this.store.importTargets(module), module]);
				importsBy.set(module, held);
			}
			return held;
		};

		const scored: Scored[] = [];
		for (const id of ids) {
			const other = context.declaration(id);
			if (other === null || context.isLocal(other) || (apart(other.module) && !stated.has(id))) continue;
			const sameModule = other.module === focus.module;
			const shared = coTargets.get(id);
			const callers =
				shared === undefined || followed.length === 0
					? 0
					: Math.min(1, shared.weight / Math.sqrt(followed.length * Math.max(1, users.get(id) ?? 0)));
			// A shared type says less than a shared name word.
			const names = overlap(focusNames, new Set(wordsOf(other.name)));
			const types = overlap(focusTypes, new Set(typeWordsOf(other.signature)));
			const words = {
				score: (2 * names.score + types.score) / 3,
				shared: [...new Set([...names.shared, ...types.shared])].sort(),
			};
			const imports = sameModule
				? { shared: 0, score: 0 }
				: jaccard(importsOf(focus.module), importsOf(other.module));
			const together = history === null || sameModule ? 0 : history.together(focus.module, other.module);
			const cochange =
				history === null
					? null
					: together === 0
						? 0
						: together / Math.sqrt(history.outOf(focus.module) * history.outOf(other.module));
			const parts: RelationParts = {
				callers,
				cochange,
				words: words.score,
				imports: imports.score,
				file: sameModule ? 1 : 0,
			};
			scored.push({
				other,
				parts,
				evidence: {
					holders: shared?.holders ?? 0,
					commits: history === null ? null : together,
					words: words.shared,
					imports: imports.shared,
					sameModule,
				},
				base: combine(parts),
			});
		}
		return scored;
	}

	/** A module's top-level declarations its provider says it exports. */
	private exportsIn(context: ReadContext, module: string): StoredDeclaration[] {
		return context.moduleLevel(module).declarations.filter((each) => each.exported === true);
	}

	/** What a caller uses: a declaration's own uses and its locals', or a module's top-level uses. */
	private targetsOf(context: ReadContext, holder: string): Set<string> {
		return holder.startsWith("module ")
			? this.store.topLevelTargets(holder.slice("module ".length))
			: this.store.targetsFrom(context.ownedIds(holder));
	}

	/** Claims both ends and writes the row, the lesser subject first; a refusal when an end cannot be claimed. */
	private save(
		symbolId: string,
		otherId: string,
		row: StatedRow | null,
		now: number,
		columns: Omit<StatedColumns, "recordedAs" | "otherAs" | "revision" | "digest" | "otherDigest"> & {
			provenance: RelationProvenanceColumn;
		},
	): refusal.Refusal | null {
		for (const id of [symbolId, otherId]) {
			const declaration = this.store.declaration(id);
			if (declaration === null) return refusal.subjectRefused(id, this.store);
			if (new ReadContext(this.store).isLocal(declaration)) return refusal.relationNotLocal(declaration.kind);
		}
		return this.store.relationWrite(() => {
			const one = this.store.subjects.claim(symbolId, now);
			const other = this.store.subjects.claim(otherId, now);
			if (one === null) return refusal.subjectRefused(symbolId, this.store);
			if (other === null) return refusal.subjectRefused(otherId, this.store);
			const [first] = orderedPair(one.subjectId, other.subjectId);
			const [near, far] = first === one.subjectId ? [one, other] : [other, one];
			this.store.relations.save(near.subjectId, far.subjectId, {
				...columns,
				recordedAs: near.symbolId,
				otherAs: far.symbolId,
				revision: (row?.revision ?? 0) + 1,
				digest: this.store.relations.digestOf(near.subjectId),
				otherDigest: this.store.relations.digestOf(far.subjectId),
			});
			this.forget();
			return null;
		});
	}
}
