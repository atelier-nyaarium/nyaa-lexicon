// One executor for a journaled write step, so the failure policy exists once.
//
// One executor owns step ordering and failures.

import { type CommittedFile, defined, type StepBase } from "@nyaa-lexicon/protocol";
import {
	noTransactionOpen,
	type Refusal,
	refactorOpenForCommittedStep,
	stepAbandoned,
	stepNotWritten,
	stepRefused,
} from "./refusals.js";
import type { LexiconService } from "./service.js";
import type { RebindEntry, RebindEvidence, RebindResult } from "./subjects.js";
import type { RefactorIssue, StepKind, TransactionManager } from "./transactions.js";

////////////////////////////////
//  Interfaces & Types

/** Thrown by apply() to refuse with a caller-facing reason. Anything else is a write failure. */
export class StepRefusal extends Error {}

/** Recovery reverses these rebind rows. */
export interface StepRebind {
	entries: RebindEntry[];
	evidence: RebindEvidence;
}

export interface PlannedStep {
	modules: string[];
	/** What apply writes; `modules` may add ones only reindexed. */
	writes: string[];
	planRecord?: unknown;
	/** Recovery matches early writes by hash; completion records disk state. */
	plannedText?: Array<{ module: string; text: string }>;
	/** Inside the gate, before journaling: null while the planned world still holds. */
	stale: () => Refusal | null;
	/** Inside the gate, after stale passes, before journaling. Position is free: beginStep touches
	 * only the journal, which no capture reads. */
	begin?: () => void;
	/** Record rebinds before apply; apply after all reindexes. */
	rebind?: () => StepRebind;
	/** Writes files. May own internal reindexing (rename does). */
	apply: () => Promise<void> | void;
	/** Reindexed after apply, in order: only what apply did not already reindex. */
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
}

////////////////////////////////
//  Functions & Helpers

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether the policy refuses this transaction state. */
function policyRefusal(policy: StepPolicy, open: { id: string } | null): { reason: Refusal; why?: RefusedWith } | null {
	if (policy === "join") return open === null ? { reason: noTransactionOpen() } : null;
	if (policy === "joinOrOwn" || open === null) return null;
	return { reason: refactorOpenForCommittedStep(open.id), why: { openRefactor: { id: open.id } } };
}

export async function journaledStep<Outcome>(deps: StepDeps, shape: StepShape<Outcome>): Promise<Outcome> {
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

			// The plan was made outside the gate; the world it described must still hold inside it.
			const stale = planned.stale();
			if (stale !== null) return refuse(stale);
			planned.begin?.();

			const rebind = planned.rebind?.();
			const record =
				rebind === undefined
					? planned.planRecord
					: { ...(planned.planRecord as Record<string, unknown> | undefined), rebind };
			const bases =
				typeof shape.hold === "object" ? { writes: planned.writes, bases: shape.hold.own } : undefined;
			const begun = transactions.beginStep(shape.kind, planned.modules, record, planned.plannedText, bases);
			if (!begun.ok) return refuse(begun.reason, defined({ unexpected: begun.unexpected }));

			try {
				await planned.apply();
			} catch (error) {
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

			transactions.completeStep(begun.stepNo, "written");

			const issues = [...planned.issues];
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
			const files = transactions.stepFiles(begun.stepNo).filter((file) => planned.writes.includes(file.module));
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
