import { z } from "zod";
import { FACT_KINDS, parseFactId } from "./factId.js";
import { ExportSchema, ImportEdgeSchema, LandingSchema, LiteralSchema } from "./project.js";
import { ValueStatusSchema } from "./secrets.js";
import { DeclarationSchema, RangeSchema, ReferenceOriginSchema, ReferenceRoleSchema } from "./symbols.js";

////////////////////////////////
//  Vocabularies

/** Where a comment sits relative to the symbol it is about. */
export const CommentFormSchema = z.enum(["leading", "trailing", "inline", "standalone"]).meta({ id: "CommentForm" });

export type CommentForm = z.infer<typeof CommentFormSchema>;

export const FactKindSchema = z.enum(FACT_KINDS).meta({ id: "FactKind" });

/** Names one export edge, e.g. a rename stop. */
export const ExportFactIdSchema = z
	.string()
	.refine((id) => parseFactId(id)?.kind === "export", "not an export fact id")
	.meta({ id: "ExportFactId" });

export const ImportFactIdSchema = z
	.string()
	.refine((id) => parseFactId(id)?.kind === "import", "not an import fact id")
	.meta({ id: "ImportFactId" });
////////////////////////////////
//  Rows

export const StoredDeclarationSchema = DeclarationSchema.extend({
	/** Names this row, as find_literals and rename stops name theirs. */
	factId: z.string(),
	module: z.string(),
	valueStatus: ValueStatusSchema.optional(),
}).meta({ id: "StoredDeclaration" });

export type StoredDeclaration = z.infer<typeof StoredDeclarationSchema>;

export const StoredReferenceSchema = z
	.object({
		factId: z.string(),
		module: z.string(),
		name: z.string(),
		role: ReferenceRoleSchema,
		/** Null when the reference did not bind, which is a fact worth keeping. */
		targetId: z.string().nullable(),
		fromId: z.string().nullable(),
		/** Reached through a receiver or path; null when the provider did not say. */
		qualified: z.boolean().nullable(),
		/** Null when unproved, which is unknown. */
		origin: ReferenceOriginSchema.nullable(),
		/** A bound reference's provenance, or the reason an unbound one did not bind. */
		provenance: z.string(),
		startLine: z.number(),
		startCharacter: z.number(),
		endLine: z.number(),
		endCharacter: z.number(),
	})
	.meta({ id: "StoredReference" });

export type StoredReference = z.infer<typeof StoredReferenceSchema>;

/** One literal value written in one place. */
export const StoredLiteralSchema = z
	.object({
		factId: z.string(),
		module: z.string(),
		kind: LiteralSchema.shape.kind,
		value: z.string(),
		number: z.number().nullable(),
		containerId: z.string().nullable(),
		containerName: z.string().optional(),
		containerKind: z.string().optional(),
		range: RangeSchema,
	})
	.meta({ id: "StoredLiteral" });

export type StoredLiteral = z.infer<typeof StoredLiteralSchema>;

/** One comment as stored: what it says, where it says it, and what it says it about. */
export const StoredCommentSchema = z
	.object({
		factId: z.string(),
		module: z.string(),
		raw: z.string(),
		normalized: z.string(),
		form: CommentFormSchema,
		placement: z.string(),
		anchorId: z.string().nullable(),
		range: RangeSchema,
	})
	.meta({ id: "StoredComment" });

export type StoredComment = z.infer<typeof StoredCommentSchema>;

/** One stretch of a document's prose, with the heading it sits under. */
export const StoredDocSchema = z
	.object({
		factId: z.string(),
		module: z.string(),
		raw: z.string(),
		normalized: z.string(),
		fenced: z.boolean(),
		/** Null when the region sits under no heading. */
		anchorId: z.string().nullable(),
		range: RangeSchema,
	})
	.meta({ id: "StoredDoc" });

export type StoredDoc = z.infer<typeof StoredDocSchema>;

/** One import edge, with the spans a rewrite would replace. */
export const StoredImportSchema = ImportEdgeSchema.safeExtend({
	factId: z.string(),
	module: z.string(),
	specifier: z.string(),
	/** Null when the specifier did not resolve into the workspace. */
	landing: LandingSchema.nullable(),
}).meta({ id: "StoredImport" });

export type StoredImport = z.infer<typeof StoredImportSchema>;

/** One export edge. */
export const StoredExportSchema = ExportSchema.safeExtend({ factId: z.string(), module: z.string() }).meta({
	id: "StoredExport",
});

export type StoredExport = z.infer<typeof StoredExportSchema>;
