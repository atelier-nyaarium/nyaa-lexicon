import { z } from "zod";
import { StoredDeclarationSchema } from "./daemonRows.js";
import { EntryRoleSchema, IndexDepthSchema } from "./project.js";

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

export const DiscoveredSubmodulesSchema = z
	.object({ roots: z.array(z.string().min(1)), complete: z.boolean() })
	.meta({ id: "DiscoveredSubmodules" });

export type DiscoveredSubmodules = z.infer<typeof DiscoveredSubmodulesSchema>;

/** How complete the index is. `state`, `done` and `total` are this process's scan; `stored` is the index on disk. */
export const IndexStatusSchema = z
	.object({
		state: z.enum(["unstarted", "discovering", "warming", "indexing", "upgrading", "ready"]),
		/** Whether a complete scan has established this project as indexed. */
		indexed: z.boolean().optional(),
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
