// One executor for a journaled write step, so the failure policy exists once.
//
// Plans carry whole texts and base hashes; the executor journals then writes.

import { type CommittedFile, defined, hashContent, type StepBase } from "@nyaa-lexicon/protocol";
import { UNREAD } from "./indexer.js";
import {
	changedWhilePlanned,
	indexBusy,
	noTransactionOpen,
	type Refusal,
	refactorOpenForCommittedStep,
	stepAbandoned,
	stepNotWritten,
	stepRefused,
	writtenNotAsPlanned,
} from "./refusals.js";
import type { LexiconService } from "./service.js";
import type { RebindEntry, RebindEvidence, RebindResult } from "./subjects.js";
import type { Recovered, RefactorIssue, StepKind, TransactionManager } from "./transactions.js";

////////////////////////////////
//  Interfaces & Types

/** Caller-facing refusal; other errors fail writes. */
export class StepRefusal extends Error {}

/** Recovery reverses these rebind rows. */
export interface StepRebind {
	entries: RebindEntry[];
	evidence: RebindEvidence;
}

export type Stale = Refusal | { again: true } | null;

/** Whole text over its planned disk hash. */
export interface PlannedWrite {
	module: string;
	/** Null when absent. */
	base: string | null;
	text: string;
}

export interface PlannedStep {
	/** Includes all written modules. */
	modules: string[];
	/** Ordered writes require their disk bases. */
	writes: PlannedWrite[];
	/** Written as they are: no fix runs on them, and each is read back before the step is written. */
	exact?: boolean;
	planRecord?: unknown;
	/** Null while planned facts still hold; `again` when only the index outran them, so a new plan may hold. */
	stale: () => Stale | Promise<Stale>;
	/** Inside the gate, after stale passes, before journaling. Position is free: beginStep touches
	 * only the journal, which no capture reads. */
	begin?: () => void;
	/** Rebinds recorded before writes, applied after reindex. */
	rebind?: () => StepRebind;
	/** Reindexed after writes, in order. */
	reindex: string[];
	issues: RefactorIssue[];
	/** Runs ONLY when every reindex succeeded: half-reindexed facts must never feed a verifier. */
	finish?: (issues: RefactorIssue[], rebound: RebindResult | undefined) => void | Promise<void>;
}

export type PlanAnswer<Outcome> =
	| { refused: Refusal; issues?: RefactorIssue[] }
	| { done: Outcome }
	| { planned: PlannedStep };

export interface StepDeps {
	service: LexiconService;
	transactions: TransactionManager;
	write: <T>(work: () => Promise<T> | T) => Promise<T>;
}

/** Joined the open transaction, or opened and committed its own. */
export type StepHold = "joined" | "own";

/** join needs one open; joinOrOwn opens its own if none; own needs none open. */
export type StepPolicy = "join" | "joinOrOwn" | { own: StepBase[] };

/** What a refusal carries beyond its sentence. */
export interface RefusedWith {
	openRefactor?: { id: string };
	unexpected?: StepBase[];
}

export interface StepShape<Outcome> {
	kind: StepKind;
	hold: StepPolicy;
	/** Read-side planning, after the transaction guard and the upgrade drain, outside the gate.
	 * Owns its refusal ordering; the executor reorders nothing. */
	plan: () => Promise<PlanAnswer<Outcome>>;
	/** Refusal strings pass through verbatim; the executor authors only the write-failure frame. */
	refuse: (reason: Refusal, issues: RefactorIssue[], why?: RefusedWith) => Outcome;
	/** `files` are the written modules with their journaled hashes. */
	succeed: (issues: RefactorIssue[], hold: StepHold, files: CommittedFile[]) => Outcome;
	/** Inside the gate, after the plan checks: a refusal when the caller cancelled, else null and the step writes. */
	cancelled?: () => Refusal | null;
}

////////////////////////////////
//  Constants

/** Plans made again past an index that only outran the last, before refusing. */
const REPLANS = 2;

////////////////////////////////
//  Functions & Helpers

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Owes each module a parse, then parses it; one left unread is an issue and stays owed for the pump. */
export async function reindexOwed(service: LexiconService, modules: readonly string[]): Promise<RefactorIssue[]> {
	service.oweParses(modules);
	const issues: RefactorIssue[] = [];
	for (const module of modules) {
		const why = await service
			.indexFile(module)
			.then(
				(outcome) => (UNREAD.has(outcome.cause) ? (outcome.failure ?? outcome.reason ?? "unread") : null),
				describeError,
			);
		if (why === null) continue;
		issues.push({
			kind: "ReindexFailed",
			detail: `${module} was not reindexed (${why}); its stored facts are stale until it indexes`,
			module,
		});
	}
	service.payOwed();
	return issues;
}

/** Refusal noun. */
function nounOf(kind: StepKind): string {
	return kind === "replace" ? "replacement" : kind;
}

/** First module with a stale base. */
function movedBase(service: LexiconService, writes: readonly PlannedWrite[]): string | null {
	return writes.find((write) => service.currentHashOf(write.module) !== write.base)?.module ?? null;
}

/** Whether the policy refuses this transaction state. */
function policyRefusal(policy: StepPolicy, open: { id: string } | null): { reason: Refusal; why?: RefusedWith } | null {
	if (policy === "join") return open === null ? { reason: noTransactionOpen() } : null;
	if (policy === "joinOrOwn" || open === null) return null;
	return { reason: refactorOpenForCommittedStep(open.id), why: { openRefactor: { id: open.id } } };
}

/** Settles what a stopped daemon left half-applied. Caller-held. */
export async function recoverSteps(
	service: LexiconService,
	transactions: TransactionManager,
): Promise<Recovered & { unlanded: RefactorIssue[] }> {
	const outcome = transactions.recover();
	// Restoring puts back text the index does not describe, so the facts for those files are of
	// a version that no longer exists. Reindexed here rather than left to the warm scan, which
	// is opt-in and may never run.
	// Every recovered step's modules are owed, so the pump this starts pays the ones not restored.
	const unlanded = await reindexOwed(service, outcome.restored);
	return { ...outcome, unlanded };
}

/** Plans, then writes under the gate; a status answer names the step while it runs. */
export async function journaledStep<Outcome>(deps: StepDeps, shape: StepShape<Outcome>): Promise<Outcome> {
	return deps.service.during({ kind: "refactor", label: shape.kind }, () => runStep(deps, shape));
}

async function runStep<Outcome>(deps: StepDeps, shape: StepShape<Outcome>): Promise<Outcome> {
	const { service, transactions } = deps;
	const early = policyRefusal(shape.hold, transactions.openTransaction());
	if (early !== null) return shape.refuse(early.reason, [], early.why);

	for (let replans = 0; ; replans++) {
		// Sites read from outline modules would be missed sites.
		await service.upgradeRemaining();
		const answer = await shape.plan();
		if ("refused" in answer) return shape.refuse(answer.refused, answer.issues ?? []);
		if ("done" in answer) return answer.done;
		const attempt = await writeStep(deps, shape, answer.planned);
		if (!("again" in attempt)) return attempt.outcome;
		if (replans === REPLANS) return shape.refuse(indexBusy(nounOf(shape.kind)), []);
	}
}

/** One plan under the gate: checked, journaled, written and settled; `again` when only the index outran it. */
async function writeStep<Outcome>(
	deps: StepDeps,
	shape: StepShape<Outcome>,
	planned: PlannedStep,
): Promise<{ outcome: Outcome } | { again: true }> {
	const { service, transactions, write } = deps;
	let again = false as boolean;
	const outcome = await write(async () => {
		// Inside the gate, or another writer opens one in between.
		const open = transactions.openTransaction();
		const late = policyRefusal(shape.hold, open);
		if (late !== null) return shape.refuse(late.reason, [], late.why);
		const hold: StepHold = open === null ? "own" : "joined";

		const run = async (): Promise<Outcome> => {
			const refuse = (reason: Refusal, why?: RefusedWith, issues: RefactorIssue[] = []): Outcome => {
				if (hold === "own") transactions.revert(transactions.status().drifted);
				return shape.refuse(reason, issues, why);
			};

			// Validate the plan under the gate.
			const moved = movedBase(service, planned.writes);
			if (moved !== null) return refuse(changedWhilePlanned(moved, nounOf(shape.kind)));
			const stale = await planned.stale();
			if (stale !== null && typeof stale === "object") {
				again = true;
				return refuse(indexBusy(nounOf(shape.kind)));
			}
			if (stale !== null) return refuse(stale);
			const cancelled = shape.cancelled?.() ?? null;
			if (cancelled !== null) return refuse(cancelled);
			planned.begin?.();

			const rebind = planned.rebind?.();
			const record =
				rebind === undefined
					? planned.planRecord
					: { ...(planned.planRecord as Record<string, unknown> | undefined), rebind };
			const written = planned.writes.map((write) => write.module);
			const tracked = new Set(planned.modules.filter((module) => transactions.tracks(module)));
			const bases = typeof shape.hold === "object" ? { writes: written, bases: shape.hold.own } : undefined;
			// Journal after-hashes before writes.
			const begun = transactions.beginStep(shape.kind, planned.modules, record, planned.writes, bases);
			if (!begun.ok) return refuse(begun.reason, defined({ unexpected: begun.unexpected }));

			const landed = new Set<string>();
			// A write that threw may have left partial text, so undo judges it.
			let threw: string | null = null;
			try {
				for (const write of planned.writes) {
					threw = write.module;
					const wrote = service.writeModule(write.module, write.text, write.base);
					threw = null;
					if (wrote) {
						landed.add(write.module);
						continue;
					}
					throw new StepRefusal(changedWhilePlanned(write.module, nounOf(shape.kind)));
				}
				if (planned.exact === true) {
					const differs = planned.writes.find(
						(write) => service.currentHashOf(write.module) !== hashContent(write.text),
					);
					if (differs !== undefined) throw new StepRefusal(writtenNotAsPlanned(differs.module));
				}
			} catch (error) {
				// Release unwritten modules, or Revert erases later edits to them.
				for (const module of planned.modules) {
					if (landed.has(module) || module === threw) continue;
					transactions.releaseModule(begun.stepNo, module, !tracked.has(module));
				}
				// Journaled but not (fully) written: the step is removed, and the restored files are
				// reindexed, or disk and facts diverge exactly where a caller retries next.
				const undone = transactions.undo();
				const unlanded = await reindexOwed(service, undone.modules ?? []);
				// A file matching neither image cannot be safely restored; the step stays for a human
				// decision rather than being silently stranded.
				const stranded = undone.undone ? null : (undone.reason ?? "it could not be undone");
				const failed = (left: string | null) =>
					error instanceof StepRefusal
						? stepRefused(error.message, left)
						: stepNotWritten(shape.kind, describeError(error), left);
				if (stranded === null) return refuse(failed(null), undefined, unlanded);
				if (hold === "joined") return shape.refuse(failed(stranded), unlanded);
				// Nobody else holds it: settle as recovery would.
				const settled = transactions.recover();
				const unsettled = await reindexOwed(service, settled.restored);
				return shape.refuse(stepAbandoned(failed(null), settled.conflicts), [...unlanded, ...unsettled]);
			}

			// The workspace's fix runs inside the step, so its output is the step's own after-image.
			const fixed = planned.exact === true ? { ran: false, failed: null } : await service.fixWritten(written);
			const lost = fixed.ran ? written.filter((module) => !transactions.restampAfter(begun.stepNo, module)) : [];
			transactions.completeStep(begun.stepNo, "written");

			const issues = [...planned.issues];
			if (fixed.failed !== null) issues.push({ kind: "FixFailed", detail: `the fix command ${fixed.failed}` });
			for (const module of lost) {
				issues.push({ kind: "FixFailed", detail: `the fix command left ${module} no longer a file`, module });
			}
			// The write LANDED. Failing the call would lie, and an unfinalized step would have the next
			// recovery silently revert real text; the stale facts are said instead.
			const unlanded = await reindexOwed(service, planned.reindex);
			issues.push(...unlanded);
			const fullyReindexed = unlanded.length === 0;
			transactions.completeStep(begun.stepNo, "reindexed");

			// The journal is the evidence, so the rebind follows the written files whatever the reindex
			// did: an address the index has not caught up with stays unresolved until it does.
			let rebound: RebindResult | undefined;
			if (rebind !== undefined) {
				// Once every parse landed, an address the step did not declare is known, e.g. one the fix
				// command changed; its knowledge stays put.
				const undeclared = fullyReindexed
					? rebind.entries.filter((entry) => service.declarationOf(entry.to) === null)
					: [];
				const entries = rebind.entries.filter((entry) => !undeclared.includes(entry));
				rebound = transactions.rebind(begun.stepNo, entries, rebind.evidence);
				for (const { from, to } of undeclared) {
					issues.push({
						kind: "KnowledgeKept",
						detail: `${to} is not declared after the ${shape.kind}, so the knowledge at ${from} stays there`,
					});
				}
				for (const { from, to } of rebound.blocked) {
					issues.push({
						kind: "KnowledgeKept",
						detail: `${to} already holds knowledge, so the knowledge at ${from} stays there`,
					});
				}
			}

			if (fullyReindexed && planned.finish !== undefined) {
				try {
					await planned.finish(issues, rebound);
				} catch (error) {
					issues.push({
						kind: "FinishIncomplete",
						detail: `the ${shape.kind} was applied but its follow-up did not complete: ${describeError(error)}`,
					});
				}
			}

			transactions.recordIssues(begun.stepNo, issues);
			transactions.completeStep(begun.stepNo, "finalized");
			// Committing drops the journal.
			const files = transactions.stepFiles(begun.stepNo).filter((file) => written.includes(file.module));
			// Issues are reported, never left open.
			if (hold === "own") transactions.commit({ force: true });
			return shape.succeed(issues, hold, files);
		};

		if (hold === "joined") return run();
		const started = transactions.start("own");
		if (!started.started) return shape.refuse(started.reason ?? noTransactionOpen(), []);
		try {
			return await run();
		} catch (error) {
			// Recover only if we still hold the transaction we started.
			if (transactions.openTransaction()?.id !== started.id) throw error;
			const settled = transactions.recover();
			const unlanded = await reindexOwed(service, settled.restored);
			// Committed, or left open by recovery: not a refusal.
			if (settled.closed !== "reverted") throw error;
			const failed = stepNotWritten(shape.kind, describeError(error), null);
			return shape.refuse(stepAbandoned(failed, settled.conflicts), unlanded);
		}
	});
	return again ? { again: true } : { outcome };
}
