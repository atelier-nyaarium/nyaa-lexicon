// Every shape a daemon answer is made of.
//
// The wire owns these; core's rows, plans and outcomes are `z.infer` of them, so what the store
// builds and what a client types cannot drift apart. Plain `z.object` throughout: an unnamed field
// is stripped on the way out, which is the contract that nothing leaves that the table does not name.

import { z } from "zod";
import { TextEditSchema } from "./edits.js";
import { FACT_KINDS, parseFactId } from "./factId.js";
import { LoadCycleHazardSchema } from "./loadCycles.js";
import { ImportKindSchema, MoveAnchorSchema, MoveDependencySchema } from "./move.js";
import { PaintFactsSchema } from "./paint.js";
import {
	EntryRoleSchema,
	ExportFormSchema,
	ExportSchema,
	FileRoleSchema,
	ImportEdgeSchema,
	IndexDepthSchema,
	LandingSchema,
	LiteralSchema,
} from "./project.js";
import { RenameSiteSchema } from "./rename.js";
import {
	DeclarationSchema,
	PositionSchema,
	RangeSchema,
	ReferenceOriginSchema,
	ReferenceRoleSchema,
	SymbolKindSchema,
	VisibilitySchema,
} from "./symbols.js";
import { UnknownReasonSchema } from "./values.js";

////////////////////////////////
//  Vocabularies

/** A source declaration the move exported in place. */
export const PromotedSchema = z.object({ symbolId: z.string(), name: z.string() }).meta({ id: "Promoted" });
export type Promoted = z.infer<typeof PromotedSchema>;

/** How a fact was obtained, carried on every answer so a consumer can weigh it. */
export const AnswerTierSchema = z.enum(["bound", "nameMatched", "unknown"]).meta({ id: "AnswerTier" });

export type AnswerTier = z.infer<typeof AnswerTierSchema>;

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
//  Counting

export const CountReasonSchema = z.enum(["pageCapped", "scanCapped", "pageAndScanCapped"]).meta({ id: "CountReason" });

export type CountReason = z.infer<typeof CountReasonSchema>;

/** Exact, or a floor with what stopped the count. */
export const CountSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("exact"), count: z.number() }),
		z.object({ kind: z.literal("atLeast"), count: z.number(), reason: CountReasonSchema }),
	])
	.meta({ id: "Count" });

export type Count = z.infer<typeof CountSchema>;

/** The wire fields of a paged answer, derived from its count. */
const counted = {
	count: CountSchema,
	total: z.number(),
	truncated: z.boolean(),
	scanIncomplete: z.boolean().optional(),
};

export const CountedSchema = z.object(counted).meta({ id: "Counted" });

export type Counted = z.infer<typeof CountedSchema>;

////////////////////////////////
//  Rows

export const StoredDeclarationSchema = DeclarationSchema.extend({
	/** Names this row, as find_literals and rename stops name theirs. */
	factId: z.string(),
	module: z.string(),
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

////////////////////////////////
//  Reading

export const SymbolSummarySchema = z
	.object({
		symbolId: z.string(),
		name: z.string(),
		kind: SymbolKindSchema,
		module: z.string(),
		/** Absent when the provider's language has no answer, which is not the same as false. */
		exported: z.boolean().optional(),
		visibility: VisibilitySchema,
		signature: z.string().optional(),
		docComment: z.string().optional(),
		/** Absent at the top level. */
		containerId: z.string().optional(),
		/** The declaration's 0-based lines, doc comment included; `name` is its name's line, when the source holds it. */
		lines: z.object({ start: z.number(), end: z.number(), name: z.number().optional() }).optional(),
		/** Uses bound to it, as `describe` counts; set on `outlineModule` rows. */
		referenceCount: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "SymbolSummary" });

export type SymbolSummary = z.infer<typeof SymbolSummarySchema>;

/** A note written about a symbol that is not its documentation: beside it, or inside its body. */
export const AttachedCommentSchema = z
	.object({ form: CommentFormSchema, placement: z.string(), line: z.number(), text: z.string() })
	.meta({ id: "AttachedComment" });

export type AttachedComment = z.infer<typeof AttachedCommentSchema>;

/** Fan-in and fan-out, bounded by what binding reached. */
export const GraphSummarySchema = z
	.object({
		symbolId: z.string(),
		fanOut: z.number(),
		fanIn: z.number(),
		/** How many members contributed, so a container's number is readable as one. */
		viaMembers: z.number().optional(),
		/** Distinct top-level declarations holding a use; a use at module level counts its file. */
		dependents: z.number().optional(),
	})
	.meta({ id: "GraphSummary" });

export type GraphSummary = z.infer<typeof GraphSummarySchema>;

/** Immediate supertypes and subtypes, read out of `extends` and `implements` reference rows. */
export const TypeHierarchySchema = z
	.object({
		symbolId: z.string(),
		supertypes: z.array(SymbolSummarySchema),
		subtypes: z.array(SymbolSummarySchema),
		/** Supertypes reached transitively, nearest first, bounded and cycle-guarded. */
		ancestors: z.array(SymbolSummarySchema),
		/** Unresolved heritage names, so an engine base class is visibly absent rather than missing. */
		unboundSupertypes: z.array(z.string()),
	})
	.meta({ id: "TypeHierarchy" });

export type TypeHierarchy = z.infer<typeof TypeHierarchySchema>;

/**
 * A symbol's part in a load-order cycle's hazard: `bad` lists the hazards it reads in or is the
 * target of; `pending` means its component's judgment was not ready within describe's short wait.
 */
export const DescribeLoadCycleSchema = z
	.discriminatedUnion("verdict", [
		z.object({
			verdict: z.literal("bad"),
			modules: z.array(z.string()),
			hazards: z.array(LoadCycleHazardSchema).min(1),
		}),
		z.object({ verdict: z.literal("pending"), modules: z.array(z.string()) }),
	])
	.meta({ id: "DescribeLoadCycle" });

export type DescribeLoadCycle = z.infer<typeof DescribeLoadCycleSchema>;

export const DescribeResultSchema = z
	.object({
		symbol: SymbolSummarySchema,
		/** Direct members, the compression tier: a class as its surface rather than its body. */
		members: z.array(SymbolSummarySchema),
		/** Absent when nothing but its own documentation was written about it. */
		comments: z.array(AttachedCommentSchema).optional(),
		/** How many notes the cap left out. */
		moreComments: z.number().optional(),
		/** A heading's own prose, which is what a document has instead of a body. Absent for code. */
		prose: z.array(z.object({ line: z.number(), fenced: z.boolean(), text: z.string() })).optional(),
		moreProse: z.number().optional(),
		referenceCount: z.number(),
		graph: GraphSummarySchema,
		hierarchy: TypeHierarchySchema,
		/** Provider-reported file role. */
		moduleRole: FileRoleSchema.optional(),
		/** Present only when the symbol reads in, or is the target of, a hazard, or the judgment is pending. */
		loadCycle: DescribeLoadCycleSchema.optional(),
		tier: AnswerTierSchema,
	})
	.meta({ id: "DescribeResult" });

export type DescribeResult = z.infer<typeof DescribeResultSchema>;

/** A reference as a list shows it. Both additions are read-time, so neither touches the row's fact id. */
export const ReferenceUseSchema = StoredReferenceSchema.extend({
	/** The outermost declaration holding the use. Absent at module level. */
	topLevel: SymbolSummarySchema.optional(),
	/** The language of the file the use is written in, when the index can tell. */
	language: z.string().optional(),
}).meta({ id: "ReferenceUse" });

export type ReferenceUse = z.infer<typeof ReferenceUseSchema>;

export const ReferencesResultSchema = z
	.object({
		symbolId: z.string(),
		/** Capped, because an agent pays for every row and a hub symbol has thousands. */
		references: z.array(ReferenceUseSchema),
		total: z.number(),
		truncated: z.boolean(),
		tier: AnswerTierSchema,
	})
	.meta({ id: "ReferencesResult" });

export type ReferencesResult = z.infer<typeof ReferencesResultSchema>;

export const UseFromSchema = ReferenceUseSchema.extend({
	/** Absent when the reference did not bind, or its target left the index. */
	target: SymbolSummarySchema.optional(),
	/** Read from the stored row: an ambiguous binding keeps a provenance and no target. */
	status: z.enum(["bound", "ambiguous", "unbound"]),
	/** Why an unbound use did not bind. */
	reason: UnknownReasonSchema.optional(),
}).meta({ id: "UseFrom" });

export type UseFrom = z.infer<typeof UseFromSchema>;

/** What a symbol and everything declared inside it reference, bound or not. */
export const UsesFromResultSchema = z
	.object({
		symbolId: z.string(),
		/** In source order. */
		references: z.array(UseFromSchema),
		total: z.number(),
		truncated: z.boolean(),
		tier: AnswerTierSchema,
	})
	.meta({ id: "UsesFromResult" });

export type UsesFromResult = z.infer<typeof UsesFromResultSchema>;

export const ScopeSymbolSchema = z
	.object({
		symbol: SymbolSummarySchema,
		/** Containment depth below the scope: 0 for the named symbol or a module's top level. */
		depth: z.number(),
	})
	.meta({ id: "ScopeSymbol" });

export type ScopeSymbol = z.infer<typeof ScopeSymbolSchema>;

/** A scope's declarations, members before the declaration holding them. */
export const ScopeSymbolsSchema = z
	.object({
		symbols: z.array(ScopeSymbolSchema),
		/** Parameters and locals left out. */
		localsExcluded: z.number(),
	})
	.meta({ id: "ScopeSymbols" });

export type ScopeSymbols = z.infer<typeof ScopeSymbolsSchema>;

/** How a literal search was expressed. Carried back so an answer says what it answered. */
export const LiteralQuerySchema = z
	.object({
		value: z.string().optional(),
		regex: z.string().optional(),
		kind: z.string().optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		key: z.string().optional(),
		within: z.string().optional(),
		module: z.string().optional(),
		/** The request's `exclude` was applied. */
		excluded: z.literal(true).optional(),
	})
	.meta({ id: "LiteralQuery" });

export type LiteralQuery = z.infer<typeof LiteralQuerySchema>;

export const LiteralsResultSchema = z
	.object({ query: LiteralQuerySchema, literals: z.array(StoredLiteralSchema), ...counted })
	.meta({ id: "LiteralsResult" });

export type LiteralsResult = z.infer<typeof LiteralsResultSchema>;

/** How a comment search was expressed. Carried back so an answer says what it answered. */
export const CommentQuerySchema = z
	.object({
		text: z.string().optional(),
		regex: z.string().optional(),
		form: CommentFormSchema.optional(),
		module: z.string().optional(),
		within: z.string().optional(),
		/** The request's `exclude` was applied. */
		excluded: z.literal(true).optional(),
	})
	.meta({ id: "CommentQuery" });

export type CommentQuery = z.infer<typeof CommentQuerySchema>;

/** The symbol a comment was written about, with enough to recognize it without a second call. */
export const CommentAnchorSchema = z
	.object({
		symbolId: z.string(),
		name: z.string(),
		kind: SymbolKindSchema,
		signature: z.string().optional(),
		line: z.number(),
	})
	.meta({ id: "CommentAnchor" });

export type CommentAnchor = z.infer<typeof CommentAnchorSchema>;

export const FoundCommentSchema = z
	.object({
		factId: z.string(),
		module: z.string(),
		range: RangeSchema,
		form: CommentFormSchema,
		placement: z.string(),
		/** Verbatim, capped. */
		raw: z.string(),
		/** Null when the module itself is the container: a header, a licence, a banner. */
		anchor: CommentAnchorSchema.nullable(),
	})
	.meta({ id: "FoundComment" });

export type FoundComment = z.infer<typeof FoundCommentSchema>;

export const CommentsResultSchema = z
	.object({ query: CommentQuerySchema, comments: z.array(FoundCommentSchema), ...counted })
	.meta({ id: "CommentsResult" });

export type CommentsResult = z.infer<typeof CommentsResultSchema>;

/** How a docs search was expressed. Carried back so an answer says what it answered. */
export const DocQuerySchema = z
	.object({
		text: z.string().optional(),
		regex: z.string().optional(),
		/** True for fenced regions only, false for prose only, absent for both. */
		fenced: z.boolean().optional(),
		module: z.string().optional(),
		/** The request's `exclude` was applied. */
		excluded: z.literal(true).optional(),
	})
	.meta({ id: "DocQuery" });

export type DocQuery = z.infer<typeof DocQuerySchema>;

export const FoundDocSchema = z
	.object({
		factId: z.string(),
		module: z.string(),
		range: RangeSchema,
		fenced: z.boolean(),
		/** Verbatim, capped. */
		raw: z.string(),
		/** The headings above this region, outermost first, empty when it sits under none. */
		headingPath: z.array(z.string()),
		/** Where the match sits in the file; absent when the raw text cannot place it. */
		hit: z.object({ line: z.number(), character: z.number() }).optional(),
	})
	.meta({ id: "FoundDoc" });

export type FoundDoc = z.infer<typeof FoundDocSchema>;

export const DocsResultSchema = z
	.object({ query: DocQuerySchema, docs: z.array(FoundDocSchema), ...counted })
	.meta({ id: "DocsResult" });

export type DocsResult = z.infer<typeof DocsResultSchema>;

/** One end of a call relationship, with every span where that call is written. */
export const CallHierarchyEdgeSchema = z
	.object({ symbol: SymbolSummarySchema, ranges: z.array(RangeSchema) })
	.meta({ id: "CallHierarchyEdge" });

export type CallHierarchyEdge = z.infer<typeof CallHierarchyEdgeSchema>;

export const CallHierarchySchema = z
	.object({
		symbolId: z.string(),
		incoming: z.array(CallHierarchyEdgeSchema),
		outgoing: z.array(CallHierarchyEdgeSchema),
		/** Incoming calls at a module's top level, which have no calling symbol. */
		incomingFromModules: z.array(z.object({ module: z.string(), ranges: z.array(RangeSchema) })).optional(),
	})
	.meta({ id: "CallHierarchy" });

export type CallHierarchy = z.infer<typeof CallHierarchySchema>;

/** Edge roles in precedence order; a peer's first role names its group. */
export const EdgeRoleSchema = z.enum(["call", "instantiate", "write", "read", "typeUse"]).meta({ id: "EdgeRole" });

export type EdgeRole = z.infer<typeof EdgeRoleSchema>;

/** Peer symbol, module, roles, and sites. */
export const EdgePeerSchema = z
	.object({
		/** Omitted for module top-level sites. */
		symbol: SymbolSummarySchema.optional(),
		module: z.string(),
		roles: z.partialRecord(EdgeRoleSchema, z.number().int().positive()),
		sites: z.number().int().positive(),
		/** Outgoing only: declarations inside the focus that use it. */
		holders: z.number().int().positive().optional(),
	})
	.meta({ id: "EdgePeer" });

export type EdgePeer = z.infer<typeof EdgePeerSchema>;

/** Peers by first role, capped; `total` is uncapped. */
export const EdgeGroupSchema = z
	.object({ role: EdgeRoleSchema, peers: z.array(EdgePeerSchema), total: z.number().int().nonnegative() })
	.meta({ id: "EdgeGroup" });

export type EdgeGroup = z.infer<typeof EdgeGroupSchema>;

/** Names without symbols by sites, capped; `total` counts every name. */
export const NameTallySchema = z
	.object({
		names: z.array(z.object({ name: z.string(), sites: z.number().int().positive() })),
		total: z.number().int().nonnegative(),
	})
	.meta({ id: "NameTally" });

export type NameTally = z.infer<typeof NameTallySchema>;

/** Both directions by role; the nearest non-local declaration owns each site. */
export const SymbolEdgesSchema = z
	.object({
		symbolId: z.string(),
		incoming: z.object({
			groups: z.array(EdgeGroupSchema),
			/** Sites inside focus, including recursion. */
			internal: z.number().int().nonnegative(),
		}),
		outgoing: z.object({
			groups: z.array(EdgeGroupSchema),
			/** Distinct locals and members used inside. */
			internal: z.number().int().nonnegative(),
			/** A namespace import's own name, by module; its members stay peers. */
			modules: z.array(z.object({ module: z.string(), sites: z.number().int().positive() })),
			/** Names declared outside the workspace. */
			library: NameTallySchema,
			/** Names without a resolved target. */
			unresolved: NameTallySchema,
		}),
	})
	.meta({ id: "SymbolEdges" });

export type SymbolEdges = z.infer<typeof SymbolEdgesSchema>;

export const SearchSymbolsResultSchema = z
	.object({
		text: z.string().optional(),
		regex: z.string().optional(),
		symbols: z.array(SymbolSummarySchema),
		/** The request's `exclude` was applied. */
		excluded: z.literal(true).optional(),
		...counted,
	})
	.meta({ id: "SearchSymbolsResult" });

export type SearchSymbolsResult = z.infer<typeof SearchSymbolsResultSchema>;

export const MostReferencedEntrySchema = z
	.object({ symbolId: z.string(), count: z.number(), declaration: SymbolSummarySchema.nullable() })
	.meta({ id: "MostReferencedEntry" });

export type MostReferencedEntry = z.infer<typeof MostReferencedEntrySchema>;

export const MostReferencedResultSchema = z.array(MostReferencedEntrySchema).meta({ id: "MostReferencedResult" });

export type MostReferencedResult = z.infer<typeof MostReferencedResultSchema>;

/** One value written in several files, with how widely. */
export const SharedLiteralSchema = z
	.object({
		value: z.string(),
		kind: z.string(),
		files: z.number(),
		uses: z.number(),
		/** The request's `exclude` was applied. */
		excluded: z.literal(true).optional(),
	})
	.meta({ id: "SharedLiteral" });

export type SharedLiteral = z.infer<typeof SharedLiteralSchema>;

export const SharedLiteralsResultSchema = z.array(SharedLiteralSchema).meta({ id: "SharedLiteralsResult" });

export type SharedLiteralsResult = z.infer<typeof SharedLiteralsResultSchema>;

export {
	LoadCycleHazardSchema,
	LoadCycleUnknownSchema,
	ModuleCycleSchema,
	ModuleCyclesRequestSchema,
	ModuleProblemsRequestSchema,
	ModuleProblemsResponseSchema,
} from "./loadCycles.js";

export const CacheStatsSchema = z
	.object({ hits: z.number(), misses: z.number(), entries: z.number(), generation: z.number() })
	.meta({ id: "CacheStats" });

export type CacheStats = z.infer<typeof CacheStatsSchema>;

export const FileNoteSchema = z
	.object({
		severity: z.enum(["warning", "info"]),
		message: z.string(),
		range: RangeSchema.optional(),
		path: z.string().optional(),
	})
	.meta({ id: "FileNote" });

export type FileNote = z.infer<typeof FileNoteSchema>;

/** Unknown until a read with notes. */
export const FileNotesSchema = z
	.discriminatedUnion("known", [
		z.object({ module: z.string(), known: z.literal(true), notes: z.array(FileNoteSchema) }),
		z.object({ module: z.string(), known: z.literal(false), reason: z.enum(["notIndexed", "indexedBeforeNotes"]) }),
	])
	.meta({ id: "FileNotes" });

export type FileNotes = z.infer<typeof FileNotesSchema>;

/** Which import search was asked, carried back so an answer says what it answered. */
export const ImportQuerySchema = z
	.object({
		specifier: z.string().optional(),
		specifierRegex: z.string().optional(),
		module: z.string().optional(),
		moduleRegex: z.string().optional(),
		limit: z.number().optional(),
	})
	.meta({ id: "ImportQuery" });

export type ImportQuery = z.infer<typeof ImportQuerySchema>;

export const FindImportsResultSchema = z
	.object({
		query: ImportQuerySchema,
		imports: z.array(StoredImportSchema),
		/** The request's `exclude` was applied. */
		excluded: z.literal(true).optional(),
		...counted,
	})
	.meta({ id: "FindImportsResult" });

export type FindImportsResult = z.infer<typeof FindImportsResultSchema>;

/** One module's paint facts from the store, or why it has none. */
export const ModuleFactsResultSchema = z
	.discriminatedUnion("known", [
		PaintFactsSchema.extend({ module: z.string(), known: z.literal(true) }),
		z.object({ module: z.string(), known: z.literal(false), reason: z.enum(["notIndexed", "unowned"]) }),
	])
	.meta({ id: "ModuleFactsResult" });

export type ModuleFactsResult = z.infer<typeof ModuleFactsResultSchema>;

/** Paint facts for handed text, parsed by the owning provider without touching the store. */
export const ParseFactsResultSchema = z
	.discriminatedUnion("ok", [
		PaintFactsSchema.extend({ ok: z.literal(true) }),
		z.object({ ok: z.literal(false), reason: z.string() }),
	])
	.meta({ id: "ParseFactsResult" });

export type ParseFactsResult = z.infer<typeof ParseFactsResultSchema>;

////////////////////////////////
//  Index state

/** Why a file was not indexed, closed; `current` means the index already holds this version. */
export const IndexCauseSchema = z
	.enum(["missing", "binary", "tooLarge", "unclaimed", "parseFailed", "current", "providerDown", "fault"])
	.meta({ id: "IndexCause" });

export type IndexCause = z.infer<typeof IndexCauseSchema>;

export const IndexOutcomeSchema = z
	.object({
		module: z.string(),
		action: z.enum(["indexed", "forgotten", "skipped"]),
		/** Absent when indexed. `reason` and `failure` are the prose; this is the value. */
		cause: IndexCauseSchema.optional(),
		reason: z.string().optional(),
		failure: z.string().optional(),
		declarations: z.number().optional(),
	})
	.meta({ id: "IndexOutcome" });

export type IndexOutcome = z.infer<typeof IndexOutcomeSchema>;

/** What `indexFile` would find for one module, read without indexing anything. */
export const ModuleStatusSchema = z
	.object({
		module: z.string(),
		/** On disk under the workspace, as the indexer's own reader sees it. */
		exists: z.boolean(),
		/** A provider owns it and the scope admits it. */
		claimed: z.boolean(),
		provider: z.string().optional(),
		/** Why nothing will index it, when `claimed` is false. */
		unclaimedReason: z.string().optional(),
		/** The store holds facts for it, at `depth`. */
		indexed: z.boolean(),
		depth: IndexDepthSchema.optional(),
		/** The recorded parse failure, if any. */
		failure: z.string().optional(),
	})
	.meta({ id: "ModuleStatus" });

export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

/**
 * Why the index may read a module: auto-discovery admits it, or an indexed module imports it.
 * Null when the scope denies it or nothing reaches it.
 */
export const AdmittedModuleSchema = z
	.object({ module: z.string(), admitted: z.enum(["discovered", "imported"]).nullable() })
	.meta({ id: "AdmittedModule" });

export type AdmittedModule = z.infer<typeof AdmittedModuleSchema>;

/** What one read found. `detail` explains `binary`, `tooLarge`, or a link-outside `missing`. */
export const SourceReadOutcomeSchema = z
	.object({
		kind: z.enum(["text", "missing", "binary", "tooLarge"]),
		detail: z.string().optional(),
	})
	.meta({ id: "SourceReadOutcome" });

export type SourceReadOutcome = z.infer<typeof SourceReadOutcomeSchema>;

/**
 * One module's status, the hash the index holds, the hash of the bytes one read loaded, and its
 * declaration rows, from one synchronous snapshot, so no field can describe a different version.
 */
export const ModuleDeclarationsSchema = ModuleStatusSchema.extend({
	read: SourceReadOutcomeSchema,
	/** The hash the index holds; null when it holds no row. */
	contentHash: z.string().nullable(),
	/** The hash of the bytes the read loaded; null unless `read.kind` is `text`. */
	diskHash: z.string().nullable(),
	declarations: z.array(StoredDeclarationSchema),
}).meta({ id: "ModuleDeclarations" });

export type ModuleDeclarations = z.infer<typeof ModuleDeclarationsSchema>;

const failedFile = z.object({ module: z.string(), reason: z.string() });

/**
 * One language provider as the supervisor sees it. `starting`: spawned, initialize not yet
 * answered. `initializing`: the provider said it is warming. `restarting`: died, being respawned.
 * `down`: dead past the respawn cap. `language` is the provider's language id, and `label` the
 * phrase it gave with its last phase. `pending` counts requests queued or running on it.
 */
export const ProviderStatusSchema = z
	.object({
		id: z.string(),
		language: z.string(),
		phase: z.enum(["starting", "initializing", "ready", "restarting", "down"]),
		label: z.string().optional(),
		pending: z.number().int().nonnegative(),
	})
	.meta({ id: "ProviderStatus" });

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

/**
 * What the index is doing now. `done` and `total` count files where the work has a count; a scan's
 * and an upgrade's are the status's own. `label` names a refactor step's kind, or a batch's re-parse
 * of many modules beyond its own files, which it then counts.
 */
export const IndexActivitySchema = z
	.object({
		kind: z.enum(["scan", "batch", "upgrade", "rebind", "refactor"]),
		done: z.number().int().nonnegative().optional(),
		total: z.number().int().nonnegative().optional(),
		label: z.string().optional(),
	})
	.meta({ id: "IndexActivity" });

export type IndexActivity = z.infer<typeof IndexActivitySchema>;

/** How complete the index is. `state`, `done` and `total` are this process's scan; `stored` is the index on disk. */
export const IndexStatusSchema = z
	.object({
		state: z.enum(["unstarted", "discovering", "warming", "indexing", "upgrading", "ready"]),
		done: z.number(),
		total: z.number(),
		failures: z.number(),
		/** The first few failed files by path, each with the provider's reason. */
		failed: z.array(failedFile),
		/** The file asked about, when it is one of the failures. */
		concerning: failedFile.optional(),
		/** Files the index already holds, from this scan or any earlier one. */
		stored: z.number(),
		/** Stored files not still owing a full pass. */
		fullFiles: z.number(),
		/** Stored files still owing a full pass; reference counts are lower bounds while nonzero. */
		outlineFiles: z.number(),
		/** Fact and answer writes change it. Equal values mean indexed reads still hold. */
		generation: z.string().optional(),
		/** Every provider the daemon runs; an older daemon omits it. */
		providers: z.array(ProviderStatusSchema).optional(),
		/** Null when idle; an older daemon omits it. */
		activity: IndexActivitySchema.nullable().optional(),
	})
	.meta({ id: "IndexStatus" });

export type IndexStatus = z.infer<typeof IndexStatusSchema>;

/** The symbol a cursor means: the target a bound reference under it names, else the innermost
 * declaration around it. Never a guess by name. */
export const SymbolAtResultSchema = z
	.discriminatedUnion("found", [
		z.object({
			found: z.literal(true),
			symbolId: z.string().min(1),
			via: z.enum(["reference", "declaration"]),
			/** The bytes the answer came from, so a caller holding others asks again with them. */
			contentHash: z.string(),
		}),
		z.object({
			found: z.literal(false),
			reason: z.enum(["noSymbol", "notIndexed", "unowned", "unparsed"]),
			contentHash: z.string().optional(),
			detail: z.string().optional(),
		}),
	])
	.meta({ id: "SymbolAtResult" });

export type SymbolAtResult = z.infer<typeof SymbolAtResultSchema>;

/** `needsText` answers a `contentHash` that neither the stored facts nor a kept candidate hold. */
export const SymbolAtReplySchema = z
	.union([SymbolAtResultSchema, z.object({ needsText: z.literal(true) })])
	.meta({ id: "SymbolAtReply" });

export type SymbolAtReply = z.infer<typeof SymbolAtReplySchema>;

/** What the last knowledge sweep did; `ambiguous` counts within `orphaned`. */
export const KnowledgeSweepSchema = z
	.object({
		examined: z.number(),
		rebound: z.number(),
		orphaned: z.number(),
		deleted: z.number(),
		ambiguous: z.number(),
		/** The cap stopped it; the next sweep resumes from where it stopped. */
		stoppedEarly: z.boolean(),
	})
	.meta({ id: "KnowledgeSweep" });

export type KnowledgeSweep = z.infer<typeof KnowledgeSweepSchema>;

/** Parts sum to `tracked`. */
export const ScanCountsSchema = z
	.object({
		tracked: z.number(),
		claimed: z.number(),
		unclaimed: z.number(),
		generated: z.number(),
		denied: z.number(),
		outlined: z.boolean(),
		/** Absent until a sweep has run in this store. */
		knowledgeSweep: KnowledgeSweepSchema.optional(),
	})
	.meta({ id: "ScanCounts" });

export type ScanCounts = z.infer<typeof ScanCountsSchema>;

/** Per content class. Unknown is a row written before the class was recorded. */
export const ContentCountsSchema = z
	.object({ code: z.number(), data: z.number(), document: z.number(), text: z.number(), unknown: z.number() })
	.meta({ id: "ContentCounts" });

export type ContentCounts = z.infer<typeof ContentCountsSchema>;

export const ContentTotalsSchema = z
	.object({ files: ContentCountsSchema, symbols: ContentCountsSchema })
	.meta({ id: "ContentTotals" });

export type ContentTotals = z.infer<typeof ContentTotalsSchema>;

export const OverviewResultSchema = z
	.object({
		files: z.number(),
		symbols: z.number(),
		references: z.number(),
		imports: z.number(),
		literals: z.number(),
		content: ContentTotalsSchema,
		/** Per symbol kind, so a document's headings are not read as callable code. */
		symbolsByKind: z.record(z.string(), z.number()),
		/** How the file set was decided, in prose. */
		scope: z.string(),
		index: IndexStatusSchema,
		/** Absent until a scan has recorded its counts. */
		scan: ScanCountsSchema.extend({ at: z.number() }).optional(),
		parseFailures: z.array(failedFile),
		notes: z.object({ noted: z.number(), unknown: z.number() }),
		modules: z.number(),
		largest: z.array(z.object({ module: z.string(), symbols: z.number() })),
		largestData: z.array(
			z.object({ module: z.string(), symbols: z.number(), content: z.enum(["data", "document"]) }),
		),
		/** Reported entry files; absent without role data. */
		entryPoints: z.array(z.object({ module: z.string() }).and(EntryRoleSchema)).optional(),
		/** Entry count beyond the cap. */
		moreEntryPoints: z.number().optional(),
	})
	.meta({ id: "OverviewResult" });

export type OverviewResult = z.infer<typeof OverviewResultSchema>;

////////////////////////////////
//  History

export const FileHistoryCommitSchema = z
	.object({ hash: z.string(), at: z.number(), added: z.number(), deleted: z.number(), subject: z.string() })
	.meta({ id: "FileHistoryCommit" });

export type FileHistoryCommit = z.infer<typeof FileHistoryCommitSchema>;

/** What history says about one file on its own. Churn is lines rather than commits. */
export const FileHistorySchema = z
	.object({
		module: z.string(),
		/** Commits touching it, within the window read. */
		commits: z.number(),
		linesAdded: z.number(),
		linesDeleted: z.number(),
		recent: z.array(FileHistoryCommitSchema),
		/** Author time of the oldest and newest commit touching it, unix seconds. */
		firstSeen: z.number().nullable(),
		lastTouched: z.number().nullable(),
		/** True when the oldest commit read also touched this file, so `firstSeen` is a floor. */
		truncated: z.boolean(),
	})
	.meta({ id: "FileHistory" });

export type FileHistory = z.infer<typeof FileHistorySchema>;

export const CoChangeSchema = z
	.object({
		module: z.string(),
		/** Commits touching both files. */
		together: z.number(),
		/** Commits touching the queried file at all, so `together` can be read as a proportion. */
		outOf: z.number(),
	})
	.meta({ id: "CoChange" });

export type CoChange = z.infer<typeof CoChangeSchema>;

export const CoChangedWithResultSchema = z
	.object({
		module: z.string(),
		partners: z.array(CoChangeSchema),
		total: z.number(),
		/** Commits actually read. Fewer than asked for is normal in a young repository. */
		commits: z.number(),
		/** Commits ignored for touching too many files, and the threshold that did it. */
		skippedWideCommits: z.number(),
		widthLimit: z.number(),
	})
	.meta({ id: "CoChangedWithResult" });

export type CoChangedWithResult = z.infer<typeof CoChangedWithResultSchema>;

/** A commit whose message names a symbol. */
export const MentionSchema = z
	.object({
		hash: z.string(),
		at: z.number(),
		/** First line only. */
		subject: z.string(),
		/** Files it touched, so a mention of a common word is judgeable rather than merely present. */
		files: z.number(),
	})
	.meta({ id: "Mention" });

export type Mention = z.infer<typeof MentionSchema>;

export const CommitsMentioningResultSchema = z
	.object({ name: z.string(), mentions: z.array(MentionSchema), commits: z.number() })
	.meta({ id: "CommitsMentioningResult" });

export type CommitsMentioningResult = z.infer<typeof CommitsMentioningResultSchema>;

////////////////////////////////
//  Source

/** One symbol's text as it stands on disk, with the range that text occupies. */
export const SymbolSourceSchema = z
	.discriminatedUnion("found", [
		z.object({
			found: z.literal(true),
			module: z.string(),
			name: z.string(),
			/** A declaration's symbol kind, or `<kind> literal` when the address named a literal fact. */
			kind: z.string(),
			range: RangeSchema,
			text: z.string(),
			/** Of the same read the text came from, so a later write can prove nothing moved. */
			contentHash: z.string(),
			/** Of `text`, for `refactorReplaceSpan`. */
			spanHash: z.string().optional(),
		}),
		z.object({ found: z.literal(false), reason: z.string(), stale: z.boolean().optional() }),
	])
	.meta({ id: "SymbolSource" });

export type SymbolSource = z.infer<typeof SymbolSourceSchema>;

////////////////////////////////
//  Refactoring

export const REFACTOR_ISSUE_KINDS = [
	"ExportedBeyondIndex",
	"FinishIncomplete",
	"ImportersUnchecked",
	"NameAlreadyBound",
	"NameImported",
	"NameNotInSource",
	"NameTaken",
	"NotIndexed",
	"OrphanedReference",
	"OwnerCallsUnresolved",
	"OwnerNotIndexed",
	"ReindexFailed",
	"SameName",
	"SameSpellingUnbound",
	"SyntaxUnchecked",
	"UnboundReference",
	"UnresolvedAfterMove",
	"NotImplemented",
	"ParseError",
	"ReceiverMemberMayCapture",
	"StringLiteral",
	"ExternalContract",
	"NotEditable",
	"PrivateSibling",
	"NoExportPath",
	"NoImportPath",
	"AmbiguousImportPath",
	"DynamicDependency",
	"Landed",
	"FixFailed",
	"RouteUnknown",
	"RouteChanged",
	"StopNotReExport",
	"StopUnsupported",
	"ProofUnavailable",
	"KnowledgeKept",
] as const;

/** Reported, never block commits. */
export const ADVISORY_ISSUE_KINDS: ReadonlySet<string> = new Set([
	"ExportedBeyondIndex",
	"ReceiverMemberMayCapture",
	"SameSpellingUnbound",
]);

export const RefactorIssueSchema = z
	.object({
		kind: z
			.string()
			.refine(
				(kind) => (REFACTOR_ISSUE_KINDS as readonly string[]).includes(kind),
				"unknown refactor issue kind",
			),
		detail: z.string(),
		module: z.string().optional(),
		line: z.number().optional(),
		/** Which step introduced it, so status can point at one rather than at the workspace. */
		stepNo: z.number().optional(),
	})
	.meta({ id: "RefactorIssue" });

export type RefactorIssue = z.infer<typeof RefactorIssueSchema>;

/** A blocker is something known to break; a warning is somewhere the index cannot see far enough. */
export const RenameConcernSchema = z
	.object({
		kind: z.string(),
		detail: z.string(),
		/** Where it was found, when the concern is about specific occurrences. */
		sites: z.array(z.object({ module: z.string(), line: z.number() })).optional(),
	})
	.meta({ id: "RenameConcern" });

export type RenameConcern = z.infer<typeof RenameConcernSchema>;

/** Occurrences of one symbol in one file, which is the unit a provider is asked to rewrite. */
export const RenameFileSchema = z
	.object({
		module: z.string(),
		sites: z.array(RenameSiteSchema),
		/** Calls in this file to the declaration owning the renamed symbol. Absent for an unowned one. */
		ownerCalls: z.array(RangeSchema).optional(),
	})
	.meta({ id: "RenameFile" });

export type RenameFile = z.infer<typeof RenameFileSchema>;

/** What the rename does to one route edge. */
export const RouteStateSchema = z.enum(["renamed", "fixed", "stopped", "unknown"]).meta({ id: "RouteState" });

export type RouteState = z.infer<typeof RouteStateSchema>;

/** One export or import fact a route crosses. An export's id is its stop id when `stoppable`. */
export const RouteEdgeSchema = z
	.discriminatedUnion("fact", [
		z.object({
			fact: z.literal("export"),
			id: ExportFactIdSchema,
			from: z.string(),
			/** Where it points; absent for a local target or an unknown route. */
			landing: LandingSchema.optional(),
			form: ExportFormSchema,
			name: z.string().optional(),
			state: RouteStateSchema,
			stoppable: z.literal(true).optional(),
		}),
		z.object({
			fact: z.literal("import"),
			id: ImportFactIdSchema,
			from: z.string(),
			/** Absent on an unknown route. */
			landing: LandingSchema.optional(),
			transfer: ImportKindSchema,
			name: z.string().optional(),
			state: RouteStateSchema,
		}),
	])
	.refine((edge) => edge.state !== "unknown" || edge.landing === undefined, {
		message: "an unknown route has no landing",
	})
	.meta({ id: "RouteEdge" });

export type RouteEdge = z.infer<typeof RouteEdgeSchema>;

/** One module a route reaches. A module may hold edited and kept sites at once. */
export const RouteModuleSchema = z
	.object({
		module: z.string(),
		roles: z.array(z.enum(["declares", "imports", "reExports", "uses"])),
		edited: z.number(),
		/** Sites a stop keeps. */
		kept: z.number(),
		/** Uses and routes in it no fact proves. */
		unknown: z.number(),
	})
	.meta({ id: "RouteModule" });

export type RouteModule = z.infer<typeof RouteModuleSchema>;

export const RenamePlanSchema = z
	.object({
		symbolId: z.string(),
		oldName: z.string(),
		newName: z.string(),
		files: z.array(RenameFileSchema),
		/** Total occurrences to rewrite, the declaration's own name included. */
		occurrences: z.number(),
		blockers: z.array(RenameConcernSchema),
		warnings: z.array(RenameConcernSchema),
		/** Every route the rename follows. */
		routes: z.object({ edges: z.array(RouteEdgeSchema), modules: z.array(RouteModuleSchema) }),
		/** The old name as a whole word in comment prose and string values. Reported, never edited. */
		mentions: z.object({
			comments: z.number(),
			strings: z.number(),
			/** A module lacks the comment or literal tier. */
			incomplete: z.literal(true).optional(),
		}),
	})
	.meta({ id: "RenamePlan" });

export type RenamePlan = z.infer<typeof RenamePlanSchema>;

export const FileEditsSchema = z
	.object({ module: z.string(), contentHash: z.string(), edits: z.array(TextEditSchema) })
	.meta({ id: "FileEdits" });

export type FileEdits = z.infer<typeof FileEditsSchema>;

/** A rename worked out but not applied, for a caller that will apply it itself. */
export const RenameEditPlanSchema = z
	.discriminatedUnion("ok", [
		z.object({ ok: z.literal(true), plan: RenamePlanSchema, files: z.array(FileEditsSchema) }),
		z.object({ ok: z.literal(false), plan: RenamePlanSchema, reason: z.string() }),
	])
	.meta({ id: "RenameEditPlan" });

export type RenameEditPlan = z.infer<typeof RenameEditPlanSchema>;

/** A move worked out but not yet written. The closure is the moved declaration plus everything inside it. */
export const MovePlanSchema = z
	.discriminatedUnion("ok", [
		z.object({
			ok: z.literal(true),
			symbolId: z.string(),
			name: z.string(),
			fromModule: z.string(),
			toModule: z.string(),
			/** The declaration's own text, which is what gets inserted at the target. */
			text: z.string(),
			removal: RangeSchema,
			closure: z.array(z.string()),
			dependencies: z.array(MoveDependencySchema),
			/** Modules importing the moved symbol, which need their specifier re-pointed. */
			referencing: z.array(z.string()),
			/** Whether anything left behind in the source module still uses it. */
			usedAtSource: z.boolean(),
			/** Used outside the target and not exported now. */
			exportsAtTarget: z.boolean().optional(),
			/** Where the target takes it, from the anchor; absent means the target's end. */
			insertion: PositionSchema.optional(),
			/** The source neighbor it leaves, as the anchor that puts it back. */
			restore: MoveAnchorSchema.optional(),
			baseHash: z.string(),
		}),
		z.object({ ok: z.literal(false), reason: z.string() }),
	])
	.meta({ id: "MovePlan" });

export type MovePlan = z.infer<typeof MovePlanSchema>;

/** Apply edits to the base, or empty text when created, to get `text`. */
export const MovePreviewFileSchema = z
	.object({
		module: z.string(),
		contentHash: z.string().nullable(),
		created: z.boolean(),
		text: z.string(),
		edits: z.array(TextEditSchema),
	})
	.meta({ id: "MovePreviewFile" });

export const MovePreviewSchema = z
	.discriminatedUnion("ok", [
		z.object({
			ok: z.literal(true),
			files: z.array(MovePreviewFileSchema),
			issues: z.array(RefactorIssueSchema),
			blockers: z.array(z.object({ module: z.string().optional(), reason: z.string() })),
			/** Absent from a daemon before protocol 6.8.0, and when nothing was promoted. */
			promoted: z.array(PromotedSchema).optional(),
		}),
		z.object({
			ok: z.literal(false),
			files: z.array(MovePreviewFileSchema),
			issues: z.array(RefactorIssueSchema),
			blockers: z.array(z.object({ module: z.string().optional(), reason: z.string() })),
			reason: z.string(),
		}),
	])
	.meta({ id: "MovePreview" });

export type MovePreview = z.infer<typeof MovePreviewSchema>;

/** Apply planned edits to the base, or empty text when created, to get `text`. */
export const InsertPreviewSchema = z
	.discriminatedUnion("state", [
		z.object({
			state: z.literal("planned"),
			module: z.string(),
			contentHash: z.string().nullable(),
			created: z.boolean(),
			text: z.string(),
			edits: z.array(TextEditSchema),
			issues: z.array(RefactorIssueSchema),
		}),
		z.object({ state: z.literal("present"), module: z.string(), issues: z.array(RefactorIssueSchema) }),
		z.object({ state: z.literal("refused"), reason: z.string(), issues: z.array(RefactorIssueSchema) }),
	])
	.meta({ id: "InsertPreview" });

export type InsertPreview = z.infer<typeof InsertPreviewSchema>;

/** What writing a whole module's text would do, judged against the stored text `contentHash` names. */
export const ReplacePreviewSchema = z
	.discriminatedUnion("state", [
		z.object({
			state: z.literal("planned"),
			module: z.string(),
			contentHash: z.string(),
			issues: z.array(RefactorIssueSchema),
		}),
		z.object({
			state: z.literal("refused"),
			reason: z.string(),
			/** The index moved past `contentHash`; read again, never retry. */
			stale: z.literal(true).optional(),
			issues: z.array(RefactorIssueSchema),
		}),
	])
	.meta({ id: "ReplacePreview" });

export type ReplacePreview = z.infer<typeof ReplacePreviewSchema>;

export const RefactorBeforeImageSchema = z
	.union([
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
		/** Asked with `content: false`. */
		z.object({
			tracked: z.literal(true),
			existed: z.literal(true),
			contentHash: z.string(),
			encoding: z.enum(["text", "base64"]),
			omitted: z.literal(true),
		}),
	])
	.meta({ id: "RefactorBeforeImage" });

export type RefactorBeforeImage = z.infer<typeof RefactorBeforeImageSchema>;

export const StepKindSchema = z.enum(["replace", "rename", "move", "insert"]).meta({ id: "StepKind" });

export type StepKind = z.infer<typeof StepKindSchema>;

/** How far a step got. Each is committed BEFORE the work it names. */
export const StepPhaseSchema = z.enum(["journaled", "written", "reindexed", "finalized"]).meta({ id: "StepPhase" });

export type StepPhase = z.infer<typeof StepPhaseSchema>;

export const TransactionStepSchema = z
	.object({ stepNo: z.number(), kind: StepKindSchema, phase: StepPhaseSchema, modules: z.array(z.string()) })
	.meta({ id: "TransactionStep" });

export type TransactionStep = z.infer<typeof TransactionStepSchema>;

const Hash32 = z.string().regex(/^[0-9a-f]{32}$/);

/** IDs scope sequences. */
export const LedgerMarkSchema = z
	.object({ id: z.string(), latest: z.number().int().nonnegative() })
	.meta({ id: "LedgerMark" });

export type LedgerMark = z.infer<typeof LedgerMarkSchema>;

export const DriftedModuleSchema = z
	.object({
		module: z.string(),
		contentHash: Hash32.nullable(),
	})
	.meta({ id: "DriftedModule" });

export type DriftedModule = z.infer<typeof DriftedModuleSchema>;

export const TransactionStatusSchema = z
	.object({
		open: z.boolean(),
		id: z.string().optional(),
		startedAt: z.number().optional(),
		revision: z.number().int().nonnegative().optional(),
		steps: z.array(TransactionStepSchema),
		tracked: z.array(z.string()),
		drifted: z.array(DriftedModuleSchema),
		edited: z.array(z.string()),
		issues: z.array(RefactorIssueSchema),
		/** Optional across daemon versions. */
		ledger: LedgerMarkSchema.optional(),
	})
	.meta({ id: "TransactionStatus" });

export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export const RefactorStartResultSchema = z
	.object({ started: z.boolean(), id: z.string(), reason: z.string().optional() })
	.meta({ id: "RefactorStartResult" });

export type RefactorStartResult = z.infer<typeof RefactorStartResultSchema>;

export const RefactorTrackResultSchema = z
	.object({
		tracked: z.boolean(),
		/** Omitted by older daemons. */
		refactor: z.object({ id: z.string() }).nullable().optional(),
		/** Optional across daemon versions. */
		ledger: LedgerMarkSchema.optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "RefactorTrackResult" });

export type RefactorTrackResult = z.infer<typeof RefactorTrackResultSchema>;

export const SettledFileSchema = z
	.object({
		module: z.string(),
		/** Baseline restored by Revert. */
		opened: Hash32.nullable(),
		/** Baseline after Revert. */
		settled: Hash32.nullable(),
		/** Differing disk hash; null if absent or non-file. */
		drifted: z.object({ contentHash: Hash32.nullable() }).optional(),
	})
	.meta({ id: "SettledFile" });

export type SettledFile = z.infer<typeof SettledFileSchema>;

export const SettlementSchema = z
	.object({
		/** Increasing, never reused. */
		seq: z.number().int().positive(),
		id: z.string(),
		origin: z.enum(["explicit", "own"]),
		outcome: z.enum(["committed", "reverted"]),
		closedAt: z.number(),
		/** Sorted tracked modules. */
		files: z.array(SettledFileSchema),
	})
	.meta({ id: "Settlement" });

export type Settlement = z.infer<typeof SettlementSchema>;

export const RefactorSettlementsSchema = z
	.object({
		ledger: LedgerMarkSchema,
		/** Oldest retained, or null. */
		oldest: z.number().int().positive().nullable(),
		settlements: z.array(SettlementSchema),
	})
	.meta({ id: "RefactorSettlements" });

export type RefactorSettlements = z.infer<typeof RefactorSettlementsSchema>;

/** False: pruned or unknown. */
export const RefactorSettledImageSchema = z
	.union([
		z.object({ held: z.literal(false) }),
		z.object({ held: z.literal(true), absent: z.literal(true) }),
		z.object({ held: z.literal(true), contentHash: z.string(), encoding: z.literal("text"), text: z.string() }),
		z.object({ held: z.literal(true), contentHash: z.string(), encoding: z.literal("base64"), bytes: z.string() }),
	])
	.meta({ id: "RefactorSettledImage" });

export type RefactorSettledImage = z.infer<typeof RefactorSettledImageSchema>;

export const RefactorWriteFileResultSchema = z
	.discriminatedUnion("written", [
		z.object({
			written: z.literal(true),
			contentHash: Hash32.nullable(),
			/** Open refactor ID, nullable. */
			refactor: z.object({ id: z.string() }).nullable(),
			ledger: LedgerMarkSchema,
			/** False when indexing fails. */
			indexed: z.boolean(),
		}),
		z.object({
			written: z.literal(false),
			refused: z.enum(["changed", "outside", "directory", "notAFile", "tooLarge", "unencodable", "refactor"]),
			reason: z.string(),
			/** Current hash when changed. */
			contentHash: Hash32.nullable().optional(),
			/** Open refactor on refusal. */
			openRefactor: z.object({ id: z.string() }).nullable().optional(),
		}),
	])
	.meta({ id: "RefactorWriteFileResult" });

export type RefactorWriteFileResult = z.infer<typeof RefactorWriteFileResultSchema>;

export const RefactorNoteWriteResultSchema = z
	.object({ noted: z.boolean(), reason: z.string().optional() })
	.meta({ id: "RefactorNoteWriteResult" });

export type RefactorNoteWriteResult = z.infer<typeof RefactorNoteWriteResultSchema>;

/** A subject move a reversal left standing, and why it could not be put back. */
export const UnreversedRebindSchema = z
	.object({
		subjectId: z.string(),
		from: z.string(),
		to: z.string(),
		reason: z.enum(["gone", "movedOn", "fromHeld"]),
	})
	.meta({ id: "UnreversedRebind" });

export type UnreversedRebind = z.infer<typeof UnreversedRebindSchema>;

export const RefactorUndoResultSchema = z
	.object({
		undone: z.boolean(),
		stepNo: z.number().optional(),
		modules: z.array(z.string()).optional(),
		unreversed: z.array(UnreversedRebindSchema).optional(),
		/** Modules whose facts did not land again; each stays owed a parse. */
		issues: z.array(RefactorIssueSchema).optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "RefactorUndoResult" });

export type RefactorUndoResult = z.infer<typeof RefactorUndoResultSchema>;

export const RefactorRevertResultSchema = z
	.object({
		reverted: z.boolean(),
		modules: z.array(z.string()),
		unreversed: z.array(UnreversedRebindSchema).optional(),
		/** Modules whose facts did not land again; each stays owed a parse. */
		issues: z.array(RefactorIssueSchema).optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "RefactorRevertResult" });

export type RefactorRevertResult = z.infer<typeof RefactorRevertResultSchema>;

export const RefactorCommitResultSchema = z
	.object({ committed: z.boolean(), issues: z.array(RefactorIssueSchema), reason: z.string().optional() })
	.meta({ id: "RefactorCommitResult" });

export type RefactorCommitResult = z.infer<typeof RefactorCommitResultSchema>;

/** What a replacement did, or why it did nothing. Issues ride along either way. */
export const ReplaceOutcomeSchema = z
	.object({
		replaced: z.boolean(),
		module: z.string().optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "ReplaceOutcome" });

export type ReplaceOutcome = z.infer<typeof ReplaceOutcomeSchema>;

/** A span-guarded replacement. */
export const ReplaceSpanOutcomeSchema = ReplaceOutcomeSchema.extend({
	/** Span changed since read. Read again, never retry. */
	stale: z.boolean().optional(),
	/** On success: `own` committed its own transaction, `joined` wrote into the open one. */
	transaction: z.enum(["joined", "own"]).optional(),
}).meta({ id: "ReplaceSpanOutcome" });

export type ReplaceSpanOutcome = z.infer<typeof ReplaceSpanOutcomeSchema>;

export const MoveOutcomeSchema = z
	.discriminatedUnion("moved", [
		z.object({
			moved: z.literal(true),
			/** Canonical target spelling, on success. */
			toModule: z.string().optional(),
			modules: z.array(z.string()).optional(),
			issues: z.array(RefactorIssueSchema),
			reason: z.string().optional(),
			/** With `together`: the names that moved, one declaration per step, in order. */
			order: z.array(z.string()).optional(),
			promoted: z.array(PromotedSchema).optional(),
		}),
		z.object({
			moved: z.literal(false),
			toModule: z.string().optional(),
			modules: z.array(z.string()).optional(),
			issues: z.array(RefactorIssueSchema),
			reason: z.string().optional(),
			order: z.array(z.string()).optional(),
		}),
	])
	.meta({ id: "MoveOutcome" });

export type MoveOutcome = z.infer<typeof MoveOutcomeSchema>;

/** One file an arrangement writes, and the text it will write. */
export const ArrangeFileSchema = z
	.object({
		module: z.string(),
		/** The hash planned over; null when created. */
		base: Hash32.nullable(),
		created: z.boolean(),
		text: z.string(),
		/** The text's hash, which `refactorArrange` expects back. */
		result: Hash32,
	})
	.meta({ id: "ArrangeFile" });

export type ArrangeFile = z.infer<typeof ArrangeFileSchema>;

export const ArrangePreviewSchema = z
	.discriminatedUnion("ok", [
		z.object({
			ok: z.literal(true),
			files: z.array(ArrangeFileSchema),
			issues: z.array(RefactorIssueSchema),
			/** Every file went through `fixText` cleanly. */
			formatted: z.boolean(),
			/** Each top-level declaration's span in the target's final text; a placed one by its id before the move. */
			placed: z.array(
				z.union([
					z.object({ symbolId: z.string(), factId: z.undefined().optional(), range: RangeSchema }),
					z.object({ factId: z.string(), symbolId: z.undefined().optional(), range: RangeSchema }),
				]),
			),
			/** As on a move preview. */
			promoted: z.array(PromotedSchema).optional(),
		}),
		z.object({
			ok: z.literal(false),
			issues: z.array(RefactorIssueSchema),
			blockers: z.array(z.object({ module: z.string().optional(), reason: z.string() })),
			reason: z.string(),
		}),
	])
	.meta({ id: "ArrangePreview" });

export type ArrangePreview = z.infer<typeof ArrangePreviewSchema>;

/** What a rename did, with what it carried across and what it could not promise. */
export const RenameStepOutcomeSchema = z
	.object({
		renamed: z.boolean(),
		modules: z.array(z.string()).optional(),
		/** Export fact ids kept at the old name. */
		stops: z.array(z.string()).optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "RenameStepOutcome" });

export type RenameStepOutcome = z.infer<typeof RenameStepOutcomeSchema>;

/** A module as the caller last saw it; a null hash means absent. */
export const StepBaseSchema = z.object({ module: z.string(), contentHash: Hash32.nullable() }).meta({ id: "StepBase" });

export type StepBase = z.infer<typeof StepBaseSchema>;

/** Puts back a committed rename or move; ask the same committed method. */
export const ReverseStepSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("rename"), symbolId: z.string(), newName: z.string() }),
		z.object({
			kind: z.literal("move"),
			symbolId: z.string(),
			toModule: z.string(),
			anchor: MoveAnchorSchema.optional(),
		}),
	])
	.meta({ id: "ReverseStep" });

export type ReverseStep = z.infer<typeof ReverseStepSchema>;

/** A module the step wrote; a null hash means absent. */
export const CommittedFileSchema = z
	.object({ module: z.string(), before: Hash32.nullable(), after: Hash32.nullable() })
	.meta({ id: "CommittedFile" });

export type CommittedFile = z.infer<typeof CommittedFileSchema>;

/** A committed rename or move, or why nothing was written. */
export const CommittedStepSchema = z
	.discriminatedUnion("committed", [
		z.object({
			committed: z.literal(true),
			kind: z.enum(["rename", "move"]),
			/** The root's id now. */
			symbolId: z.string(),
			files: z.array(CommittedFileSchema),
			/** Every id the step re-minted, old to new. */
			forwarded: z.array(z.object({ from: z.string(), to: z.string() })),
			reverse: ReverseStepSchema,
			/** A rename's export fact ids kept at the old name. */
			stops: z.array(z.string()).optional(),
			issues: z.array(RefactorIssueSchema),
		}),
		z.object({
			committed: z.literal(false),
			reason: z.string(),
			issues: z.array(RefactorIssueSchema),
			/** Refused because this refactor is open. */
			openRefactor: z.object({ id: z.string() }).optional(),
			/** Modules `bases` missed, or that changed since, at their current hash. */
			unexpected: z.array(StepBaseSchema).optional(),
		}),
	])
	.meta({ id: "CommittedStep" });

export type CommittedStep = z.infer<typeof CommittedStepSchema>;

/** What became of a committed step a client named. */
export const StepOutcomeSchema = z
	.discriminatedUnion("status", [
		/** Never named here, or pruned. */
		z.object({ status: z.literal("unknown") }),
		/** Planning, and cancellable. */
		z.object({ status: z.literal("planning") }),
		/** Past its last check: it will answer. */
		z.object({ status: z.literal("writing") }),
		z.object({ status: z.literal("cancelled") }),
		/** The daemon stopped mid-step; `refactorSettlements` says whether its refactor committed. */
		z.object({ status: z.literal("interrupted") }),
		z.object({ status: z.literal("answered"), answer: CommittedStepSchema }),
	])
	.meta({ id: "StepOutcome" });

export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

export const StepCancelSchema = z
	.object({
		/** True only when the step was still planning, so it will never write. */
		cancelled: z.boolean(),
		outcome: StepOutcomeSchema,
	})
	.meta({ id: "StepCancel" });

export type StepCancel = z.infer<typeof StepCancelSchema>;

export const InsertOutcomeSchema = z
	.object({
		inserted: z.boolean(),
		/** The retry answer: the block already sits where it would go. */
		alreadyInserted: z.boolean().optional(),
		module: z.string().optional(),
		/** From the post-reindex store, never candidate facts: provider id assignment can differ. */
		symbolIds: z.array(z.string()).optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "InsertOutcome" });

export type InsertOutcome = z.infer<typeof InsertOutcomeSchema>;
