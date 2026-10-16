import { z } from "zod";
import { CommentFormSchema, StoredImportSchema, StoredLiteralSchema, StoredReferenceSchema } from "./daemonRows.js";
import { LoadCycleHazardSchema } from "./loadCycles.js";
import { PaintFactsSchema } from "./paint.js";
import { FileRoleSchema } from "./project.js";
import { ValueStatusSchema } from "./secrets.js";
import { RangeSchema, SymbolKindSchema, VisibilitySchema } from "./symbols.js";
import { UnknownReasonSchema } from "./values.js";

/** How a fact was obtained, carried on every answer so a consumer can weigh it. */
export const AnswerTierSchema = z.enum(["bound", "nameMatched", "unknown"]).meta({ id: "AnswerTier" });

export type AnswerTier = z.infer<typeof AnswerTierSchema>;
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
//  Reading

export const SymbolSummarySchema = z
	.object({
		symbolId: z.string(),
		name: z.string(),
		kind: SymbolKindSchema,
		module: z.string(),
		valueStatus: ValueStatusSchema.optional(),
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
			valueStatus: ValueStatusSchema.optional(),
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
