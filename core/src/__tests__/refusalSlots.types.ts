// Every refusal slot, asserted at the type level: widening one back to `string` fails `tsc`.
//
// Read through each owner's declared signature rather than through the narrowing, so a slot that
// stops using it is caught. A text sweep cannot see this; the compiler already knows.

import type { ApplyOutcome } from "../applyEdits.js";
import type { InsertPlan, MoveEditsOutcome, RefactorPlanner, ReplacementPlan } from "../refactorPlanner.js";
import type { PlanAnswer, StepShape } from "../refactorStep.js";
import type { Refusal } from "../refusals.js";
import type { LexiconService } from "../service.js";
import type { SourceWorkspace } from "../sourceWorkspace.js";
import type { TransactionManager } from "../transactions.js";

////////////////////////////////
//  Interfaces & Types

type Assert<T extends true> = T;

/** True only for the brand itself: `string` fails, and so does `string | Refusal`. */
type IsRefusal<T> = [T] extends [Refusal] ? ([Refusal] extends [T] ? true : false) : false;

type Refused<T, K extends string = "reason"> = T extends Record<K, infer R> ? R : never;

type Awaited1<T> = T extends Promise<infer R> ? R : T;

////////////////////////////////
//  The source reader

type _source = Assert<IsRefusal<Refused<Extract<ReturnType<SourceWorkspace["symbolSource"]>, { found: false }>>>>;

////////////////////////////////
//  The planner

type _move = Assert<IsRefusal<Refused<Extract<ReturnType<RefactorPlanner["planMove"]>, { ok: false }>>>>;

type _replacement = Assert<IsRefusal<Refused<Extract<ReplacementPlan, { ok: false }>>>>;

type _insert = Assert<IsRefusal<Refused<Extract<InsertPlan, { state: "refused" }>>>>;

type _moveEdits = Assert<IsRefusal<Refused<Extract<MoveEditsOutcome, { ok: false }>>>>;

type _renameEdits = Assert<
	IsRefusal<Refused<Extract<Awaited1<ReturnType<RefactorPlanner["renameEdits"]>>, { ok: false }>>>
>;

type _blocker = Assert<IsRefusal<Awaited1<ReturnType<RefactorPlanner["prepareRename"]>>["blockers"][number]["detail"]>>;

////////////////////////////////
//  The service

type _rename = Assert<
	IsRefusal<Refused<Extract<Awaited1<ReturnType<LexiconService["renameSymbol"]>>, { renamed: false }>>>
>;

////////////////////////////////
//  The executor, the journal and the writer

type _planAnswer = Assert<IsRefusal<Refused<Extract<PlanAnswer<never>, { refused: unknown }>, "refused">>>;

type _refuse = Assert<IsRefusal<Parameters<StepShape<never>["refuse"]>[0]>>;

/** The journal's reasons are optional on the wire, so they are read by index rather than inferred. */
type Optional<T extends { reason?: unknown }> = NonNullable<T["reason"]>;

type _undo = Assert<IsRefusal<Optional<ReturnType<TransactionManager["undo"]>>>>;

type _commit = Assert<IsRefusal<Optional<ReturnType<TransactionManager["commit"]>>>>;

type _revert = Assert<IsRefusal<Optional<ReturnType<TransactionManager["revert"]>>>>;

type _start = Assert<IsRefusal<Optional<ReturnType<TransactionManager["start"]>>>>;

type _track = Assert<IsRefusal<Optional<ReturnType<TransactionManager["track"]>>>>;

type _write = Assert<IsRefusal<Refused<Extract<ApplyOutcome, { applied: false }>>>>;
