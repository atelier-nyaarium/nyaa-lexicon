// The provider methods as request and response pairs.
//
// Every provider implements every method. A missing capability answers through the value types
// (Unknown with a reason), never by omitting a method, so the core cannot branch on language.

import { z } from "zod";
import { MoveEditsRequestSchema, MoveEditsResponseSchema } from "./move.js";
import { FileFactsSchema, ImportResolutionSchema, IndexDepthSchema, ProjectModelSchema } from "./project.js";
import { RenameEditsRequestSchema, RenameEditsResponseSchema } from "./rename.js";
import { RangeSchema, ReferenceRoleSchema } from "./symbols.js";
import { BindingSchema, TypeInfoSchema, UnknownReasonSchema } from "./values.js";

////////////////////////////////
//  Schemas

/**
 * What a provider says it can do. A planning HINT, never a gate.
 *
 * The core uses it to skip a bulk type pass a provider would answer NotImplemented to, and to
 * report coverage. Consulting it before a call would reintroduce the branching this design exists
 * to remove.
 */
export const ProviderTiersSchema = z
	.object({
		projectModel: z.boolean(),
		declarations: z.boolean(),
		references: z.boolean(),
		imports: z.boolean(),
		binding: z.boolean(),
		types: z.boolean(),
		/** String, number and boolean literals with their positions. */
		literals: z.boolean(),
		/** Raw comment spans. False hides the language from comment search entirely. */
		comments: z.boolean(),
		/** Prose regions, each optionally anchored to a heading. False for every language that is code. */
		docs: z.boolean(),
		/** Size and shape per declaration. */
		metrics: z.boolean(),
		/**
		 * Whether parseFile reports a syntax error as an error diagnostic.
		 *
		 * The one tier that is not about coverage: a provider parsing leniently returns no
		 * diagnostics for text that does not compile, so a caller validating candidate text before
		 * writing it would read silence as approval. Absent means unstated, which a validating
		 * caller must report as unchecked rather than as passing.
		 */
		syntaxDiagnostics: z.boolean().optional(),
	})
	.meta({ id: "ProviderTiers" });

export const InitializeRequestSchema = z
	.object({ workspaceRoot: z.string().min(1), protocolVersion: z.string().min(1) })
	.meta({ id: "InitializeRequest" });

export const InitializeResponseSchema = z
	.object({
		providerId: z.string().min(1),
		/** Slug used as the symbol id's language field. Must contain no whitespace. */
		language: z.string().min(1),
		extensions: z.array(z.string().min(1)),
		/** Exact filenames claimed regardless of extension, e.g. "project.godot". */
		filenames: z.array(z.string().min(1)).optional(),
		protocolVersion: z.string().min(1),
		tiers: ProviderTiersSchema,
		/**
		 * Which reference roles the provider actually extracts.
		 *
		 * `references: true` is a boolean over a nine-role vocabulary, so a provider emitting only
		 * calls had no way to say so and the flag read as a complete claim. Two of three did exactly
		 * that. Absent means the provider has not stated its coverage, which is different from
		 * claiming all of them.
		 */
		referenceRoles: z.array(ReferenceRoleSchema).optional(),
	})
	// Required the moment the tier is claimed, so the boolean can no longer be an unqualified claim
	// over a nine-role vocabulary. A provider that emits calls only must say `["call"]` and is then
	// reported as covering calls, rather than as covering references.
	.refine((response) => !response.tiers.references || (response.referenceRoles?.length ?? 0) > 0, {
		message: "a provider declaring the references tier must list the roles it actually extracts",
	})
	.meta({ id: "InitializeResponse" });

export type ProviderTiers = z.infer<typeof ProviderTiersSchema>;

export const DiscoverProjectRequestSchema = z.object({ workspaceRoot: z.string().min(1) }).meta({
	id: "DiscoverProjectRequest",
});

export const ParseFileRequestSchema = z
	.object({
		module: z.string().min(1),
		contentHash: z.string().min(1),
		/** Text is passed in so the provider never disagrees with the core about what is on disk. */
		text: z.string(),
		/** Absent means full for compatibility with providers predating surface indexing. */
		depth: IndexDepthSchema.optional(),
	})
	.meta({ id: "ParseFileRequest" });

export const ResolveImportRequestSchema = z
	.object({
		fromModule: z.string().min(1),
		specifier: z.string().min(1),
		/** Explicit bundle declarations can resolve runtime paths the language alone cannot. */
		surfaceGlobs: z.array(z.string().min(1)).optional(),
	})
	.meta({ id: "ResolveImportRequest" });

/** Identified by position rather than by id: the reference has no symbol until this call runs. */
export const BindRequestSchema = z
	.object({ module: z.string().min(1), range: RangeSchema, name: z.string().min(1) })
	.meta({ id: "BindRequest" });

/** Either an already-bound symbol or a position, since a caller may hold only one of them. */
export const TypeOfRequestSchema = z
	.union([z.object({ symbolId: z.string().min(1) }), z.object({ module: z.string().min(1), range: RangeSchema })])
	.meta({ id: "TypeOfRequest" });

/** A provider-level failure, distinct from an Unknown answer. The request could not be served. */
export const ProviderErrorSchema = z
	.object({ reason: UnknownReasonSchema, detail: z.string().min(1) })
	.meta({ id: "ProviderError" });

////////////////////////////////
//  Constants

/**
 * The wire names. A frozen list, so a typo is a compile error and the conformance suite can
 * enumerate what a provider must answer.
 */
export const PROVIDER_METHODS = [
	"initialize",
	"discoverProject",
	"parseFile",
	"resolveImport",
	"bind",
	"typeOf",
	"renameEdits",
	"moveEdits",
	"shutdown",
] as const;

export type ProviderMethod = (typeof PROVIDER_METHODS)[number];

/** Request and response schema per method, so a dispatcher validates both ends from one table. */
export const METHOD_SCHEMAS = {
	initialize: { request: InitializeRequestSchema, response: InitializeResponseSchema },
	discoverProject: { request: DiscoverProjectRequestSchema, response: ProjectModelSchema },
	parseFile: { request: ParseFileRequestSchema, response: FileFactsSchema },
	resolveImport: { request: ResolveImportRequestSchema, response: ImportResolutionSchema },
	bind: { request: BindRequestSchema, response: BindingSchema },
	typeOf: { request: TypeOfRequestSchema, response: TypeInfoSchema },
	renameEdits: { request: RenameEditsRequestSchema, response: RenameEditsResponseSchema },
	moveEdits: { request: MoveEditsRequestSchema, response: MoveEditsResponseSchema },
	shutdown: { request: z.object({}), response: z.object({}) },
} as const satisfies Record<ProviderMethod, { request: z.ZodType; response: z.ZodType }>;

////////////////////////////////
//  Functions & Helpers

export function isProviderMethod(name: string): name is ProviderMethod {
	return (PROVIDER_METHODS as readonly string[]).includes(name);
}
