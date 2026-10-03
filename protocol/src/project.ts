// The project model: which files are in scope, and how a specifier maps to one of them.
//
// The largest per-language cost in the whole contract. Everything else is a tree walk; this is
// tsconfig paths, exports maps, sys.path, csproj references, and project.godot autoloads.

import { z } from "zod";
import { ImportKindSchema } from "./move.js";
import { DeclarationSchema, DiagnosticSchema, RangeSchema, ReferenceSchema, VisibilitySchema } from "./symbols.js";
import { UnknownReasonSchema } from "./values.js";

////////////////////////////////
//  Schemas

/** `surface` limits exposed facts; `outline` limits extraction to declarations and imports. */
export const IndexDepthSchema = z.enum(["full", "surface", "outline"]).meta({ id: "IndexDepth" });

export type IndexDepth = z.infer<typeof IndexDepthSchema>;

/**
 * Where a specifier lands: a module, a scope inside declarations, or a package spanning files.
 *
 * A scope is named by its id, never by a member list: core unions the files' `scopeContributions`
 * and stamps the result.
 */
export const LandingSchema = z
	.discriminatedUnion("kind", [
		/** Workspace-relative, matching the symbol id grammar's module field. */
		z.object({ kind: z.literal("module"), module: z.string().min(1) }),
		/** e.g. a Rust enum a glob opens, a C# static class, a partial type. */
		z.object({
			kind: z.literal("symbolScope"),
			/** The answering provider's id; core refuses another. */
			providerId: z.string().min(1),
			scopeId: z.string().min(1),
			/** The declaration that opens it, for display. */
			anchorSymbolId: z.string().min(1).optional(),
		}),
		/** e.g. Kotlin `p.*`, C# `using N;`. */
		z.object({ kind: z.literal("packageScope"), providerId: z.string().min(1), scopeId: z.string().min(1) }),
	])
	.meta({ id: "Landing" });

export type Landing = z.infer<typeof LandingSchema>;

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
			landing: LandingSchema,
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

/** Namespaces a name binds in, as opaque atoms such as `value`, `type`, `macro` or `tag`. */
export const MeaningSchema = z.array(z.string().min(1)).min(1).meta({ id: "Meaning" });

export type Meaning = z.infer<typeof MeaningSchema>;

export const CertaintySchema = z
	.discriminatedUnion("status", [
		z.object({ status: z.literal("known") }),
		z.object({ status: z.literal("unknown"), reason: UnknownReasonSchema }),
	])
	.meta({ id: "Certainty" });

export type Certainty = z.infer<typeof CertaintySchema>;

/** How a name one edge brings resolves against another binding of it. */
export const ConflictSchema = z
	.object({
		/** Higher wins among transfers bringing one name. */
		priority: z.number().int(),
		/** Between transfers of equal priority. */
		amongTransfers: z.enum(["exclude", "earlierWins", "laterWins"]),
		againstLocal: z.enum(["localWins", "transferWins", "sourceOrder"]),
	})
	.meta({ id: "Conflict" });

export type Conflict = z.infer<typeof ConflictSchema>;

/** `*` matches any run, `?` one character, `[...]` a class, `[!...]` its complement. */
const GLOB = { glob: z.string().min(1), caseInsensitive: z.boolean() };

/** Which names a wildcard, an injection or a star brings. Core expands it with no language test. */
export const SelectorSchema = z
	.discriminatedUnion("kind", [
		/** Every name the target exports but `default`. */
		z.object({ kind: z.literal("allButDefault") }),
		/** The target's static `allList`, else the names its `fallback` matches. Dynamic: unknown. */
		z.object({ kind: z.literal("allList") }),
		/**
		 * Every member of the landing: a module's exports, or a scope's admitted members. A language
		 * that restricts further reports `names`.
		 */
		z.object({ kind: z.literal("visible") }),
		/** Empty is proved to select nothing. */
		z.object({ kind: z.literal("names"), names: z.array(z.string().min(1)) }),
		z.object({ kind: z.literal("pattern"), ...GLOB }),
	])
	.meta({ id: "Selector" });

export type Selector = z.infer<typeof SelectorSchema>;

const NAMING_KINDS: readonly string[] = ["default", "namespace", "require"];

const SELECTING_KINDS: readonly string[] = ["wildcard", "injection"];

/**
 * One transfer an import makes, and where it is written.
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
 * parses and no longer works. A wildcard, an injection and a side-effect import write neither.
 */
export const ImportEdgeSchema = z
	.object({
		kind: ImportKindSchema,
		/**
		 * The edge as written: `x as y`, `*`, a default or namespace clause, an injection or
		 * side-effect statement. Export targets and reference origins name an edge by it.
		 */
		span: RangeSchema,
		/** The name as the source module spells it. Absent when the import names no export. */
		name: z.string().min(1).optional(),
		range: RangeSchema.optional(),
		/** The binding written in THIS file. Absent when the import writes no local name. */
		local: z.string().min(1).optional(),
		localRange: RangeSchema.optional(),
		/** Python `from .m import N` binds N here; TypeScript `export { N } from` does not. */
		bindsLocally: z.boolean(),
		/** Erased at runtime, e.g. TypeScript's `import type`, in any form. */
		typeOnly: z.boolean().optional(),
		selector: SelectorSchema.optional(),
		conflict: ConflictSchema.optional(),
		meaning: MeaningSchema.optional(),
		/** The edge's own reach, e.g. C#'s `global using`. */
		visibility: VisibilitySchema.optional(),
		certainty: CertaintySchema,
		/** Source order, shared with this file's exports. */
		order: z.number().int().nonnegative(),
	})
	.refine((edge) => edge.kind !== "named" || edge.name !== undefined, {
		message: "a named edge names its source",
	})
	.refine((edge) => !NAMING_KINDS.includes(edge.kind) || edge.local !== undefined, {
		message: "a default, namespace or require edge writes a local binding",
	})
	.refine((edge) => !SELECTING_KINDS.includes(edge.kind) || edge.selector !== undefined, {
		message: "a wildcard or injection edge carries a selector",
	})
	.refine((edge) => !SELECTING_KINDS.includes(edge.kind) || (edge.name === undefined && edge.local === undefined), {
		message: "a wildcard or injection edge writes no name",
	})
	.refine(
		(edge) =>
			edge.kind !== "sideEffect" || (!edge.bindsLocally && edge.name === undefined && edge.local === undefined),
		{ message: "a side-effect edge binds nothing" },
	)
	.refine((edge) => !edge.bindsLocally || edge.conflict !== undefined, {
		message: "a binding edge states its conflict policy",
	})
	.refine((entry) => entry.name === undefined || entry.range !== undefined, {
		message: "a source name without its range cannot be rewritten, which is the point of carrying it",
	})
	.refine((entry) => entry.local === undefined || entry.localRange !== undefined, {
		message: "a local binding without its range cannot be rewritten",
	})
	.meta({ id: "ImportEdge" });

export type ImportEdge = z.infer<typeof ImportEdgeSchema>;

/** One import as written, before resolution. Whether it re-exports is an export fact's to say. */
export const ImportSchema = z
	.object({ specifier: z.string().min(1), edges: z.array(ImportEdgeSchema).min(1) })
	.meta({ id: "Import" });

export type Import = z.infer<typeof ImportSchema>;

export const ExportFormSchema = z
	.enum([
		/** Exported where declared, e.g. `export function N`, or a Python module-level binding. */
		"direct",
		/** A local binding exported by name, e.g. `export { x as y }`. */
		"local",
		/** A name an import edge brings, e.g. `export { x } from "./m"`, or Python `from .m import x`. */
		"forward",
		/** Every name an import edge brings, e.g. `export * from "./m"`, or Python `from .m import *`. */
		"star",
		/** A module namespace under one name, e.g. `export * as ns from "./m"`. Never its members. */
		"namespace",
		/** e.g. `export default N`. */
		"default",
		/** The module's whole value, e.g. `export = N`. */
		"assignment",
	])
	.meta({ id: "ExportForm" });

export type ExportForm = z.infer<typeof ExportFormSchema>;

export const ExportTargetSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("symbol"), symbolId: z.string().min(1) }),
		/** The import edge with exactly this span in this module. */
		z.object({ kind: z.literal("import"), span: RangeSchema }),
		/** e.g. `export default 42`, which is NotIndexed. */
		z.object({ kind: z.literal("unknown"), reason: UnknownReasonSchema }),
	])
	.meta({ id: "ExportTarget" });

export type ExportTarget = z.infer<typeof ExportTargetSchema>;

const UNNAMED_FORMS: readonly string[] = ["star", "assignment"];

const FORWARDING_FORMS: readonly string[] = ["forward", "star", "namespace"];

/** One export edge: a name this module, or a scope in it, exposes. The authority on exposure. */
export const ExportSchema = z
	.object({
		form: ExportFormSchema,
		/** The edge as written. */
		span: RangeSchema,
		/** `default` for a default export. */
		name: z.string().min(1).optional(),
		/** The exported name's token, when written. */
		range: RangeSchema.optional(),
		/** The local or source name's token, when written apart from the exported one. */
		sourceRange: RangeSchema.optional(),
		target: ExportTargetSchema,
		/** The scope it exports from. Absent: the module. */
		scopeId: z.string().min(1).optional(),
		/** A star's further filter. Absent: every name its target edge brings. */
		selector: SelectorSchema.optional(),
		conflict: ConflictSchema,
		meaning: MeaningSchema.optional(),
		visibility: VisibilitySchema.optional(),
		certainty: CertaintySchema,
		/** Source order, shared with this file's imports. */
		order: z.number().int().nonnegative(),
	})
	.refine((edge) => UNNAMED_FORMS.includes(edge.form) === (edge.name === undefined), {
		message: "only a star and an assignment export no name",
	})
	.refine((edge) => edge.form !== "default" || edge.name === "default", {
		message: "a default export is named `default`",
	})
	.refine((edge) => !FORWARDING_FORMS.includes(edge.form) || edge.target.kind === "import", {
		message: "a forward, star or namespace export targets an import edge",
	})
	.refine((edge) => edge.selector === undefined || edge.form === "star", {
		message: "only a star export carries a selector",
	})
	.meta({ id: "Export" });

export type Export = z.infer<typeof ExportSchema>;

/** Which names a star import of this module brings, e.g. Python's `__all__`. */
export const AllListSchema = z
	.discriminatedUnion("state", [
		/** A star brings the exported names `fallback` matches, e.g. `[!_]*`. */
		z.object({ state: z.literal("absent"), fallback: z.object(GLOB) }),
		z.object({
			state: z.literal("static"),
			entries: z.array(z.object({ name: z.string().min(1), range: RangeSchema, target: ExportTargetSchema })),
		}),
		/** Built or changed at runtime, e.g. `__all__ += [...]`. */
		z.object({ state: z.literal("dynamic"), reason: UnknownReasonSchema }),
	])
	.meta({ id: "AllList" });

export type AllList = z.infer<typeof AllListSchema>;

/** Members one file adds to a scope spanning declarations or files. */
export const ScopeContributionSchema = z
	.object({
		kind: z.enum(["symbolScope", "packageScope"]),
		scopeId: z.string().min(1),
		/** Direct members visible outside this file. */
		members: z.array(z.string().min(1)),
	})
	.meta({ id: "ScopeContribution" });

export type ScopeContribution = z.infer<typeof ScopeContributionSchema>;

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
		/**
		 * Decoded. Numbers arrive as their numeric value under `number`, not here.
		 *
		 * Decoded means the same across languages, never the source's spelling: a boolean is `true`
		 * or `false` whatever the file says, so Python's `True` and YAML's `TRUE` both arrive
		 * lowercase. Otherwise a caller searching for a value has to know which language wrote it,
		 * and gets a short answer rather than an empty one.
		 */
		value: z.string(),
		/** Present for numeric literals, so a range query is arithmetic rather than string compare. */
		number: z.number().optional(),
		range: RangeSchema,
		/** The declaration this literal sits inside, when one does. */
		containerId: z.string().min(1).optional(),
	})
	.meta({ id: "Literal" });

export type Literal = z.infer<typeof LiteralSchema>;

/** Spans only. Attachment is position math, owned by core so no two providers can drift. */
export const CommentSpanSchema = z
	.object({
		range: RangeSchema,
		/** Verbatim, markers included. Empty is not a comment. */
		text: z.string().min(1),
		/** A code token precedes it on its first line. Absent reads as true. */
		codeBefore: z.boolean().optional(),
		/** A code token follows it on its last line; comments are not code. Absent reads as true. */
		codeAfter: z.boolean().optional(),
	})
	.meta({ id: "CommentSpan" });

export type CommentSpan = z.infer<typeof CommentSpanSchema>;

/**
 * One contiguous stretch of a document's prose.
 *
 * Per REGION rather than per section, because a section is normally prose, then a fence, then more
 * prose. One flag for the whole section would call that prose fenced or lose the fence.
 */
export const DocRegionSchema = z
	.object({
		/** Covers the text and nothing else, so a range always slices its own content back out. */
		range: RangeSchema,
		/** Verbatim, fence delimiter lines excluded. Empty is not a region. */
		text: z.string().min(1),
		/** Optional visible text used for document search. */
		plain: z.string().optional(),
		/**
		 * The symbolId of the heading this sits under, never its name: two headings share a name.
		 *
		 * Absent before the first heading, and in a file with none, which anchors the region to the
		 * module exactly as a module-level comment does.
		 */
		anchorId: z.string().min(1).optional(),
		/** True when this came from a fenced code block, so a match can say where it was found. */
		fenced: z.boolean(),
	})
	.meta({ id: "DocRegion" });

export type DocRegion = z.infer<typeof DocRegionSchema>;

export const ProjectModelSchema = z
	.object({
		/** Workspace-relative paths this provider claims. Order is not significant. */
		files: z.array(z.string().min(1)),
		/** Roots outside the workspace whose symbols resolve as `external`. */
		externalRoots: z.array(z.string().min(1)),
		/** Config files consulted, so a stale model can be invalidated when one changes. */
		configFiles: z.array(z.string().min(1)),
		diagnostics: z.array(DiagnosticSchema),
		/**
		 * What reading a file depends on beyond its text, such as the preprocessor symbols a project
		 * defines. When it changes, every module the provider owns is parsed again.
		 */
		fingerprint: z.string().min(1).optional(),
	})
	.meta({ id: "ProjectModel" });

export type ProjectModel = z.infer<typeof ProjectModelSchema>;

/** Everything one parse yields. One call, so a provider parses once and holds no cache. */
export const EntryHowSchema = z
	.enum([
		/** Runtime-invoked function. */
		"main",
		/** Run-as-program guarded code. */
		"guardedMain",
		/** Statements run during load. */
		"topLevel",
	])
	.meta({ id: "EntryHow" });

export type EntryHow = z.infer<typeof EntryHowSchema>;

const MAIN_ENTRY_ROLE = { how: z.literal("main"), symbolId: z.string().min(1) };
const GUARDED_MAIN_ENTRY_ROLE = { how: z.literal("guardedMain") };
const TOP_LEVEL_ENTRY_ROLE = { how: z.literal("topLevel") };

export const EntryRoleSchema = z
	.discriminatedUnion("how", [
		z.object(MAIN_ENTRY_ROLE),
		z.object(GUARDED_MAIN_ENTRY_ROLE),
		z.object(TOP_LEVEL_ENTRY_ROLE),
	])
	.meta({ id: "EntryRole" });

export type EntryRole = z.infer<typeof EntryRoleSchema>;

/**
 * Source-local entry classification; libraries may still run initializers or decorators on load.
 */
export const FileRoleSchema = z
	.union([
		z.object({ kind: z.literal("library") }),
		z.discriminatedUnion("how", [
			z.object({ kind: z.literal("entry"), ...MAIN_ENTRY_ROLE }),
			z.object({ kind: z.literal("entry"), ...GUARDED_MAIN_ENTRY_ROLE }),
			z.object({ kind: z.literal("entry"), ...TOP_LEVEL_ENTRY_ROLE }),
		]),
		/** Entry candidate the provider cannot classify. */
		z.object({ kind: z.literal("unknown"), reason: UnknownReasonSchema }),
	])
	.meta({ id: "FileRole" });

export type FileRole = z.infer<typeof FileRoleSchema>;

export const FileFactsSchema = z
	.object({
		module: z.string().min(1),
		/** Content hash the facts were derived from, so a stale result is detectable. */
		contentHash: z.string().min(1),
		declarations: z.array(DeclarationSchema),
		references: z.array(ReferenceSchema),
		imports: z.array(ImportSchema),
		/** Absent reads as the `exports` tier being false: unknown coverage, not no exports. */
		exports: z.array(ExportSchema).optional(),
		/** Absent when the language has no star-export list. */
		allList: AllListSchema.optional(),
		scopeContributions: z.array(ScopeContributionSchema).optional(),
		/** Empty is honest only when the provider declares the tier false, like every other list here. */
		literals: z.array(LiteralSchema),
		/** Absent reads as the `comments` tier being false. */
		comments: z.array(CommentSpanSchema).optional(),
		/** Lines untouched by any token, including comment and literal tokens; a final line break adds no empty line. */
		blankLines: z.array(z.number().int().nonnegative()).optional(),
		/** Absent reads as the `docs` tier being false. */
		docs: z.array(DocRegionSchema).optional(),
		diagnostics: z.array(DiagnosticSchema),
		/** Extraction depth. Absent means full; outline means a full pass remains owed. */
		depth: IndexDepthSchema.optional(),
		/** Required by the `fileRoles` tier. */
		role: FileRoleSchema.optional(),
	})
	.meta({ id: "FileFacts" });

export type FileFacts = z.infer<typeof FileFactsSchema>;
