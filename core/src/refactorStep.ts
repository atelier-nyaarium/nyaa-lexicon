// One executor for a journaled write step, so the failure policy exists once.
//
// Plans carry whole texts and base hashes; the executor journals then writes.

import { type CommittedFile, defined, hashContent, type StepBase } from "@nyaa-lexicon/protocol";
import {
	changedWhilePlanned,
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
import type { RefactorIssue, StepKind, TransactionManager } from "./transactions.js";

////////////////////////////////
//  Interfaces & Types

/** Caller-facing refusal; other errors fail writes. */
export class StepRefusal extends Error {}

/** Recovery reverses these rebind rows. */
export interface StepRebind {
	entries: RebindEntry[];
	evidence: RebindEvidence;
}

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
	/** Null while planned facts still hold. */
	stale: () => Refusal | null;
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
//  Functions & Helpers

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

/** Plans, then writes under the gate; a status answer names the step while it runs. */
export async function journaledStep<Outcome>(deps: StepDeps, shape: StepShape<Outcome>): Promise<Outcome> {
	return deps.service.during({ kind: "refactor", label: shape.kind }, () => runStep(deps, shape));
}

async function runStep<Outcome>(deps: StepDeps, shape: StepShape<Outcome>): Promise<Outcome> {
	const { service, transactions, write } = deps;
	const early = policyRefusal(shape.hold, transactions.openTransaction());
	if (early !== null) return shape.refuse(early.reason, [], early.why);

	// Sites read from outline modules would be missed sites.
	await service.upgradeRemaining();
	const answer = await shape.plan();
	if ("refused" in answer) return shape.refuse(answer.refused, answer.issues ?? []);
	if ("done" in answer) return answer.done;
	const planned = answer.planned;

	return write(async () => {
		// Inside the gate, or another writer opens one in between.
		const open = transactions.openTransaction();
		const late = policyRefusal(shape.hold, open);
		if (late !== null) return shape.refuse(late.reason, [], late.why);
		const hold: StepHold = open === null ? "own" : "joined";

		const run = async (): Promise<Outcome> => {
			const refuse = (reason: Refusal, why?: RefusedWith): Outcome => {
				if (hold === "own") transactions.revert(transactions.status().drifted);
				return shape.refuse(reason, [], why);
			};

			// Validate the plan under the gate.
			const moved = movedBase(service, planned.writes);
			if (moved !== null) return refuse(changedWhilePlanned(moved, nounOf(shape.kind)));
			const stale = planned.stale();
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
				for (const module of undone.modules ?? []) {
					await service.indexFile(module).catch(() => undefined);
				}
				// A file matching neither image cannot be safely restored; the step stays for a human
				// decision rather than being silently stranded.
				const stranded = undone.undone ? null : (undone.reason ?? "it could not be undone");
				const failed = (left: string | null) =>
					error instanceof StepRefusal
						? stepRefused(error.message, left)
						: stepNotWritten(shape.kind, describeError(error), left);
				if (stranded === null) return refuse(failed(null));
				if (hold === "joined") return shape.refuse(failed(stranded), []);
				// Nobody else holds it: settle as recovery would.
				const settled = transactions.recover();
				for (const module of settled.restored) await service.indexFile(module).catch(() => undefined);
				return shape.refuse(stepAbandoned(failed(null), settled.conflicts), []);
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
			let fullyReindexed = true;
			for (const module of planned.reindex) {
				try {
					await service.indexFile(module);
				} catch (error) {
					// The write LANDED. Failing the call would lie, and an unfinalized step would have
					// the next recovery silently revert real text; the stale facts are said instead.
					fullyReindexed = false;
					issues.push({
						kind: "ReindexFailed",
						detail: `${module} was written but not reindexed (${describeError(error)}); its stored facts are stale until it indexes`,
						module,
					});
				}
			}
			transactions.completeStep(begun.stepNo, "reindexed");

			// The journal is the evidence, so the rebind follows the written files whatever the reindex
			// did: an address the index has not caught up with stays unresolved until it does.
			const rebound =
				rebind === undefined ? undefined : transactions.rebind(begun.stepNo, rebind.entries, rebind.evidence);

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
			for (const module of settled.restored) await service.indexFile(module).catch(() => undefined);
			// Committed, or left open by recovery: not a refusal.
			if (settled.closed !== "reverted") throw error;
			const failed = stepNotWritten(shape.kind, describeError(error), null);
			return shape.refuse(stepAbandoned(failed, settled.conflicts), []);
		}
	});
}
