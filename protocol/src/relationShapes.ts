// Relation answers combine indexed evidence with statements from people, agents or models.

import { z } from "zod";
import { SymbolSummarySchema } from "./daemonShapes.js";
import { NoteAuthorSchema } from "./noteShapes.js";

////////////////////////////////
//  Constants

/** The longest `why` or doubt reason a relation keeps. */
export const RELATION_TEXT_MAX = 500;

/** A relation's strongest reason; `stated` when only a statement carries it. */
export const RELATION_KINDS = [
	"usedTogether",
	"changedTogether",
	"namedAlike",
	"imported",
	"sameFile",
	"stated",
] as const;

////////////////////////////////
//  Schemas

export const RelationKindSchema = z.enum(RELATION_KINDS).meta({ id: "RelationKind" });

export type RelationKind = z.infer<typeof RelationKindSchema>;

/** Each part is in [0, 1]; `cochange` is null when workspace history is unavailable. */
export const RelationPartsSchema = z
	.object({
		callers: z.number(),
		cochange: z.number().nullable(),
		words: z.number(),
		imports: z.number(),
		file: z.number(),
	})
	.meta({ id: "RelationParts" });

export type RelationParts = z.infer<typeof RelationPartsSchema>;

export const RelationEvidenceSchema = z
	.object({
		/** Callers using both. */
		holders: z.number().int().nonnegative(),
		/** Commits changing both modules; null without history. */
		commits: z.number().int().nonnegative().nullable(),
		/** Name and type words both share. */
		words: z.array(z.string()),
		/** Modules both modules import. */
		imports: z.number().int().nonnegative(),
		sameModule: z.boolean(),
	})
	.meta({ id: "RelationEvidence" });

export type RelationEvidence = z.infer<typeof RelationEvidenceSchema>;

export const RelationProvenanceSchema = z
	.enum(["computed", "person", "agent", "model"])
	.meta({ id: "RelationProvenance" });

export type RelationProvenance = z.infer<typeof RelationProvenanceSchema>;

/** Person statements are confirmed; agent and model statements are proposed. */
export const RelationStatusSchema = z.enum(["proposed", "confirmed", "doubted"]).meta({ id: "RelationStatus" });

export type RelationStatus = z.infer<typeof RelationStatusSchema>;

/**
 * `sourceChanged`: an end's source changed since the relation was stated or judged. `orphaned`: an
 * end's declaration is gone. `insufficientEvidence`: the score rests on one item of evidence.
 */
export const RelationHealthSchema = z
	.enum(["current", "sourceChanged", "orphaned", "insufficientEvidence"])
	.meta({ id: "RelationHealth" });

export type RelationHealth = z.infer<typeof RelationHealthSchema>;

export const StatedRelationSchema = z
	.object({
		provenance: RelationProvenanceSchema,
		status: RelationStatusSchema,
		revision: z.number().int().positive(),
		why: z.string().nullable(),
		author: NoteAuthorSchema.nullable(),
		at: z.number(),
		/** The person who confirmed or doubted it. */
		judgedBy: NoteAuthorSchema.nullable(),
		judgedAt: z.number().nullable(),
		/** Why it was doubted. */
		reason: z.string().nullable(),
	})
	.meta({ id: "StatedRelation" });

export type StatedRelation = z.infer<typeof StatedRelationSchema>;

/** Decayed counts of predictions this relation found that were accepted or rejected. */
export const RelationFeedbackCountsSchema = z
	.object({ accepted: z.number(), rejected: z.number() })
	.meta({ id: "RelationFeedbackCounts" });

export const RelationSchema = z
	.object({
		/** The other end's current address, or the last one an orphaned end held. */
		symbolId: z.string(),
		/** Absent when the other end is orphaned. */
		symbol: SymbolSummarySchema.optional(),
		/** In [0, 1], feedback applied. */
		score: z.number(),
		kind: RelationKindSchema,
		parts: RelationPartsSchema,
		evidence: RelationEvidenceSchema,
		health: RelationHealthSchema,
		stated: StatedRelationSchema.nullable(),
		feedback: RelationFeedbackCountsSchema.nullable(),
	})
	.meta({ id: "Relation" });

export type Relation = z.infer<typeof RelationSchema>;

/** `unavailable` names evidence that could not be read, which is not the same as none. */
export const RelationsSchema = z
	.object({
		symbolId: z.string(),
		relations: z.array(RelationSchema),
		/** Some kind held more than the limit. */
		truncated: z.boolean(),
		unavailable: z.array(z.enum(["history"])),
	})
	.meta({ id: "Relations" });

export type Relations = z.infer<typeof RelationsSchema>;

export const RelationBetweenSchema = z
	.object({ relation: RelationSchema.nullable(), reason: z.string().optional() })
	.meta({ id: "RelationBetween" });

export type RelationBetween = z.infer<typeof RelationBetweenSchema>;

/** An export another module does not use yet, and the related symbols it uses that found it. */
export const RelationCandidateSchema = z
	.object({
		export: SymbolSummarySchema,
		module: z.string(),
		score: z.number(),
		via: z.array(SymbolSummarySchema),
		/** When discovery found it; absent on a pair computed for the read. */
		at: z.number().optional(),
	})
	.meta({ id: "RelationCandidate" });

export type RelationCandidate = z.infer<typeof RelationCandidateSchema>;

export const RelationCandidatesSchema = z
	.object({ candidates: z.array(RelationCandidateSchema), unavailable: z.array(z.enum(["history"])) })
	.meta({ id: "RelationCandidates" });

export type RelationCandidates = z.infer<typeof RelationCandidatesSchema>;

/** A new export nothing relates to strongly yet, with symbols a model could judge it against. */
export const RelationGapSchema = z
	.object({ symbol: SymbolSummarySchema, candidates: z.array(SymbolSummarySchema), at: z.number() })
	.meta({ id: "RelationGap" });

export type RelationGap = z.infer<typeof RelationGapSchema>;

export const RelationGapsSchema = z
	.object({ gaps: z.array(RelationGapSchema), total: z.number().int().nonnegative() })
	.meta({ id: "RelationGaps" });

export type RelationGaps = z.infer<typeof RelationGapsSchema>;

/** `kept`: a person judged this pair, so an agent's or a model's write changes nothing. */
export const RelationOutcomeSchema = z
	.discriminatedUnion("outcome", [
		z.object({ outcome: z.literal("saved"), relation: RelationSchema.nullable() }),
		z.object({ outcome: z.literal("proposed"), relation: RelationSchema }),
		z.object({ outcome: z.literal("kept"), relation: RelationSchema }),
		z.object({
			outcome: z.literal("refused"),
			reason: z.string(),
			/** The relation as it stands, when the refusal is a revision mismatch. */
			current: RelationSchema.nullable().optional(),
		}),
	])
	.meta({ id: "RelationOutcome" });

export type RelationOutcome = z.infer<typeof RelationOutcomeSchema>;

export const RelationGapAnswerSchema = z
	.object({
		proposed: z.number().int().nonnegative(),
		kept: z.number().int().nonnegative(),
		refused: z.array(z.object({ symbolId: z.string(), reason: z.string() })),
	})
	.meta({ id: "RelationGapAnswer" });

export type RelationGapAnswer = z.infer<typeof RelationGapAnswerSchema>;

export const RelationFeedbackResultSchema = z
	.object({ recorded: z.number().int().nonnegative() })
	.meta({ id: "RelationFeedbackResult" });

////////////////////////////////
//  Requests

const Author = { author: NoteAuthorSchema.optional() };

/** Consumer intent scopes feedback so one consumer's judgment does not affect another's. */
const Intent = z
	.string()
	.regex(/^[a-z][A-Za-z]{0,31}$/)
	.meta({ id: "RelationIntent" });

const Text = z.string().trim().min(1).max(RELATION_TEXT_MAX);

export const RelationsOfRequestSchema = z
	.object({
		symbolId: z.string().min(1),
		/** Per kind; 20 when absent. */
		limit: z
			.number()
			.int()
			.positive()
			.max(100)
			.optional()
			.meta({ description: "Relations kept per kind, not in total; 20 when absent." }),
		kinds: z.array(RelationKindSchema).optional(),
		intent: Intent.optional(),
		/** Doubted relations are left out unless asked for. */
		withDoubted: z.boolean().optional(),
	})
	.meta({ id: "RelationsOfRequest" });

export const RelationsBetweenRequestSchema = z
	.object({ symbolId: z.string().min(1), otherId: z.string().min(1), intent: Intent.optional() })
	.meta({ id: "RelationsBetweenRequest" });

/** A module's discovered exports, or the modules an export would suit; exactly one of the two. */
export const RelationCandidatesRequestSchema = z
	.object({
		module: z.string().min(1).optional(),
		symbolId: z.string().min(1).optional(),
		limit: z.number().int().positive().max(50).optional(),
		intent: Intent.optional(),
	})
	.refine((request) => (request.module === undefined) !== (request.symbolId === undefined), {
		message: "name a module or a symbolId, not both",
	})
	.meta({ id: "RelationCandidatesRequest" });

export const RelationGapsRequestSchema = z
	.object({ limit: z.number().int().positive().max(20).optional() })
	.meta({ id: "RelationGapsRequest" });

/**
 * `state` says the two relate, with `why`; a person's is confirmed, an agent's proposed. `confirm`,
 * `doubt` and `remove` are a person's. `expectedRevision` 0 means no stated relation stands.
 */
export const WriteRelationRequestSchema = z
	.object({
		symbolId: z.string().min(1),
		otherId: z.string().min(1),
		action: z.enum(["state", "confirm", "doubt", "remove"]),
		why: Text.optional(),
		reason: Text.optional(),
		expectedRevision: z.number().int().nonnegative(),
		...Author,
	})
	.meta({ id: "WriteRelationRequest" });

/** A model's judgment of a gap: what relates, each with why; an empty list says nothing does. */
export const AnswerRelationGapRequestSchema = z
	.object({
		symbolId: z.string().min(1),
		related: z.array(z.object({ symbolId: z.string().min(1), why: Text })).max(20),
		...Author,
	})
	.meta({ id: "AnswerRelationGapRequest" });

export const RelationFeedbackRequestSchema = z
	.object({
		pairs: z
			.array(z.object({ symbolId: z.string().min(1), otherId: z.string().min(1) }))
			.min(1)
			.max(20),
		intent: Intent,
		outcome: z.enum(["accepted", "rejected"]),
	})
	.meta({ id: "RelationFeedbackRequest" });
