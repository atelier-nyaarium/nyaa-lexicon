// The project model: which files are in scope, and how a specifier maps to one of them.
//
// The largest per-language cost in the whole contract. Everything else is a tree walk; this is
// tsconfig paths, exports maps, sys.path, csproj references, and project.godot autoloads.

import { z } from "zod";
import { DeclarationSchema, DiagnosticSchema, RangeSchema, ReferenceSchema } from "./symbols.js";
import { UnknownReasonSchema } from "./values.js";

////////////////////////////////
//  Schemas

/** `surface` limits exposed facts; `outline` limits extraction to declarations and imports. */
export const IndexDepthSchema = z.enum(["full", "surface", "outline"]).meta({ id: "IndexDepth" });

export type IndexDepth = z.infer<typeof IndexDepthSchema>;

/**
 * Where an import specifier landed.
 *
 * `external` and `unresolved` are different answers on purpose: a dependency we chose not to index
 * is expected, while a specifier that resolves to nothing is a finding worth showing.
 */
export const ImportResolutionSchema = z
	.discriminatedUnion("status", [
		z.object({
			status: z.literal("resolved"),
			/** Workspace-relative, matching the symbol id grammar's module field. */
			module: z.string().min(1),
			/** Surface constrains generated or shipped code without changing resolution truth. */
			depth: IndexDepthSchema.optional(),
		}),
		z.object({
			status: z.literal("external"),
			/** Package name as the ecosystem spells it, e.g. "zod" or "System.Text.Json". */
			packageName: z.string().min(1),
			version: z.string().optional(),
			/** An indexable API entry point, never permission to walk package implementation. */
			surface: z.object({ module: z.string().min(1) }).optional(),
		}),
		z.object({
			status: z.literal("unresolved"),
			reason: UnknownReasonSchema,
			detail: z.string().optional(),
		}),
	])
	.meta({ id: "ImportResolution" });

export type ImportResolution = z.infer<typeof ImportResolutionSchema>;

/** One import as written, before resolution. */
/**
 * One name an import brings in, and where it is written.
 *
 * The position is what separates reading from rewriting. Without it an import is a statement that
 * some names crossed a module boundary, and a rename cannot reach the text that says so: measured
 * on this repo, a plan for `SCHEMA_VERSION` found 4 of its 6 occurrences because the re-export and
 * the import were invisible.
 *
 * `name` and `local` carry separate spans on purpose. Renaming the source symbol rewrites `name`
 * and must leave every use of the alias untouched, and one span cannot express that.
 *
 * BOTH are optional because plenty of real imports write only one of them. A namespace import, a
 * default import and a GDScript `const Foo = preload(...)` all write a local binding and name no
 * export at all. Requiring `name` made three providers reach for the local binding to fill it,
 * which would have had a rename of the source symbol rewrite a local alias: a rewrite that still
 * parses and no longer works. At least one of the two must be present, because an entry carrying
 * neither describes nothing.
 */
export const ImportedNameSchema = z
	.object({
		/** The name as the source module spells it. Absent when the import names no export. */
		name: z.string().min(1).optional(),
		range: RangeSchema.optional(),
		/** The binding written in THIS file. Absent when the import writes no local name. */
		local: z.string().min(1).optional(),
		localRange: RangeSchema.optional(),
	})
	.refine((entry) => entry.name !== undefined || entry.local !== undefined, {
		message: "an imported name must carry a source name, a local binding, or both",
	})
	.refine((entry) => entry.name === undefined || entry.range !== undefined, {
		message: "a source name without its range cannot be rewritten, which is the point of carrying it",
	})
	.refine((entry) => entry.local === undefined || entry.localRange !== undefined, {
		message: "a local binding without its range cannot be rewritten",
	})
	.meta({ id: "ImportedName" });

export type ImportedName = z.infer<typeof ImportedNameSchema>;

export const ImportSchema = z
	.object({
		specifier: z.string().min(1),
		/** Names taken from it, each with where it is written. Empty for a side-effect import. */
		imported: z.array(ImportedNameSchema),
		/** Whether this re-exports rather than consumes, which is what makes a barrel a barrel. */
		reExport: z.boolean(),
	})
	.meta({ id: "Import" });

export type Import = z.infer<typeof ImportSchema>;

/**
 * A literal value written in source, with where it is written.
 *
 * The tier that makes text searchable as FACTS rather than as bytes. A magic string shared by two
 * files is the strongest textual signal that they are related, and it is invisible to the symbol
 * index entirely: a name inside a string is not a reference, so `__all__ = ["add"]` and
 * `connect("thing_happened", ...)` are in no table anywhere.
 *
 * `value` is the DECODED value, not the source text: `"a\nb"` and `'a\nb'` are the same literal
 * written two ways, and a search that cannot see through the quoting is a search over syntax.
 */
export const LiteralSchema = z
	.object({
		kind: z.enum(["string", "number", "boolean"]),
		/** Decoded. Numbers arrive as their numeric value under `number`, not here. */
		value: z.string(),
		/** Present for numeric literals, so a range query is arithmetic rather than string compare. */
		number: z.number().optional(),
		range: RangeSchema,
		/** The declaration this literal sits inside, when one does. */
		containerId: z.string().min(1).optional(),
	})
	.meta({ id: "Literal" });

export type Literal = z.infer<typeof LiteralSchema>;

/** Spans only. Attachment is position math, owned by core so eight providers cannot drift. */
export const CommentSpanSchema = z
	.object({
		range: RangeSchema,
		/** Verbatim, markers included. Empty is not a comment. */
		text: z.string().min(1),
	})
	.meta({ id: "CommentSpan" });

export type CommentSpan = z.infer<typeof CommentSpanSchema>;

export const ProjectModelSchema = z
	.object({
		/** Workspace-relative paths this provider claims. Order is not significant. */
		files: z.array(z.string().min(1)),
		/** Roots outside the workspace whose symbols resolve as `external`. */
		externalRoots: z.array(z.string().min(1)),
		/** Config files consulted, so a stale model can be invalidated when one changes. */
		configFiles: z.array(z.string().min(1)),
		diagnostics: z.array(DiagnosticSchema),
	})
	.meta({ id: "ProjectModel" });

export type ProjectModel = z.infer<typeof ProjectModelSchema>;

/** Everything one parse yields. One call, so a provider parses once and holds no cache. */
export const FileFactsSchema = z
	.object({
		module: z.string().min(1),
		/** Content hash the facts were derived from, so a stale result is detectable. */
		contentHash: z.string().min(1),
		declarations: z.array(DeclarationSchema),
		references: z.array(ReferenceSchema),
		imports: z.array(ImportSchema),
		/** Empty is honest only when the provider declares the tier false, like every other list here. */
		literals: z.array(LiteralSchema),
		/** Absent reads as the `comments` tier being false. */
		comments: z.array(CommentSpanSchema).optional(),
		diagnostics: z.array(DiagnosticSchema),
		/** Extraction depth. Absent means full; outline means a full pass remains owed. */
		depth: IndexDepthSchema.optional(),
	})
	.meta({ id: "FileFacts" });

export type FileFacts = z.infer<typeof FileFactsSchema>;
