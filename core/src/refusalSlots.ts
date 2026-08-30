// The wire's shapes with their refusal slots narrowed, so core composes a Refusal where the
// protocol carries a string. A Refusal IS a string, so dispatch hands the wire type back unchanged.

import type {
	MovePlan,
	RefactorCommitResult,
	RefactorRevertResult,
	RefactorStartResult,
	RefactorTrackResult,
	RefactorUndoResult,
	RenameConcern,
	RenameEditPlan,
	RenamePlan,
	SymbolSource,
	TypeInfo,
} from "@nyaa-lexicon/protocol";
import type { Refusal } from "./refusals.js";

/** The wire's optional string reason, narrowed where core is the one composing it. */
type Refusing<T extends { reason?: string | undefined }> = Omit<T, "reason"> & { reason?: Refusal | undefined };

////////////////////////////////
//  Interfaces & Types

export type PlannedSource = Extract<SymbolSource, { found: true }> | { found: false; reason: Refusal; stale?: boolean };

export type PlannedMove = Extract<MovePlan, { ok: true }> | { ok: false; reason: Refusal };

/** Core's own answer for an id it holds no declaration for; a provider's unknown passes through. */
export type UnknownType = Extract<TypeInfo, { status: "unknown" }> & { detail: Refusal };

/** Refuses the rename; a warning keeps `RenameConcern`, since it rides a plan that still runs. */
export interface RenameBlocker extends Omit<RenameConcern, "detail"> {
	detail: Refusal;
}

export type PlannedRename = Omit<RenamePlan, "blockers"> & { blockers: RenameBlocker[] };

export type PlannedRenameEdits =
	| (Extract<RenameEditPlan, { ok: true }> & { plan: PlannedRename })
	| { ok: false; plan: PlannedRename; reason: Refusal };

/** The journal's own answers; every sentence in them is composed by core, never by a provider. */
export type StartedTransaction = Refusing<RefactorStartResult>;
export type TrackedFile = Refusing<RefactorTrackResult>;
export type UndoneStep = Refusing<RefactorUndoResult>;
export type RevertedTransaction = Refusing<RefactorRevertResult>;
export type CommittedTransaction = Refusing<RefactorCommitResult>;

/** A step the writer could not apply, named with the file it stopped on. */
export type WriteOutcome = { applied: true; modules: string[] } | { applied: false; reason: Refusal; module?: string };
