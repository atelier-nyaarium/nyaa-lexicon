import { z } from "zod";
import { CountedSchema } from "./daemonReading.js";
import { ModulePathSchema } from "./modulePath.js";
import { RangeSchema } from "./symbols.js";

////////////////////////////////
//  Schemas

export const GrepSourceSchema = z.enum(["source", "notes", "path"]).meta({ id: "GrepSource" });

export type GrepSource = z.infer<typeof GrepSourceSchema>;

export const GrepRequestSchema = z
	.object({
		text: z.string().min(1).max(2000).optional(),
		regex: z.string().min(1).max(2002).optional(),
		module: z.union([z.literal("."), ModulePathSchema]).optional(),
		limit: z.number().int().positive().max(200).optional(),
		sources: z.array(GrepSourceSchema).min(1).optional(),
	})
	.superRefine((query, context) => {
		if ((query.text === undefined) === (query.regex === undefined))
			context.addIssue({ code: "custom", message: "Set text or regex, not both." });
	})
	.meta({ id: "GrepRequest" });

export type GrepRequest = z.infer<typeof GrepRequestSchema>;

export const GrepSourceMatchSchema = z.object({
	kind: z.literal("source"),
	module: z.string(),
	range: RangeSchema,
	text: z.string(),
	symbolId: z.string().optional(),
	name: z.string().optional(),
});

export const GrepNoteMatchSchema = z.object({
	kind: z.literal("note"),
	module: z.string(),
	symbolId: z.string(),
	range: RangeSchema,
	text: z.string(),
	sourceChanged: z.boolean(),
});

export const GrepPathMatchSchema = z.object({ kind: z.literal("path"), module: z.string() });

export const GrepMatchSchema = z
	.discriminatedUnion("kind", [GrepSourceMatchSchema, GrepNoteMatchSchema, GrepPathMatchSchema])
	.meta({ id: "GrepMatch" });

export type GrepMatch = z.infer<typeof GrepMatchSchema>;

export const GrepResultSchema = z
	.object({
		matches: z.array(GrepMatchSchema),
		...CountedSchema.shape,
		coverage: z.object({
			sources: z.array(GrepSourceSchema),
			scannedFiles: z.number().int().nonnegative(),
			skippedFiles: z.number().int().nonnegative(),
			scannedNotes: z.number().int().nonnegative(),
		}),
	})
	.meta({ id: "GrepResult" });

export type GrepResult = z.infer<typeof GrepResultSchema>;
