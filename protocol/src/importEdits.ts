// Adding one import to a module's text, planned by the provider that owns the module.
//
// The caller names the binding it needs and the module declaring it; the provider owns the statement:
// its form, its specifier, where it goes, and whether it joins an import already there. A client that
// placed imports by scanning text would have to learn every language's prologue, directives and
// attributes, which is the knowledge this split keeps in the provider.

import { z } from "zod";
import { TextEditSchema } from "./edits.js";

////////////////////////////////
//  Schemas

export const ImportEditsRequestSchema = z
	.object({
		module: z.string().min(1),
		/** The text to plan against, which wins over disk. */
		text: z.string(),
		/** The name as `module` writes it. */
		name: z.string().min(1),
		/** The module declaring it. */
		fromModule: z.string().min(1),
	})
	.meta({ id: "ImportEditsRequest" });

export type ImportEditsRequest = z.infer<typeof ImportEditsRequestSchema>;

/** Why a provider will not plan the import. */
export const ImportRefusalSchema = z
	.enum([
		/** This provider does not plan imports, or not this form yet. */
		"NotImplemented",
		/** The text did not parse, so no position in it can be trusted. */
		"ParseError",
		/** `fromModule` does not export the name, so no import can bind it. */
		"NotExported",
		/** How `fromModule` exports the name could not be read. */
		"UnknownExport",
		/** No specifier can address `fromModule` from this module. */
		"NoImportPath",
		/** Several specifiers could address it and nothing chooses between them. */
		"AmbiguousImportPath",
		/** The module already binds the name to something else. */
		"TargetCollision",
	])
	.meta({ id: "ImportRefusal" });

export type ImportRefusal = z.infer<typeof ImportRefusalSchema>;

export const ImportEditsResponseSchema = z
	.discriminatedUnion("status", [
		/** Applied together, they bind the name; a join into an existing statement may take several. */
		z.object({ status: z.literal("planned"), edits: z.array(TextEditSchema).min(1) }),
		/** The module already binds the name to that export, so nothing is needed. */
		z.object({ status: z.literal("present") }),
		z.object({ status: z.literal("refused"), reason: ImportRefusalSchema, detail: z.string().optional() }),
	])
	.meta({ id: "ImportEditsResponse" });

export type ImportEditsResponse = z.infer<typeof ImportEditsResponseSchema>;
