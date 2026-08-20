// Declarations and references: what a provider extracts from one file.

import { z } from "zod";
import { BindingSchema } from "./values.js";

////////////////////////////////
//  Schemas

/**
 * Zero-based line, and `character` counted in UTF-16 CODE UNITS, matching LSP exactly.
 *
 * The unit is pinned here rather than left to each provider, because every plausible choice is
 * indistinguishable from the others until a file contains a character above U+FFFF. An emoji is one
 * UTF-16 code unit's worth of disagreement, and the failure it produces is a range that highlights
 * the wrong text rather than an error anybody notices.
 *
 * The three units a provider is likely to have on hand: a JavaScript string index is already UTF-16,
 * Python's `ast` column offsets are UTF-8 BYTES, and a codepoint count is neither. The last two must
 * be converted before they are reported.
 */
export const PositionSchema = z
	.object({ line: z.number().int().min(0), character: z.number().int().min(0) })
	.meta({ id: "Position" });

export const RangeSchema = z.object({ start: PositionSchema, end: PositionSchema }).meta({ id: "Range" });

export type Position = z.infer<typeof PositionSchema>;

export type Range = z.infer<typeof RangeSchema>;

/** LSP's closed set. Language flavour rides on `languageKind`, so providers never mint kinds. */
export const SymbolKindSchema = z
	.enum([
		"file",
		"module",
		"namespace",
		"package",
		"class",
		"method",
		"property",
		"field",
		"constructor",
		"enum",
		"interface",
		"function",
		"variable",
		"constant",
		"struct",
		"event",
		"operator",
		"typeParameter",
	])
	.meta({ id: "SymbolKind" });

export type SymbolKind = z.infer<typeof SymbolKindSchema>;

/**
 * Reach, not a keyword. `local` means function-scoped; `fileLocal` means module-private.
 *
 * A provider maps its language onto this rather than the core learning each language's spelling.
 */
export const VisibilitySchema = z
	.enum(["public", "protected", "private", "internal", "fileLocal", "local"])
	.meta({ id: "Visibility" });

/**
 * Size and shape of one declaration.
 *
 * Deliberately the cheap, uncontroversial four. Anything needing a control-flow graph belongs with
 * the analysis tiers, not here, and a metric a provider cannot compute is ABSENT rather than zero,
 * since zero branches and "not measured" are different facts.
 */
export const MetricsSchema = z
	.object({
		lines: z.number().int().nonnegative().optional(),
		parameters: z.number().int().nonnegative().optional(),
		/** Deepest nesting inside the body. */
		nesting: z.number().int().nonnegative().optional(),
		/** Decision points plus one, the classic cyclomatic count. */
		branches: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "Metrics" });

export type Metrics = z.infer<typeof MetricsSchema>;

export const DeclarationSchema = z
	.object({
		symbolId: z.string().min(1),
		kind: SymbolKindSchema,
		/** Free-form language flavour, e.g. "signal", "autoload". Display only. */
		languageKind: z.string().optional(),
		name: z.string().min(1),
		/** The whole declaration, comments and body included. */
		range: RangeSchema,
		/** Just the name, which is what an editor highlights on reveal. */
		selectionRange: RangeSchema,
		visibility: VisibilitySchema,
		/**
		 * Whether the symbol leaves its module. Separate from visibility because a TypeScript
		 * export and a public C# member differ, and the barrel case is not syntactic.
		 *
		 * OPTIONAL because a language can have no answer. GDScript's leading underscore is
		 * visibility, `@export` is Inspector exposure, and `class_name` is global registration; none
		 * of them is module export. A required boolean would force that provider to claim true or
		 * false when neither is supportable, which is the interface compelling a lie. Absent means
		 * the provider cannot say, and is different from false.
		 */
		exported: z.boolean().optional(),
		/** Rendered signature. The compression tier reads this instead of the body. */
		signature: z.string().optional(),
		/** Enclosing declaration, absent at module top level. */
		containerId: z.string().min(1).optional(),
		/** Absent when the provider does not measure, which is not the same as measuring zero. */
		metrics: MetricsSchema.optional(),
	})
	.meta({ id: "Declaration" });

export type Declaration = z.infer<typeof DeclarationSchema>;

/** How a reference uses its target, which is what separates a call graph from a mention list. */
export const ReferenceRoleSchema = z
	.enum(["call", "read", "write", "import", "export", "extends", "implements", "instantiate", "typeUse"])
	.meta({ id: "ReferenceRole" });

/**
 * A reference is a candidate plus a `Binding`, not a resolved edge.
 *
 * Extraction is syntactic and binding is semantic, so a provider may emit references it cannot
 * resolve. Folding the two would force it to choose between silence and a guess.
 */
export const ReferenceSchema = z
	.object({
		/** The identifier as written, kept so an unbound reference is still searchable. */
		name: z.string().min(1),
		range: RangeSchema,
		role: ReferenceRoleSchema,
		binding: BindingSchema,
		/** Enclosing declaration, so "who calls this" can answer with a symbol. */
		fromId: z.string().min(1).optional(),
	})
	.meta({ id: "Reference" });

export type Reference = z.infer<typeof ReferenceSchema>;

/** A parse or analysis problem, reported rather than thrown so one bad file cannot stop a scan. */
export const DiagnosticSchema = z
	.object({
		severity: z.enum(["error", "warning", "info"]),
		message: z.string().min(1),
		range: RangeSchema.optional(),
		path: z.string().optional(),
	})
	.meta({ id: "Diagnostic" });

export type Diagnostic = z.infer<typeof DiagnosticSchema>;
