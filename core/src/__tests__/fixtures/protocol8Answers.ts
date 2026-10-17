import {
	IndexDepthSchema,
	IndexStatusSchema,
	NoteLinkSchema,
	NoteRefProblemSchema,
	NoteSchema,
	ProvenanceSchema,
	RangeSchema,
	StoredDeclarationSchema,
	SymbolSummarySchema,
	UnknownReasonSchema,
} from "@nyaa-lexicon/protocol";
import { z } from "zod";

////////////////////////////////
//  Schemas

export const Protocol8NoteLinkSchema = NoteLinkSchema.extend({
	state: z.enum(["ok", "changed", "broken"]),
});

export const Protocol8NoteSchema = NoteSchema.extend({ links: z.array(Protocol8NoteLinkSchema) });

export const Protocol8NoteOutcomeSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("saved"), note: Protocol8NoteSchema.nullable() }),
	z.object({
		outcome: z.literal("refused"),
		reason: z.string(),
		refs: z.array(NoteRefProblemSchema).optional(),
		current: Protocol8NoteSchema.nullable().optional(),
	}),
]);

export const Protocol8ModuleStatusSchema = z
	.object({
		module: z.string(),
		exists: z.boolean(),
		claimed: z.boolean(),
		provider: z.string().optional(),
		unclaimedReason: z.string().optional(),
		indexed: z.boolean(),
		depth: IndexDepthSchema.optional(),
		failure: z.string().optional(),
	})
	.meta({ id: "Protocol8ModuleStatus" });

export const Protocol8TypeInfoSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("known"),
		display: z.string().min(1),
		symbolId: z.string().min(1).optional(),
		provenance: ProvenanceSchema,
	}),
	z.object({
		status: z.literal("inferred"),
		display: z.string().min(1),
		basis: z.string().min(1),
		symbolId: z.string().min(1).optional(),
	}),
	z.object({ status: z.literal("unknown"), reason: UnknownReasonSchema, detail: z.string().optional() }),
]);
export const Protocol8SymbolSummarySchema = SymbolSummarySchema.omit({ valueStatus: true });
export const Protocol8StoredDeclarationSchema = StoredDeclarationSchema.omit({ valueStatus: true });
export const Protocol8IndexStatusSchema = IndexStatusSchema.omit({ scopeNotes: true });

export const Protocol8SymbolSourceSchema = z.discriminatedUnion("found", [
	z.object({
		found: z.literal(true),
		module: z.string(),
		name: z.string(),
		kind: z.string(),
		range: RangeSchema,
		text: z.string(),
		contentHash: z.string(),
		spanHash: z.string().optional(),
	}),
	z.object({ found: z.literal(false), reason: z.string(), stale: z.boolean().optional() }),
]);

export const Protocol8RefactorBeforeImageSchema = z.union([
	z.object({ tracked: z.literal(false) }),
	z.object({ tracked: z.literal(true), existed: z.literal(false) }),
	z.object({
		tracked: z.literal(true),
		existed: z.literal(true),
		contentHash: z.string(),
		encoding: z.literal("text"),
		text: z.string(),
	}),
	z.object({
		tracked: z.literal(true),
		existed: z.literal(true),
		contentHash: z.string(),
		encoding: z.literal("base64"),
		bytes: z.string(),
	}),
	z.object({
		tracked: z.literal(true),
		existed: z.literal(true),
		contentHash: z.string(),
		encoding: z.enum(["text", "base64"]),
		omitted: z.literal(true),
	}),
]);

export const Protocol8RefactorSettledImageSchema = z.union([
	z.object({ held: z.literal(false) }),
	z.object({ held: z.literal(true), absent: z.literal(true) }),
	z.object({ held: z.literal(true), contentHash: z.string(), encoding: z.literal("text"), text: z.string() }),
	z.object({ held: z.literal(true), contentHash: z.string(), encoding: z.literal("base64"), bytes: z.string() }),
]);

export const Protocol8BindingSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("bound"), symbolId: z.string().min(1), provenance: ProvenanceSchema }),
	z.object({
		status: z.literal("ambiguous"),
		candidates: z.array(z.string().min(1)).min(2),
		provenance: ProvenanceSchema,
	}),
	z.object({ status: z.literal("unbound"), reason: UnknownReasonSchema, detail: z.string().optional() }),
]);

export const Protocol8ProviderReferenceSchema = z.object({ binding: Protocol8BindingSchema });
