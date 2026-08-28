// Every shape a daemon answer is made of.
//
// The wire owns these; core's rows, plans and outcomes are `z.infer` of them, so what the store
// builds and what a client types cannot drift apart. Plain `z.object` throughout: an unnamed field
// is stripped on the way out, which is the contract that nothing leaves that the table does not name.

import { z } from "zod";
import { TextEditSchema } from "./edits.js";
import { FACT_KINDS } from "./factId.js";
import { MoveDependencySchema } from "./move.js";
import { IndexDepthSchema, LiteralSchema } from "./project.js";
import { RenameSiteSchema } from "./rename.js";
import { DeclarationSchema, RangeSchema, ReferenceRoleSchema, SymbolKindSchema, VisibilitySchema } from "./symbols.js";

////////////////////////////////
//  Vocabularies

/** The closed question vocabulary from `docs/knowledge-layer.md`. */
export const QUESTION_CLASSES = ["describe", "why", "relate", "contract", "effects", "usage"] as const;

export const QuestionClassSchema = z.enum(QUESTION_CLASSES).meta({ id: "QuestionClass" });

export type QuestionClass = z.infer<typeof QuestionClassSchema>;

/** How a fact was obtained, carried on every answer so a consumer can weigh it. */
export const AnswerTierSchema = z.enum(["bound", "nameMatched", "unknown"]).meta({ id: "AnswerTier" });

export type AnswerTier = z.infer<typeof AnswerTierSchema>;

/** Where a comment sits relative to the symbol it is about. */
export const CommentFormSchema = z.enum(["leading", "trailing", "inline", "standalone"]).meta({ id: "CommentForm" });

export type CommentForm = z.infer<typeof CommentFormSchema>;

export const FactKindSchema = z.enum(FACT_KINDS).meta({ id: "FactKind" });

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
	/** Citable id for this row, which is what a knowledge answer cites. */
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

/** One name written by one import statement, with the spans a rewrite would replace. */
export const StoredImportSchema = z
	.object({
		factId: z.string(),
		module: z.string(),
		specifier: z.string(),
		reExport: z.boolean(),
		/** Absent when the statement names no export. The edge is still real; only rename skips it. */
		name: z.string().optional(),
		range: RangeSchema.optional(),
		/** Present only when the import writes an alias, which renames must NOT follow. */
		local: z.string().optional(),
		localRange: RangeSchema.optional(),
	})
	.meta({ id: "StoredImport" });

export type StoredImport = z.infer<typeof StoredImportSchema>;

////////////////////////////////
//  Knowledge

/** A declared invalidation: someone read the code and no longer trusts this answer. */
export const DoubtSchema = z
	.object({
		/** The handshake token. Clearing this doubt requires citing it. */
		factId: z.string(),
		reason: z.string(),
		at: z.number(),
		/** Who declared it. Absent when the caller did not say. */
		by: z.string().optional(),
	})
	.meta({ id: "Doubt" });

export type Doubt = z.infer<typeof DoubtSchema>;

export const AnswerSchema = z
	.object({
		symbolId: z.string(),
		question: QuestionClassSchema,
		/** The answer's own citable id, in the fact grammar with kind `answer`. */
		factId: z.string(),
		prose: z.string(),
		/** Fact ids consumed, in the order the author gave them. May include other answers' ids. */
		citations: z.array(z.string()),
		/** True when nothing cited reaches beyond the subject's own declaration. */
		thin: z.boolean(),
		/** Who wrote it. Absent when the caller did not say. */
		model: z.string().optional(),
		createdAt: z.number(),
		/** Present while someone's declared distrust stands. */
		doubt: DoubtSchema.optional(),
	})
	.meta({ id: "Answer" });

export type Answer = z.infer<typeof AnswerSchema>;

/** Any one row, tagged with what it is. What a stored citation resolves to. */
export const StoredFactSchema = z
	.discriminatedUnion("fact", [
		StoredDeclarationSchema.extend({ fact: z.literal("declaration") }),
		StoredReferenceSchema.extend({ fact: z.literal("reference") }),
		StoredImportSchema.extend({ fact: z.literal("import") }),
		StoredLiteralSchema.extend({ fact: z.literal("literal") }),
		StoredCommentSchema.extend({ fact: z.literal("comment") }),
		StoredDocSchema.extend({ fact: z.literal("doc") }),
		AnswerSchema.extend({ fact: z.literal("answer") }),
	])
	.meta({ id: "StoredFact" });

export type StoredFact = z.infer<typeof StoredFactSchema>;

/** One fact, named so an answer can cite it and a later reader can resolve it. */
export const CitedFactSchema = z
	.object({ factId: z.string(), kind: FactKindSchema, module: z.string(), summary: z.string() })
	.meta({ id: "CitedFact" });

export type CitedFact = z.infer<typeof CitedFactSchema>;

/** Everything tier 1 knows about one symbol, as citable facts. */
export const FactSetSchema = z
	.object({
		symbolId: z.string(),
		facts: z.array(CitedFactSchema),
		/** Kinds that were cut off by a limit, so a thin answer is never mistaken for a complete one. */
		truncated: z.array(FactKindSchema),
	})
	.meta({ id: "FactSet" });

export type FactSet = z.infer<typeof FactSetSchema>;

export const ResolveFactsResultSchema = z
	.object({ resolved: z.array(StoredFactSchema), missing: z.array(z.string()) })
	.meta({ id: "ResolveFactsResult" });

export type ResolveFactsResult = z.infer<typeof ResolveFactsResultSchema>;

export const RecordOutcomeSchema = z
	.discriminatedUnion("recorded", [
		z.object({
			recorded: z.literal(true),
			answer: AnswerSchema,
			/** A doubt the previous answer carried that this write did NOT cite, so it rode forward. */
			doubtCarried: DoubtSchema.optional(),
		}),
		z.object({
			recorded: z.literal(false),
			reason: z.string(),
			unresolved: z.array(z.string()).optional(),
			/** The incumbent's still-live citations this write failed to cover. */
			uncovered: z.array(z.string()).optional(),
		}),
	])
	.meta({ id: "RecordOutcome" });

export type RecordOutcome = z.infer<typeof RecordOutcomeSchema>;

/** What a recall gives back: the answer, and whether its ground has moved since. */
export const RecalledAnswerSchema = z
	.object({
		answer: AnswerSchema,
		/** Cited facts that no longer resolve. */
		stale: z.array(z.string()),
		/** Cited answers that still resolve but are themselves stale underneath. */
		inheritedStale: z.array(z.string()),
		/** Cited answers that are doubted, directly or anywhere beneath them. */
		doubtedUpstream: z.array(z.string()),
	})
	.meta({ id: "RecalledAnswer" });

export type RecalledAnswer = z.infer<typeof RecalledAnswerSchema>;

/** One answer or null when a question is named; every answer about the symbol when it is not. */
export const RecallAnswerResultSchema = z
	.union([RecalledAnswerSchema.nullable(), z.array(RecalledAnswerSchema)])
	.meta({ id: "RecallAnswerResult" });

export type RecallAnswerResult = z.infer<typeof RecallAnswerResultSchema>;

/** What declaring a doubt did, per question, including the questions that had nothing to doubt. */
export const InvalidateOutcomeSchema = z
	.object({
		symbolId: z.string(),
		doubted: z.array(z.object({ question: QuestionClassSchema, doubt: DoubtSchema })),
		/** Questions with no recorded answer: counted as gap demand rather than doubted. */
		noAnswer: z.array(QuestionClassSchema),
		/** Set when nothing was done at all, with the reason. */
		refused: z.string().optional(),
	})
	.meta({ id: "InvalidateOutcome" });

export type InvalidateOutcome = z.infer<typeof InvalidateOutcomeSchema>;

/** One place knowledge is missing or doubtful, with enough context to decide whether to write it. */
export const GapRowSchema = z
	.object({
		symbolId: z.string(),
		question: z.string(),
		why: z.enum(["missing", "stale", "doubted"]),
		/** Asks that found nothing, the measured demand. */
		askCount: z.number(),
		fanIn: z.number(),
		name: z.string().optional(),
		kind: z.string().optional(),
		module: z.string().optional(),
	})
	.meta({ id: "GapRow" });

export type GapRow = z.infer<typeof GapRowSchema>;

export const KnowledgeGapsSchema = z
	.object({
		question: z.string(),
		/** Leaves first in root mode, so answering in order lets each parent lean on its children. */
		rows: z.array(GapRowSchema),
		total: z.number(),
		/** Dependencies outside the index, counted not listed. */
		external: z.number(),
		truncated: z.boolean(),
		/** Set when the ledger was empty and the rows are hub-ranked candidates, not measured demand. */
		seeded: z.boolean().optional(),
		/** Set when the knowledge base is too large to resolve every answer's citations here. */
		staleScanSkipped: z.boolean().optional(),
		/** Set when scoped to one file. Zero declarations means unindexed, which is not the same as clean. */
		scope: z.object({ module: z.string(), declarations: z.number() }).optional(),
	})
	.meta({ id: "KnowledgeGaps" });

export type KnowledgeGaps = z.infer<typeof KnowledgeGapsSchema>;

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
		/** Where the body lives, 0-based source lines. */
		lines: z.object({ start: z.number(), end: z.number() }).optional(),
	})
	.meta({ id: "SymbolSummary" });

export type SymbolSummary = z.infer<typeof SymbolSummarySchema>;

/** A note written about a symbol that is not its documentation: beside it, or inside its body. */
export const AttachedCommentSchema = z
	.object({ form: CommentFormSchema, placement: z.string(), line: z.number(), text: z.string() })
	.meta({ id: "AttachedComment" });

export type AttachedComment = z.infer<typeof AttachedCommentSchema>;

/** Fan-in, fan-out and cycle membership, bounded by what binding reached. */
export const GraphSummarySchema = z
	.object({
		symbolId: z.string(),
		fanOut: z.number(),
		fanIn: z.number(),
		/** How many members contributed, so a container's number is readable as one. */
		viaMembers: z.number().optional(),
		/** Present only when this symbol sits in a cycle. */
		cycle: z.array(z.string()).optional(),
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
		tier: AnswerTierSchema,
	})
	.meta({ id: "DescribeResult" });

export type DescribeResult = z.infer<typeof DescribeResultSchema>;

export const ReferencesResultSchema = z
	.object({
		symbolId: z.string(),
		/** Capped, because an agent pays for every row and a hub symbol has thousands. */
		references: z.array(StoredReferenceSchema),
		total: z.number(),
		truncated: z.boolean(),
		tier: AnswerTierSchema,
	})
	.meta({ id: "ReferencesResult" });

export type ReferencesResult = z.infer<typeof ReferencesResultSchema>;

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
	})
	.meta({ id: "CallHierarchy" });

export type CallHierarchy = z.infer<typeof CallHierarchySchema>;

export const SearchSymbolsResultSchema = z
	.object({
		text: z.string().optional(),
		regex: z.string().optional(),
		symbols: z.array(SymbolSummarySchema),
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
	.object({ value: z.string(), kind: z.string(), files: z.number(), uses: z.number() })
	.meta({ id: "SharedLiteral" });

export type SharedLiteral = z.infer<typeof SharedLiteralSchema>;

export const SharedLiteralsResultSchema = z.array(SharedLiteralSchema).meta({ id: "SharedLiteralsResult" });

export type SharedLiteralsResult = z.infer<typeof SharedLiteralsResultSchema>;

/** Members, in no meaningful order. A cycle has no first element. */
export const CycleSchema = z.object({ members: z.array(z.string()) }).meta({ id: "Cycle" });

export type Cycle = z.infer<typeof CycleSchema>;

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
	.object({ query: ImportQuerySchema, imports: z.array(StoredImportSchema), ...counted })
	.meta({ id: "FindImportsResult" });

export type FindImportsResult = z.infer<typeof FindImportsResultSchema>;

////////////////////////////////
//  Index state

export const IndexOutcomeSchema = z
	.object({
		module: z.string(),
		action: z.enum(["indexed", "forgotten", "skipped"]),
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

const failedFile = z.object({ module: z.string(), reason: z.string() });

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
	})
	.meta({ id: "IndexStatus" });

export type IndexStatus = z.infer<typeof IndexStatusSchema>;

/** Parts sum to `tracked`. */
export const ScanCountsSchema = z
	.object({
		tracked: z.number(),
		claimed: z.number(),
		unclaimed: z.number(),
		generated: z.number(),
		denied: z.number(),
		outlined: z.boolean(),
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
		knowledge: z.object({
			answers: z.number(),
			/** Absent when the knowledge base is too large to resolve every citation here. */
			stale: z.number().optional(),
			doubted: z.number().optional(),
		}),
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
		}),
		z.object({ found: z.literal(false), reason: z.string(), stale: z.boolean().optional() }),
	])
	.meta({ id: "SymbolSource" });

export type SymbolSource = z.infer<typeof SymbolSourceSchema>;

////////////////////////////////
//  Refactoring

export const RefactorIssueSchema = z
	.object({
		kind: z.string(),
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
	})
	.meta({ id: "RenamePlan" });

export type RenamePlan = z.infer<typeof RenamePlanSchema>;

export const FileEditsSchema = z
	.object({ module: z.string(), edits: z.array(TextEditSchema) })
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
			baseHash: z.string(),
		}),
		z.object({ ok: z.literal(false), reason: z.string() }),
	])
	.meta({ id: "MovePlan" });

export type MovePlan = z.infer<typeof MovePlanSchema>;

export const StepKindSchema = z.enum(["replace", "rename", "move", "insert", "track"]).meta({ id: "StepKind" });

export type StepKind = z.infer<typeof StepKindSchema>;

/** How far a step got. Each is committed BEFORE the work it names. */
export const StepPhaseSchema = z.enum(["journaled", "written", "reindexed", "finalized"]).meta({ id: "StepPhase" });

export type StepPhase = z.infer<typeof StepPhaseSchema>;

export const TransactionStepSchema = z
	.object({ stepNo: z.number(), kind: StepKindSchema, phase: StepPhaseSchema, modules: z.array(z.string()) })
	.meta({ id: "TransactionStep" });

export type TransactionStep = z.infer<typeof TransactionStepSchema>;

export const TransactionStatusSchema = z
	.object({
		open: z.boolean(),
		id: z.string().optional(),
		startedAt: z.number().optional(),
		steps: z.array(TransactionStepSchema),
		tracked: z.array(z.string()),
		issues: z.array(RefactorIssueSchema),
	})
	.meta({ id: "TransactionStatus" });

export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export const RefactorStartResultSchema = z
	.object({ started: z.boolean(), id: z.string(), reason: z.string().optional() })
	.meta({ id: "RefactorStartResult" });

export type RefactorStartResult = z.infer<typeof RefactorStartResultSchema>;

export const RefactorTrackResultSchema = z
	.object({ tracked: z.boolean(), reason: z.string().optional() })
	.meta({ id: "RefactorTrackResult" });

export type RefactorTrackResult = z.infer<typeof RefactorTrackResultSchema>;

export const RefactorUndoResultSchema = z
	.object({
		undone: z.boolean(),
		stepNo: z.number().optional(),
		modules: z.array(z.string()).optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "RefactorUndoResult" });

export type RefactorUndoResult = z.infer<typeof RefactorUndoResultSchema>;

export const RefactorRevertResultSchema = z
	.object({ reverted: z.boolean(), modules: z.array(z.string()), reason: z.string().optional() })
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

const migrated = z.object({ answers: z.number(), gaps: z.number() });

export const MoveOutcomeSchema = z
	.object({
		moved: z.boolean(),
		/** Canonical target spelling, on success. */
		toModule: z.string().optional(),
		modules: z.array(z.string()).optional(),
		migrated: migrated.optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "MoveOutcome" });

export type MoveOutcome = z.infer<typeof MoveOutcomeSchema>;

/** What a rename did, with what it carried across and what it could not promise. */
export const RenameStepOutcomeSchema = z
	.object({
		renamed: z.boolean(),
		modules: z.array(z.string()).optional(),
		migrated: migrated.optional(),
		issues: z.array(RefactorIssueSchema),
		reason: z.string().optional(),
	})
	.meta({ id: "RenameStepOutcome" });

export type RenameStepOutcome = z.infer<typeof RenameStepOutcomeSchema>;

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
