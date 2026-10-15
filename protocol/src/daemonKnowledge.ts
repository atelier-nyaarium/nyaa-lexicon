import { z } from "zod";
import {
	StoredCommentSchema,
	StoredDeclarationSchema,
	StoredDocSchema,
	StoredExportSchema,
	StoredImportSchema,
	StoredLiteralSchema,
	StoredReferenceSchema,
} from "./daemonRows.js";

////////////////////////////////
//  Knowledge

/** Any one stored row, tagged by kind, as the store's `factById` answers it. */
export const StoredFactSchema = z
	.discriminatedUnion("fact", [
		StoredDeclarationSchema.extend({ fact: z.literal("declaration") }),
		StoredReferenceSchema.extend({ fact: z.literal("reference") }),
		StoredImportSchema.safeExtend({ fact: z.literal("import") }),
		StoredExportSchema.safeExtend({ fact: z.literal("export") }),
		StoredLiteralSchema.extend({ fact: z.literal("literal") }),
		StoredCommentSchema.extend({ fact: z.literal("comment") }),
		StoredDocSchema.extend({ fact: z.literal("doc") }),
	])
	.meta({ id: "StoredFact" });

export type StoredFact = z.infer<typeof StoredFactSchema>;

/** Why an id names no declaration: a closed kind, the sentence, and what a reader might mean instead. */
const diagnosed = { reason: z.string(), candidates: z.array(z.string()) };

/** Only a vacated address forwards, so only `moved` carries where. */
export const SubjectDiagnosisSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.enum(["factIdAsSubject", "unminted", "stranded", "waiting", "unknown"]), ...diagnosed }),
		z.object({ kind: z.literal("moved"), ...diagnosed, forwardedTo: z.string() }),
	])
	.meta({ id: "SubjectDiagnosis" });

export type SubjectDiagnosis = z.infer<typeof SubjectDiagnosisSchema>;
