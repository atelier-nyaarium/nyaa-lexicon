import { z } from "zod";
import { PromotedSchema, RefactorIssueSchema } from "./daemonRefactor.js";
import { ModuleCycleSchema as LoadCycleResultSchema } from "./loadCycles.js";
import { ModulePathSchema } from "./modulePath.js";
import { MoveAnchorSchema } from "./move.js";
import { RangeSchema } from "./symbols.js";

export const StepKindSchema = z.enum(["replace", "rename", "move", "insert"]).meta({ id: "StepKind" });

export type StepKind = z.infer<typeof StepKindSchema>;

/** How far a step got. Each is committed BEFORE the work it names. */
export const StepPhaseSchema = z.enum(["journaled", "written", "reindexed", "finalized"]).meta({ id: "StepPhase" });

export type StepPhase = z.infer<typeof StepPhaseSchema>;

export const TransactionStepSchema = z
	.object({ stepNo: z.number(), kind: StepKindSchema, phase: StepPhaseSchema, modules: z.array(z.string()) })
	.meta({ id: "TransactionStep" });

export type TransactionStep = z.infer<typeof TransactionStepSchema>;

const Hash32 = z.string().regex(/^[0-9a-f]{32}$/);

/** IDs scope sequences. */
export const LedgerMarkSchema = z
	.object({ id: z.string(), latest: z.number().int().nonnegative() })
	.meta({ id: "LedgerMark" });

export type LedgerMark = z.infer<typeof LedgerMarkSchema>;

export const DriftedModuleSchema = z
	.object({
		module: ModulePathSchema,
		contentHash: Hash32.nullable(),
	})
	.meta({ id: "DriftedModule" });

export type DriftedModule = z.infer<typeof DriftedModuleSchema>;

export const TransactionStatusSchema = z
	.object({
		open: z.boolean(),
		id: z.string().optional(),
		startedAt: z.number().optional(),
		revision: z.number().int().nonnegative().optional(),
		steps: z.array(TransactionStepSchema),
		tracked: z.array(z.string()),
		drifted: z.array(DriftedModuleSchema),
		edited: z.array(z.string()),
		issues: z.array(RefactorIssueSchema),
		/** Optional across daemon versions. */
		ledger: LedgerMarkSchema.optional(),
	})
	.meta({ id: "TransactionStatus" });

export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export const RefactorStartResultSchema = z
	.object({ started: z.boolean(), id: z.string(), reason: z.string().optional() })
	.meta({ id: "RefactorStartResult" });

export type RefactorStartResult = z.infer<typeof RefactorStartResultSchema>;

export const RefactorTrackResultSchema = z
	.object({
		tracked: z.boolean(),
		/** Omitted by older daemons. */
		refactor: z.object({ id: z.string() }).nullable().optional(),
		/** Optional across daemon versions. */
		ledger: LedgerMarkSchema.optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "RefactorTrackResult" });

export type RefactorTrackResult = z.infer<typeof RefactorTrackResultSchema>;

export const SettledFileSchema = z
	.object({
		module: z.string(),
		/** Baseline restored by Revert. */
		opened: Hash32.nullable(),
		/** Baseline after Revert. */
		settled: Hash32.nullable(),
		/** Differing disk hash; null if absent or non-file. */
		drifted: z.object({ contentHash: Hash32.nullable() }).optional(),
	})
	.meta({ id: "SettledFile" });

export type SettledFile = z.infer<typeof SettledFileSchema>;

export const SettlementSchema = z
	.object({
		/** Increasing, never reused. */
		seq: z.number().int().positive(),
		id: z.string(),
		origin: z.enum(["explicit", "own"]),
		outcome: z.enum(["committed", "reverted"]),
		closedAt: z.number(),
		/** Sorted tracked modules. */
		files: z.array(SettledFileSchema),
	})
	.meta({ id: "Settlement" });

export type Settlement = z.infer<typeof SettlementSchema>;

export const RefactorSettlementsSchema = z
	.object({
		ledger: LedgerMarkSchema,
		/** Oldest retained, or null. */
		oldest: z.number().int().positive().nullable(),
		settlements: z.array(SettlementSchema),
	})
	.meta({ id: "RefactorSettlements" });

export type RefactorSettlements = z.infer<typeof RefactorSettlementsSchema>;

/** False: pruned or unknown. */
export const RefactorSettledImageSchema = z
	.union([
		z.object({ held: z.literal(false) }),
		z.object({ held: z.literal(true), absent: z.literal(true) }),
		z.object({ held: z.literal(true), contentHash: z.string(), encoding: z.literal("text"), text: z.string() }),
		z.object({ held: z.literal(true), contentHash: z.string(), encoding: z.literal("base64"), bytes: z.string() }),
	])
	.meta({ id: "RefactorSettledImage" });

export type RefactorSettledImage = z.infer<typeof RefactorSettledImageSchema>;

export const RefactorWriteFileResultSchema = z
	.discriminatedUnion("written", [
		z.object({
			written: z.literal(true),
			contentHash: Hash32.nullable(),
			/** Open refactor ID, nullable. */
			refactor: z.object({ id: z.string() }).nullable(),
			ledger: LedgerMarkSchema,
			/** False when indexing fails. */
			indexed: z.boolean(),
		}),
		z.object({
			written: z.literal(false),
			refused: z.enum(["changed", "outside", "directory", "notAFile", "tooLarge", "unencodable", "refactor"]),
			reason: z.string(),
			/** Current hash when changed. */
			contentHash: Hash32.nullable().optional(),
			/** Open refactor on refusal. */
			openRefactor: z.object({ id: z.string() }).nullable().optional(),
		}),
	])
	.meta({ id: "RefactorWriteFileResult" });

export type RefactorWriteFileResult = z.infer<typeof RefactorWriteFileResultSchema>;

export const RefactorNoteWriteResultSchema = z
	.object({ noted: z.boolean(), reason: z.string().optional() })
	.meta({ id: "RefactorNoteWriteResult" });

export type RefactorNoteWriteResult = z.infer<typeof RefactorNoteWriteResultSchema>;

/** A subject move a reversal left standing, and why it could not be put back. */
export const UnreversedRebindSchema = z
	.object({
		subjectId: z.string(),
		from: z.string(),
		to: z.string(),
		reason: z.enum(["gone", "movedOn", "fromHeld"]),
	})
	.meta({ id: "UnreversedRebind" });

export type UnreversedRebind = z.infer<typeof UnreversedRebindSchema>;

export const RefactorUndoResultSchema = z
	.object({
		undone: z.boolean(),
		stepNo: z.number().optional(),
		modules: z.array(z.string()).optional(),
		unreversed: z.array(UnreversedRebindSchema).optional(),
		/** Modules whose facts did not land again; each stays owed a parse. */
		issues: z.array(RefactorIssueSchema).optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "RefactorUndoResult" });

export type RefactorUndoResult = z.infer<typeof RefactorUndoResultSchema>;

export const RefactorRevertResultSchema = z
	.object({
		reverted: z.boolean(),
		modules: z.array(z.string()),
		unreversed: z.array(UnreversedRebindSchema).optional(),
		/** Modules whose facts did not land again; each stays owed a parse. */
		issues: z.array(RefactorIssueSchema).optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "RefactorRevertResult" });

export type RefactorRevertResult = z.infer<typeof RefactorRevertResultSchema>;

export const RefactorCommitResultSchema = z
	.object({ committed: z.boolean(), issues: z.array(RefactorIssueSchema), reason: z.string().optional() })
	.meta({ id: "RefactorCommitResult" });

export type RefactorCommitResult = z.infer<typeof RefactorCommitResultSchema>;

/** What a replacement did, or why it did nothing. Issues ride along either way. */
export const ReplaceOutcomeSchema = z
	.object({
		replaced: z.boolean(),
		module: z.string().optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "ReplaceOutcome" });

export type ReplaceOutcome = z.infer<typeof ReplaceOutcomeSchema>;

/** A span-guarded replacement. */
export const ReplaceSpanOutcomeSchema = ReplaceOutcomeSchema.extend({
	/** Span changed since read. Read again, never retry. */
	stale: z.boolean().optional(),
	/** On success: `own` committed its own transaction, `joined` wrote into the open one. */
	transaction: z.enum(["joined", "own"]).optional(),
}).meta({ id: "ReplaceSpanOutcome" });

export type ReplaceSpanOutcome = z.infer<typeof ReplaceSpanOutcomeSchema>;

export const MoveOutcomeSchema = z
	.discriminatedUnion("moved", [
		z.object({
			moved: z.literal(true),
			/** Canonical target spelling, on success. */
			toModule: z.string().optional(),
			modules: z.array(z.string()).optional(),
			issues: z.array(RefactorIssueSchema),
			reason: z.string().optional(),
			/** With `together`: the names that moved, one declaration per step, in order. */
			order: z.array(z.string()).optional(),
			promoted: z.array(PromotedSchema).optional(),
		}),
		z.object({
			moved: z.literal(false),
			toModule: z.string().optional(),
			modules: z.array(z.string()).optional(),
			issues: z.array(RefactorIssueSchema),
			reason: z.string().optional(),
			order: z.array(z.string()).optional(),
		}),
	])
	.meta({ id: "MoveOutcome" });

export type MoveOutcome = z.infer<typeof MoveOutcomeSchema>;

/** One file an arrangement writes, and the text it will write. */
export const ArrangeFileSchema = z
	.object({
		module: z.string(),
		/** The hash planned over; null when created. */
		base: Hash32.nullable(),
		created: z.boolean(),
		text: z.string(),
		/** The text's hash, which `refactorArrange` expects back. */
		result: Hash32,
	})
	.meta({ id: "ArrangeFile" });

export type ArrangeFile = z.infer<typeof ArrangeFileSchema>;

export const ArrangePreviewSchema = z
	.discriminatedUnion("ok", [
		z.object({
			ok: z.literal(true),
			files: z.array(ArrangeFileSchema),
			issues: z.array(RefactorIssueSchema),
			/** Every file went through `fixText` cleanly. */
			formatted: z.boolean(),
			/** Each top-level declaration's span in the target's final text; a placed one by its id before the move. */
			placed: z.array(
				z.union([
					z.object({ symbolId: z.string(), factId: z.undefined().optional(), range: RangeSchema }),
					z.object({ factId: z.string(), symbolId: z.undefined().optional(), range: RangeSchema }),
				]),
			),
			/** As on a move preview. */
			promoted: z.array(PromotedSchema).optional(),
			loadCycles: z.array(LoadCycleResultSchema).optional(),
		}),
		z.object({
			ok: z.literal(false),
			issues: z.array(RefactorIssueSchema),
			blockers: z.array(z.object({ module: z.string().optional(), reason: z.string() })),
			reason: z.string(),
		}),
	])
	.meta({ id: "ArrangePreview" });

export type ArrangePreview = z.infer<typeof ArrangePreviewSchema>;

/** What a rename did, with what it carried across and what it could not promise. */
export const RenameStepOutcomeSchema = z
	.object({
		renamed: z.boolean(),
		modules: z.array(z.string()).optional(),
		/** Export fact ids kept at the old name. */
		stops: z.array(z.string()).optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "RenameStepOutcome" });

export type RenameStepOutcome = z.infer<typeof RenameStepOutcomeSchema>;

/** A module as the caller last saw it; a null hash means absent. */
export const StepBaseSchema = z.object({ module: z.string(), contentHash: Hash32.nullable() }).meta({ id: "StepBase" });

export type StepBase = z.infer<typeof StepBaseSchema>;

/** Puts back a committed rename or move; ask the same committed method. */
export const ReverseStepSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("rename"), symbolId: z.string(), newName: z.string() }),
		z.object({
			kind: z.literal("move"),
			symbolId: z.string(),
			toModule: z.string(),
			anchor: MoveAnchorSchema.optional(),
		}),
	])
	.meta({ id: "ReverseStep" });

export type ReverseStep = z.infer<typeof ReverseStepSchema>;

/** A module the step wrote; a null hash means absent. */
export const CommittedFileSchema = z
	.object({ module: z.string(), before: Hash32.nullable(), after: Hash32.nullable() })
	.meta({ id: "CommittedFile" });

export type CommittedFile = z.infer<typeof CommittedFileSchema>;

/** A committed rename or move, or why nothing was written. */
export const CommittedStepSchema = z
	.discriminatedUnion("committed", [
		z.object({
			committed: z.literal(true),
			kind: z.enum(["rename", "move"]),
			/** The root's id now. */
			symbolId: z.string(),
			files: z.array(CommittedFileSchema),
			/** Every id the step re-minted, old to new. */
			forwarded: z.array(z.object({ from: z.string(), to: z.string() })),
			reverse: ReverseStepSchema,
			/** A rename's export fact ids kept at the old name. */
			stops: z.array(z.string()).optional(),
			issues: z.array(RefactorIssueSchema),
		}),
		z.object({
			committed: z.literal(false),
			reason: z.string(),
			issues: z.array(RefactorIssueSchema),
			/** Refused because this refactor is open. */
			openRefactor: z.object({ id: z.string() }).optional(),
			/** Modules `bases` missed, or that changed since, at their current hash. */
			unexpected: z.array(StepBaseSchema).optional(),
		}),
	])
	.meta({ id: "CommittedStep" });

export type CommittedStep = z.infer<typeof CommittedStepSchema>;

/** What became of a committed step a client named. */
export const StepOutcomeSchema = z
	.discriminatedUnion("status", [
		/** Never named here, or pruned. */
		z.object({ status: z.literal("unknown") }),
		/** Planning, and cancellable. */
		z.object({ status: z.literal("planning") }),
		/** Past its last check: it will answer. */
		z.object({ status: z.literal("writing") }),
		z.object({ status: z.literal("cancelled") }),
		/** The daemon stopped mid-step; `refactorSettlements` says whether its refactor committed. */
		z.object({ status: z.literal("interrupted") }),
		z.object({ status: z.literal("answered"), answer: CommittedStepSchema }),
	])
	.meta({ id: "StepOutcome" });

export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

export const StepCancelSchema = z
	.object({
		/** True only when the step was still planning, so it will never write. */
		cancelled: z.boolean(),
		outcome: StepOutcomeSchema,
	})
	.meta({ id: "StepCancel" });

export type StepCancel = z.infer<typeof StepCancelSchema>;

export const InsertOutcomeSchema = z
	.object({
		inserted: z.boolean(),
		/** The retry answer: the block already sits where it would go. */
		alreadyInserted: z.boolean().optional(),
		module: z.string().optional(),
		/** From the post-reindex store, never candidate facts: provider id assignment can differ. */
		symbolIds: z.array(z.string()).optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "InsertOutcome" });

export type InsertOutcome = z.infer<typeof InsertOutcomeSchema>;
