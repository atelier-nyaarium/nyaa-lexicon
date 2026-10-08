// Refactor steps as the daemon runs them: planned outside the write gate, journaled inside it.

import {
	type CommittedFile,
	type CommittedStep,
	defined,
	hashContent,
	type InsertOutcome,
	type MoveAnchor,
	type MoveOutcome,
	type Promoted,
	type RefactorIssue,
	type RenameStepOutcome,
	type ReplaceSpanOutcome,
	type ReverseStep,
	reverseOf,
} from "@nyaa-lexicon/protocol";
import type { ArrangePlacement, PlannedArrange } from "./arrangePlanner.js";
import { type MoveMember, moveOrder } from "./moveOrder.js";
import { promotedField } from "./movePromotion.js";
import { type ReadContext, UNREAD_FILE } from "./readContext.js";
import { journaledStep, type RefusedWith, type StepPolicy } from "./refactorStep.js";
import type { PlannedMove } from "./refusalSlots.js";
import {
	anchorNotTopLevel,
	arrangeNotAsPreviewed,
	bindingsHeld,
	changedWhilePlanned,
	factsMovedWhilePlanned,
	moveCycle,
	moveTogetherSplit,
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

/** The workspace gate as a handler sees it. */
export interface Gate {
	/** Pre-work a read awaits before its entry; a bounded read awaits it only within its budget. */
	ahead(work: Promise<unknown>): Promise<void>;
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
			/** A rename's export fact ids kept at the old name. */
			stops?: string[];
			issues: RefactorIssue[];
			promoted?: Promoted[];
	  }
	| ({ done: false; reason: Refusal; issues: RefactorIssue[] } & RefusedWith);

/** One file as a preview showed it: the hash it was planned over, and its text's hash. */
export interface PreviewedFile {
	module: string;
	base: string | null;
	result: string;
}

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
	args: { symbolId: string; toModule: string; anchor?: MoveAnchor | undefined; promote?: boolean | undefined },
	hold: StepPolicy,
	cancelled?: () => Refusal | null,
): Promise<StepResult> {
	let requested = args.symbolId;
	let touched: string[] = [];
	let source = "";
	let target = args.toModule;
	let restore: MoveAnchor | undefined;
	let promoted: Promoted[] = [];
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
					reverse: withRestore(
						reverseOf("move", requested, root) ?? { kind: "move", symbolId: root, toModule: source },
						restore,
					),
					issues,
					...promotedField(promoted),
				};
			},
			plan: async () => {
				// Held past the call, so the stale check below asks what it stamped.
				const context = service.newReadContext();
				const plan = service.planMove(args.symbolId, args.toModule, context, args.anchor, args.promote);
				if (!plan.ok) return { refused: plan.reason };
				requested = plan.symbolId;
				promoted = plan.promoted ?? [];
				source = plan.fromModule;
				target = plan.toModule;
				restore = plan.restore;
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
						finish: (issues) => {
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
	args: { symbolId: string; newName: string; stops?: readonly string[] | undefined },
	hold: StepPolicy,
	cancelled?: () => Refusal | null,
): Promise<StepResult> {
	let modules: string[] = [];
	let oldName = "";
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
					...defined({ stops: args.stops?.length ? [...args.stops] : undefined }),
					issues,
				};
			},
			plan: async () => {
				// One context, so the plan and the two follow-up reads below stamp and share one set.
				const context = service.newReadContext();
				const { edits, relied } = await service.planRenameEdits(
					args.symbolId,
					args.newName,
					context,
					args.stops,
				);
				if (!edits.ok) {
					return {
						refused: edits.reason,
						issues: edits.plan.blockers.map((blocker) => ({ kind: blocker.kind, detail: blocker.detail })),
					};
				}
				// Payable debt drained before planning; what a failure still holds back may bind as before a move.
				const held = service.heldDebts(
					context.seen().flatMap((entry) => ("module" in entry ? [entry.module] : [])),
					edits.plan.oldName,
				);
				if (held.length > 0) return { refused: bindingsHeld(held, "rename") };
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
						planRecord: { ...plan, stops: [...(args.stops ?? [])] },
						stale: async () => {
							// Every site was chosen from stored ranges; a changed module has moved
							// them, so rewriting would hit some occurrences and miss others.
							const stale = service.staleModules(edited);
							if (stale.length > 0) return staleSincePlanned(stale, "rename");
							// Rows re-committed under an equal hash: a re-parse or an upgrade.
							const moved = service.factsMoved(context.seen());
							// Only the pinned index moved: no module the plan read did, so a new plan may hold.
							const outrun = moved.length === 1 && moved[0] === UNREAD_FILE;
							if (moved.length > 0 && !outrun) return factsMovedWhilePlanned(moved, "rename");
							// A specifier may land elsewhere though no fact moved, e.g. after a config edit.
							const landed = (await service.landingsMoved(relied))[0]?.detail ?? null;
							return landed ?? (outrun ? { again: true } : null);
						},
						rebind: () => ({
							entries: [...idMap].map(([from, to]) => ({ from, to })),
							evidence: "journalRename",
						}),
						reindex: modules,
						issues: plan.warnings.map((warning) => ({ kind: warning.kind, detail: warning.detail })),
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

/** A move's reverse lands where the declaration left. */
function withRestore(reverse: ReverseStep, restore: MoveAnchor | undefined): ReverseStep {
	return reverse.kind === "move" && restore !== undefined ? { ...reverse, anchor: restore } : reverse;
}

/** The first module planned differently from its preview, else null. */
function previewDiffers(
	expect: readonly PreviewedFile[],
	files: ReadonlyArray<{ module: string; base: string | null; text: string }>,
): string | null {
	for (const file of files) {
		const seen = expect.find((each) => each.module === file.module);
		if (seen?.base !== file.base || seen.result !== hashContent(file.text)) return file.module;
	}
	return expect.find((each) => !files.some((file) => file.module === each.module))?.module ?? null;
}

export function renameStepOutcome(result: StepResult): RenameStepOutcome {
	if (!result.done) return { renamed: false, issues: result.issues, reason: result.reason };
	return {
		renamed: true,
		modules: result.modules,
		...defined({ stops: result.stops }),
		issues: result.issues,
	};
}

/**
 * Moves a set of declarations to one target: one arrangement step where the language arranges,
 * else one joined step each.
 *
 * Each moves after the unexported siblings it uses, since a move refuses to leave one behind. A
 * refused step stops the rest; the steps already taken stay, for the caller to keep or undo.
 */
export async function refactorMoveTogether(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: {
		symbolId: string;
		toModule: string;
		together: readonly string[];
		anchor?: MoveAnchor | undefined;
		promote?: boolean | undefined;
	},
): Promise<MoveOutcome> {
	const context = service.newReadContext();
	const members: MoveMember[] = [];
	let from: string | undefined;
	for (const symbolId of new Set([args.symbolId, ...args.together])) {
		const plan = service.planMove(symbolId, args.toModule, context, args.anchor, args.promote);
		if (!plan.ok) return { moved: false, issues: [], reason: plan.reason };
		from ??= plan.fromModule;
		if (plan.fromModule !== from) {
			return { moved: false, issues: [], reason: moveTogetherSplit(plan.name, plan.fromModule, from) };
		}
		const uses = plan.dependencies.flatMap((dependency) =>
			dependency.origin.kind === "sourceModule" && dependency.origin.exported === false
				? [dependency.origin.symbolId]
				: [],
		);
		members.push({ symbolId: plan.symbolId, name: plan.name, closure: plan.closure, uses });
	}
	const ordered = moveOrder(members);
	if ("cycle" in ordered) return { moved: false, issues: [], reason: moveCycle(ordered.cycle) };

	const anchored = args.anchor?.symbolId;
	const mover = members.find((member) => anchored !== undefined && member.closure.includes(anchored));
	if (mover !== undefined) return { moved: false, issues: [], reason: anchorNotTopLevel(mover.name, args.toModule) };

	// A language that arranges moves the set as one step: exports planned for the set, one format.
	const placements = ordered.order.map((member, index) => {
		const previous = ordered.order[index - 1];
		const anchor = previous === undefined ? args.anchor : { symbolId: previous.symbolId, side: "after" as const };
		return { symbolId: member.symbolId, ...defined({ anchor }) };
	});
	const arranged = await arrangeStep(service, transactions, write, {
		toModule: args.toModule,
		placements,
		promote: args.promote,
	});
	if (!arranged.unsupported) {
		const order = ordered.order.map((member) => member.name);
		return arranged.outcome.moved ? { ...arranged.outcome, order } : arranged.outcome;
	}

	const order: string[] = [];
	const modules = new Set<string>();
	const issues: RefactorIssue[] = [];
	const promoted: Promoted[] = [];
	let toModule: string | undefined;
	let anchor = args.anchor;
	for (const member of ordered.order) {
		let root: string | undefined;
		// A throw after earlier members landed must still name them.
		const step = await refactorMove(
			service,
			transactions,
			write,
			{ symbolId: member.symbolId, toModule: args.toModule, promote: args.promote, ...defined({ anchor }) },
			"join",
		).then(
			(result) => {
				if (result.done) root = result.root;
				return moveOutcome(result);
			},
			(error: unknown): MoveOutcome => ({
				moved: false,
				issues: [],
				reason: error instanceof Error ? error.message : String(error),
			}),
		);
		issues.push(...step.issues);
		if (!step.moved) {
			const moved = order.length === 0 ? "" : ` after ${order.join(", ")} moved`;
			return { moved: false, issues, order, reason: `${member.name} did not move${moved}: ${step.reason}` };
		}
		promoted.push(...(step.promoted ?? []));
		for (const module of step.modules ?? []) modules.add(module);
		toModule = step.toModule ?? toModule;
		order.push(member.name);
		// Each later member lands after the one before it, so their order holds.
		if (anchor?.side === "after" && root !== undefined) anchor = { symbolId: root, side: "after" };
	}
	return { moved: true, ...defined({ toModule }), modules: [...modules], issues, order, ...promotedField(promoted) };
}

/**
 * A previewed arrangement as one joined step, writing exactly the bytes the preview showed.
 *
 * Planned again from scratch and checked against the preview's hashes, so a file or a formatter
 * that moved since refuses rather than writing text nobody saw.
 */
export function refactorArrange(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: {
		toModule: string;
		placements: readonly ArrangePlacement[];
		expect: readonly PreviewedFile[];
		promote?: boolean | undefined;
	},
): Promise<MoveOutcome> {
	return arrangeStep(service, transactions, write, args).then(({ outcome }) => outcome);
}

/** `refactorArrange`, and whether the provider declined to arrange at all. Without `expect` it writes what it plans. */
async function arrangeStep(
	service: LexiconService,
	transactions: TransactionManager,
	write: <T>(work: () => Promise<T> | T) => Promise<T>,
	args: {
		toModule: string;
		placements: readonly ArrangePlacement[];
		expect?: readonly PreviewedFile[];
		promote?: boolean | undefined;
	},
): Promise<{ outcome: MoveOutcome; unsupported: boolean }> {
	let unsupported = false;
	let touched: string[] = [];
	let target = args.toModule;
	let promoted: Promoted[] = [];
	const idMap = new Map<string, string>();

	const outcome = await journaledStep<MoveOutcome>(
		{ service, transactions, write },
		{
			kind: "move",
			hold: "join",
			refuse: (reason, issues) => ({ moved: false, issues, reason }),
			succeed: (issues) => ({
				moved: true,
				toModule: target,
				modules: touched,
				issues,
				...promotedField(promoted),
			}),
			plan: async () => {
				const context = service.newReadContext();
				const plan = await service.planArrange(args.toModule, args.placements, context, args.promote);
				if (!plan.ok) return { refused: plan.reason };
				target = plan.toModule;
				promoted = plan.promoted;
				const arranged = await service.arrangedFiles(plan, context);
				if (!arranged.ok) {
					unsupported = arranged.unsupported === true;
					return { refused: arranged.reason, issues: arranged.issues };
				}
				const differs = args.expect === undefined ? null : previewDiffers(args.expect, arranged.files);
				if (differs !== null) return { refused: arrangeNotAsPreviewed(differs) };
				// Nothing to write, so no step.
				if (arranged.files.length === 0) {
					return {
						done: {
							moved: true,
							toModule: plan.toModule,
							modules: [],
							issues: arranged.issues,
							...promotedField(plan.promoted),
						},
					};
				}
				touched = arranged.files.map((file) => file.module);
				const incoming = plan.members.filter((member) => member.incoming);
				// Worked out before the write, since afterwards these ids resolve to nothing.
				const bound = service
					.modulesBoundTo(
						incoming.flatMap((member) => member.closure),
						context,
					)
					.filter((module) => !touched.includes(module));

				return {
					planned: {
						modules: [...touched, ...bound],
						writes: arranged.files.map((file) => ({
							module: file.module,
							base: file.base,
							text: file.text,
						})),
						exact: true,
						planRecord: {
							from: plan.fromModule,
							to: plan.toModule,
							arranged: plan.members.map((member) => member.symbolId),
						},
						stale: () => arrangeStale(service, plan, context),
						begin: () => {
							for (const member of incoming) {
								for (const id of member.closure) {
									const rebased = service.rebaseIntoModule(id, member.symbolId, plan.toModule);
									if (rebased !== null) idMap.set(id, rebased);
								}
							}
						},
						rebind: () => ({
							entries: [...idMap].map(([from, to]) => ({ from, to })),
							evidence: "journalMove",
						}),
						// Target first, so every other module rebinds against declarations already in their new home.
						reindex: [plan.toModule, ...touched.filter((module) => module !== plan.toModule), ...bound],
						issues: arranged.issues,
						finish: (issues) => {
							for (const member of plan.members)
								issues.push(...service.checkMoveLanded(member.name, touched));
							issues.push(...service.notLanded(plan));
						},
					},
				};
			},
		},
	);
	return { outcome, unsupported };
}

export function moveOutcome(result: StepResult): MoveOutcome {
	if (!result.done) return { moved: false, issues: result.issues, reason: result.reason };
	return {
		moved: true,
		...defined({ toModule: result.toModule }),
		modules: result.modules,
		issues: result.issues,
		...promotedField(result.promoted),
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
			...defined({ stops: result.stops }),
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

/** Every read module's base, the referencing modules' facts and the stamped rows, as planned. */
export function arrangeStale(
	service: LexiconService,
	plan: Extract<PlannedArrange, { ok: true }>,
	context: ReadContext,
): Refusal | null {
	for (const [module, base] of plan.bases) {
		if (service.currentHashOf(module) !== base) return changedWhilePlanned(module, "arrangement");
	}
	// Import edits use stored ranges.
	const stale = service.staleModules([...plan.referencing.keys()]);
	if (stale.length > 0) return staleSincePlanned(stale, "arrangement");
	const movedFacts = service.factsMoved(context.seen());
	return movedFacts.length > 0 ? factsMovedWhilePlanned(movedFacts, "arrangement") : null;
}
