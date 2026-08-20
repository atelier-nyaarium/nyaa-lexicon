// One executor for a journaled write step, so the failure policy exists once.
//
// Four operations spelled this lifecycle separately, and drift shipped: only insert guarded a
// reindex failure, only insert journaled its outcome at begin, and no automatic undo repaired the
// index afterwards. An operation now DECLARES its parts; the policy cannot be re-implemented
// wrongly, and a fifth operation is one declaration.

import type { LexiconService } from "./service.js";
import type { RefactorIssue, StepKind, TransactionManager } from "./transactions.js";

////////////////////////////////
//  Interfaces & Types

/** Thrown by apply() to refuse with a caller-facing reason. Anything else is a write failure. */
export class StepRefusal extends Error {}

export interface PlannedStep {
	modules: string[];
	planRecord?: unknown;
	/** A step that knows its final text journals it at begin, closing the crash window between
	 * write and completion. */
	plannedText?: Array<{ module: string; text: string }>;
	/** Inside the gate, before journaling: null while the planned world still holds. */
	stale: () => string | null;
	/** Inside the gate, after stale passes, before journaling. Position is free: beginStep touches
	 * only the journal, which no capture reads. */
	begin?: () => void;
	/** Writes files. May own internal reindexing (rename does). */
	apply: () => Promise<void> | void;
	/** Reindexed after apply, in order: only what apply did not already reindex. */
	reindex: string[];
	issues: RefactorIssue[];
	/** Runs ONLY when every reindex succeeded: half-reindexed facts must never feed a verifier. */
	finish?: (issues: RefactorIssue[]) => void | Promise<void>;
}

export type PlanAnswer<Outcome> =
	| { refused: string; issues?: RefactorIssue[] }
	| { done: Outcome }
	| { planned: PlannedStep };

export interface StepDeps {
	service: LexiconService;
	transactions: TransactionManager;
	write: <T>(work: () => Promise<T> | T) => Promise<T>;
}

export interface StepShape<Outcome> {
	kind: StepKind;
	/** Read-side planning, after the transaction guard and the upgrade drain, outside the gate.
	 * Owns its refusal ordering; the executor reorders nothing. */
	plan: () => Promise<PlanAnswer<Outcome>>;
	/** Refusal strings pass through verbatim; the executor authors only the write-failure frame. */
	refuse: (reason: string, issues: RefactorIssue[]) => Outcome;
	succeed: (issues: RefactorIssue[]) => Outcome;
}

////////////////////////////////
//  Functions & Helpers

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function journaledStep<Outcome>(deps: StepDeps, shape: StepShape<Outcome>): Promise<Outcome> {
	const { service, transactions, write } = deps;
	if (!transactions.openTransaction()) {
		return shape.refuse("no refactor transaction is open; call refactor_start", []);
	}

	// Sites read from outline modules would be missed sites.
	await service.upgradeRemaining();
	const answer = await shape.plan();
	if ("refused" in answer) return shape.refuse(answer.refused, answer.issues ?? []);
	if ("done" in answer) return answer.done;
	const planned = answer.planned;

	return write(async () => {
		// The plan was made outside the gate; the world it described must still hold inside it.
		const stale = planned.stale();
		if (stale !== null) return shape.refuse(stale, []);
		planned.begin?.();

		const begun = transactions.beginStep(shape.kind, planned.modules, planned.planRecord, planned.plannedText);
		if (!begun.ok) return shape.refuse(begun.reason, []);

		try {
			await planned.apply();
		} catch (error) {
			// Journaled but not (fully) written: the step is removed, and the restored files are
			// reindexed, or disk and facts diverge exactly where a caller retries next.
			const undone = transactions.undo();
			for (const module of undone.modules ?? []) {
				await service.indexFile(module).catch(() => undefined);
			}
			let reason =
				error instanceof StepRefusal
					? error.message
					: `the ${shape.kind} could not be written: ${describeError(error)}`;
			// A file matching neither image cannot be safely restored; the step stays for a human
			// decision rather than being silently stranded.
			if (!undone.undone) {
				reason += `; the journaled step remains (${undone.reason ?? "it could not be undone"}), refactor_revert restores the tracked files`;
			}
			return shape.refuse(reason, []);
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

		if (fullyReindexed && planned.finish !== undefined) {
			try {
				await planned.finish(issues);
			} catch (error) {
				issues.push({
					kind: "FinishIncomplete",
					detail: `the ${shape.kind} was applied but its follow-up did not complete: ${describeError(error)}`,
				});
			}
		}

		transactions.recordIssues(begun.stepNo, issues);
		transactions.completeStep(begun.stepNo, "finalized");
		return shape.succeed(issues);
	});
}
