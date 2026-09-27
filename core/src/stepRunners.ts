// Refactor steps as the daemon runs them: planned outside the write gate, journaled inside it.

import {
	type CommittedFile,
	type CommittedStep,
	defined,
	type InsertOutcome,
	type MoveOutcome,
	type RefactorIssue,
	type RenameStepOutcome,
	type ReplaceSpanOutcome,
	type ReverseStep,
	reverseOf,
} from "@nyaa-lexicon/protocol";
import type { ReadContext } from "./readContext.js";
import { journaledStep, type RefusedWith, type StepPolicy } from "./refactorStep.js";
import type { PlannedMove } from "./refusalSlots.js";
import {
	changedWhilePlanned,
	factsMovedWhilePlanned,
	type Refusal,
	staleSincePlanned,
	stepCancelled,
	stepIdTaken,
} from "./refusals.js";
import type { LexiconService } from "./service.js";
import type { TransactionManager } from "./transactions.js";

////////////////////////////////
//  Interfaces & Types

/** Absent for a daemon built without refactor support; the gate is the service's either way. */
export interface RefactorDeps {
	transactions: TransactionManager;
}

/** The workspace gate as a handler sees it, in the two halves a handler may take. */
export interface Gate {
	read<T>(work: () => Promise<T> | T): Promise<T>;
	write<T>(work: () => Promise<T> | T): Promise<T>;
}

/** A rename or move's result, before its wire shape is chosen. */
export type StepResult =
	| {
			done: true;
			/** The root's id now. */
			root: string;
			forwarded: Array<{ from: string; to: string }>;
			modules: string[];
			/** A move's canonical target. */
			toModule?: string;
			files: CommittedFile[];
			reverse: ReverseStep;
			migrated?: { answers: number; gaps: number };
			issues: RefactorIssue[];
	  }
	| ({ done: false; reason: Refusal; issues: RefactorIssue[] } & RefusedWith);

////////////////////////////////
//  Steps

/**
 * A move as one transaction step.
 *
 * Every module gets one provider request describing only its own part, and a blocked site anywhere
 * stops the whole thing: a move that relocates a declaration and leaves half its importers pointing
 * at the old module is worse than one that did not start.
 */
export function refactorMove(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId: string; toModule: string },
	hold: StepPolicy,
	cancelled?: () => Refusal | null,
): Promise<StepResult> {
	let requested = args.symbolId;
	let touched: string[] = [];
	let source = "";
	let target = args.toModule;
	let migrated: { answers: number; gaps: number } | undefined;
	const idMap = new Map<string, string>();

	return journaledStep<StepResult>(
		{ service, transactions, write },
		{
			kind: "move",
			hold,
			...defined({ cancelled }),
			refuse: (reason, issues, why) => ({ done: false, reason, issues, ...why }),
			succeed: (issues, _hold, files) => {
				const root = idMap.get(requested) ?? requested;
				return {
					done: true,
					root,
					forwarded: [...idMap].map(([from, to]) => ({ from, to })),
					modules: touched,
					toModule: target,
					files,
					reverse: reverseOf("move", requested, root) ?? { kind: "move", symbolId: root, toModule: source },
					...defined({ migrated }),
					issues,
				};
			},
			plan: async () => {
				// Held past the call, so the stale check below asks what it stamped.
				const context = service.newReadContext();
				const plan = service.planMove(args.symbolId, args.toModule, context);
				if (!plan.ok) return { refused: plan.reason };
				requested = plan.symbolId;
				source = plan.fromModule;
				target = plan.toModule;
				const edits = await service.moveEdits(plan, context);
				if (!edits.ok) return { refused: edits.reason, issues: edits.issues };
				touched = edits.files.map((file) => file.module);
				const bases = new Map(edits.bases.map((base) => [base.module, base.hash]));

				return {
					planned: {
						modules: touched,
						// Edits carry bases.
						writes: edits.files.map((file) => ({
							module: file.module,
							base: bases.get(file.module) ?? null,
							text: file.text,
						})),
						planRecord: { from: plan.fromModule, to: plan.toModule },
						stale: () => moveStale(service, plan, context),
						begin: () => {
							for (const id of plan.closure) {
								const rebased = service.rebaseIntoModule(id, plan.symbolId, plan.toModule);
								if (rebased !== null) idMap.set(id, rebased);
							}
						},
						rebind: () => ({
							entries: [...idMap].map(([from, to]) => ({ from, to })),
							evidence: "journalMove",
						}),
						// Target first, so every other module rebinds against a declaration that
						// already exists in its new home rather than one that has just vanished.
						reindex: [plan.toModule, ...touched.filter((m) => m !== plan.toModule)],
						issues: edits.issues,
						finish: (issues, rebound) => {
							if (rebound !== undefined) migrated = { answers: rebound.answers, gaps: rebound.gaps };
							// Asked of the reindexed facts, since a specifier can be well formed and
							// still point nowhere.
							issues.push(...service.checkMoveLanded(plan.name, touched));
						},
					},
				};
			},
		},
	);
}

/**
 * A rename as one transaction step, journaled like any other.
 *
 * The edits and the ids they re-mint are worked out outside the gate before anything moves,
 * because afterwards the old ids no longer resolve and there is nothing left to map from.
 */
export function refactorRename(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId: string; newName: string },
	hold: StepPolicy,
	cancelled?: () => Refusal | null,
): Promise<StepResult> {
	let modules: string[] = [];
	let oldName = "";
	let migrated: { answers: number; gaps: number } | undefined;
	let idMap = new Map<string, string>();

	return journaledStep<StepResult>(
		{ service, transactions, write },
		{
			kind: "rename",
			hold,
			...defined({ cancelled }),
			refuse: (reason, issues, why) => ({ done: false, reason, issues, ...why }),
			succeed: (issues, _hold, files) => {
				const root = idMap.get(args.symbolId) ?? args.symbolId;
				return {
					done: true,
					root,
					forwarded: [...idMap].map(([from, to]) => ({ from, to })),
					modules,
					files,
					// A local's id carries no name.
					reverse: reverseOf("rename", args.symbolId, root) ?? {
						kind: "rename",
						symbolId: root,
						newName: oldName,
					},
					...defined({ migrated }),
					issues,
				};
			},
			plan: async () => {
				// One context, so the plan and the two follow-up reads below stamp and share one set.
				const context = service.newReadContext();
				const edits = await service.renameEdits(args.symbolId, args.newName, context);
				if (!edits.ok) {
					return {
						refused: edits.reason,
						issues: edits.plan.blockers.map((blocker) => ({ kind: blocker.kind, detail: blocker.detail })),
					};
				}
				const plan = edits.plan;
				oldName = plan.oldName;
				const planned = service.renameWrites(edits.files);
				if ("reason" in planned) return { refused: planned.reason };

				idMap = service.renameIdMap(args.symbolId, args.newName, context);
				const edited = plan.files.map((file) => file.module);
				// Worked out before the write, since afterwards these ids resolve to nothing and the
				// modules holding stale bindings would be unfindable.
				const alsoBound = service
					.modulesBoundTo(idMap.keys(), context)
					.filter((module) => !edited.includes(module));
				const written = planned.writes.map((write) => write.module);
				modules = [...written, ...alsoBound];

				return {
					planned: {
						modules: [...edited, ...alsoBound],
						writes: planned.writes,
						planRecord: plan,
						stale: () => {
							// Every site was chosen from stored ranges; a changed module has moved
							// them, so rewriting would hit some occurrences and miss others.
							const stale = service.staleModules(edited);
							if (stale.length > 0) return staleSincePlanned(stale, "rename");
							// Rows re-committed under an equal hash: a re-parse or an upgrade.
							const moved = service.factsMoved(context.seen());
							return moved.length > 0 ? factsMovedWhilePlanned(moved, "rename") : null;
						},
						rebind: () => ({
							entries: [...idMap].map(([from, to]) => ({ from, to })),
							evidence: "journalRename",
						}),
						reindex: modules,
						issues: plan.warnings.map((warning) => ({ kind: warning.kind, detail: warning.detail })),
						finish: (_issues, rebound) => {
							if (rebound !== undefined) migrated = { answers: rebound.answers, gaps: rebound.gaps };
						},
					},
				};
			},
		},
	);
}

/**
 * Plan first, outside the gate, then write inside it.
 *
 * Planning parses a candidate and asks the index what would break, which is the slow half and
 * needs no exclusivity. The gate is held only across journal, write and reindex, and the file's
 * hash and the stamps of the rows the plan read are rechecked once held: anything that changed
 * either in between invalidates the plan that was just made, and applying anyway would overwrite
 * whatever changed it, or land over facts the plan never saw.
 */
export function refactorReplace(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { symbolId?: string | undefined; factId?: string | undefined; newText: string },
	span?: { expectedSpanHash: string; hold: StepPolicy },
): Promise<ReplaceSpanOutcome> {
	let module = "";
	let stale = false;

	return journaledStep<ReplaceSpanOutcome>(
		{ service, transactions, write },
		{
			kind: "replace",
			hold: span?.hold ?? "join",
			refuse: (reason, issues) => ({ replaced: false, issues, reason, ...(stale ? { stale } : {}) }),
			succeed: (issues, transaction) => ({
				replaced: true,
				module,
				issues,
				...(span === undefined ? {} : { transaction }),
			}),
			plan: async () => {
				const plan = await service.planReplacement(args, args.newText, span?.expectedSpanHash);
				if (!plan.ok) {
					stale = plan.stale === true;
					return { refused: plan.reason };
				}
				module = plan.module;

				return {
					planned: {
						modules: [plan.module],
						// Splice and span share one base hash.
						writes: [{ module: plan.module, base: plan.baseHash, text: plan.text }],
						planRecord: { range: plan.range },
						stale: () => {
							// Equal hashes can hide reparses or upgrades.
							const moved = service.factsMoved(plan.facts);
							return moved.length > 0 ? factsMovedWhilePlanned(moved, "replacement") : null;
						},
						reindex: [plan.module],
						issues: plan.issues,
					},
				};
			},
		},
	);
}

/** Insert as one transaction step: the replace pipeline with a computed splice point. */
export function refactorInsert(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: { after?: string | undefined; module?: string | undefined; text: string },
): Promise<InsertOutcome> {
	let module = "";
	let symbolIds: string[] = [];
	let held = new Set<string>();

	return journaledStep<InsertOutcome>(
		{ service, transactions, write },
		{
			kind: "insert",
			hold: "join",
			refuse: (reason, issues) => ({ inserted: false, issues, reason }),
			succeed: (issues) => ({ inserted: true, module, symbolIds, issues }),
			plan: async () => {
				const plan = await service.planInsert(args);
				if (plan.state === "refused") return { refused: plan.reason };
				if (plan.state === "present") {
					// The retry answer: success-shaped, so a timeout-and-retry cannot duplicate.
					return {
						done: {
							inserted: false,
							alreadyInserted: true,
							module: plan.module,
							symbolIds: [],
							issues: [],
						},
					};
				}
				module = plan.module;

				return {
					planned: {
						modules: [plan.module],
						// Created modules must stay absent until their write.
						writes: [
							{ module: plan.module, base: plan.created ? null : plan.baseHash, text: plan.candidate },
						],
						planRecord: { created: plan.created },
						stale: () => {
							// The sibling set and the collision check were read from these rows.
							const moved = service.factsMoved(plan.facts);
							return moved.length > 0 ? factsMovedWhilePlanned(moved, "insert") : null;
						},
						begin: () => {
							held = new Set(service.declarationsIn(plan.module).map((d) => d.symbolId));
						},
						reindex: [plan.module],
						issues: plan.issues,
						finish: () => {
							symbolIds = service
								.declarationsIn(plan.module)
								.map((declaration) => declaration.symbolId)
								.filter((symbolId) => !held.has(symbolId));
						},
					},
				};
			},
		},
	);
}

////////////////////////////////
//  Functions & Helpers

export function renameStepOutcome(result: StepResult): RenameStepOutcome {
	if (!result.done) return { renamed: false, issues: result.issues, reason: result.reason };
	return { renamed: true, modules: result.modules, ...defined({ migrated: result.migrated }), issues: result.issues };
}

export function moveOutcome(result: StepResult): MoveOutcome {
	if (!result.done) return { moved: false, issues: result.issues, reason: result.reason };
	return {
		moved: true,
		...defined({ toModule: result.toModule, migrated: result.migrated }),
		modules: result.modules,
		issues: result.issues,
	};
}

/** A committed step's answer, with the step that reverses it. */
export function committedOutcome(kind: "rename" | "move"): (result: StepResult) => CommittedStep {
	return (result) => {
		if (!result.done) {
			return {
				committed: false,
				reason: result.reason,
				issues: result.issues,
				...defined({ openRefactor: result.openRefactor, unexpected: result.unexpected }),
			};
		}
		return {
			committed: true,
			kind,
			symbolId: result.root,
			files: result.files,
			forwarded: result.forwarded,
			reverse: result.reverse,
			...defined({ migrated: result.migrated }),
			issues: result.issues,
		};
	};
}

/**
 * A committed step under the client's id: claimed before it plans, cancellable until its last check
 * in the gate, and its answer kept for a caller that lost it. A retry of an answered id gets that
 * answer again rather than a second run.
 */
export async function underClientStep(
	transactions: TransactionManager,
	stepId: string | undefined,
	kind: "rename" | "move",
	run: (cancelled?: () => Refusal | null) => Promise<CommittedStep>,
): Promise<CommittedStep> {
	if (stepId === undefined) return run();
	const claim = transactions.claimStep(stepId, kind);
	if (!claim.claimed) {
		if (claim.outcome.status === "answered") return claim.outcome.answer;
		return { committed: false, reason: stepIdTaken(stepId, claim.outcome.status), issues: [] };
	}
	let answer: CommittedStep;
	try {
		answer = await run(() => (transactions.proceedStep(stepId) ? null : stepCancelled(stepId)));
	} catch (error) {
		transactions.abandonStep(stepId);
		throw error;
	}
	transactions.answerStep(stepId, answer);
	return answer;
}

/** Written modules' bases are the executor's check. */
export function moveStale(
	service: LexiconService,
	plan: Extract<PlannedMove, { ok: true }>,
	context: ReadContext,
): Refusal | null {
	if (service.currentHashOf(plan.fromModule) !== plan.baseHash) {
		return changedWhilePlanned(plan.fromModule, "move");
	}
	// Import edits use stored ranges.
	const stale = service.staleModules(plan.referencing);
	if (stale.length > 0) return staleSincePlanned(stale, "move");
	// Equal hashes can hide reparses or upgrades.
	const movedFacts = service.factsMoved(context.seen());
	return movedFacts.length > 0 ? factsMovedWhilePlanned(movedFacts, "move") : null;
}
