// The daemon's method table: request and response schemas per method.
//
// The one owner of the daemon wire's shapes. Dispatch validates both directions from it and a
// client derives its typed calls from it, so a method costs one entry here and nothing elsewhere.

import { z } from "zod";
import {
	CacheStatsSchema,
	CallHierarchySchema,
	CoChangedWithResultSchema,
	CommentFormSchema,
	CommentsResultSchema,
	CommitsMentioningResultSchema,
	CycleSchema,
	DescribeResultSchema,
	DocsResultSchema,
	FactSetSchema,
	FileHistorySchema,
	FileNotesSchema,
	FindImportsResultSchema,
	IndexOutcomeSchema,
	IndexStatusSchema,
	InsertOutcomeSchema,
	InvalidateOutcomeSchema,
	KnowledgeGapsSchema,
	KnowledgeScopeSchema,
	LiteralsResultSchema,
	ModuleDeclarationsSchema,
	ModuleFactsResultSchema,
	ModuleStatusSchema,
	MostReferencedResultSchema,
	MoveOutcomeSchema,
	MovePlanSchema,
	OverviewResultSchema,
	ParseFactsResultSchema,
	QuestionClassSchema,
	RecallAnswerResultSchema,
	RecordOutcomeSchema,
	RefactorCommitResultSchema,
	RefactorRevertResultSchema,
	RefactorStartResultSchema,
	RefactorTrackResultSchema,
	RefactorUndoResultSchema,
	ReferencesResultSchema,
	RenameEditPlanSchema,
	RenamePlanSchema,
	RenameStepOutcomeSchema,
	ReplaceOutcomeSchema,
	ReplaceSpanOutcomeSchema,
	ResolveFactsResultSchema,
	SearchSymbolsResultSchema,
	SharedLiteralsResultSchema,
	StoredDeclarationSchema,
	SubjectDiagnosisSchema,
	SymbolSourceSchema,
	SymbolSummarySchema,
	TransactionStatusSchema,
	TypeHierarchySchema,
	UsesFromResultSchema,
} from "./daemonShapes.js";
import { ImportResolutionSchema } from "./project.js";
import { normalizeModulePath } from "./symbolId.js";
import { TypeInfoSchema } from "./values.js";

////////////////////////////////
//  Requests

/**
 * Every path-valued request field: normalized to the one module key the index files under (NFC,
 * forward slashes, no `.` or empty segments), and refused with the grammar's own words before any
 * read or write when it is absolute, escapes the workspace, or carries a control character. A
 * transform, not a refine: a caller spelling `./src/a.ts` or an NFD filename is served, not refused.
 */
const ModulePath = z
	.string()
	.min(1)
	.transform((raw, context) => {
		try {
			return normalizeModulePath(raw);
		} catch (error) {
			context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
			return z.NEVER;
		}
	})
	.meta({ id: "ModulePath" });

const Empty = z.object({}).meta({ id: "EmptyRequest" });
const BySymbol = z.object({ symbolId: z.string().min(1) }).meta({ id: "BySymbolRequest" });
const ByModule = z.object({ module: ModulePath }).meta({ id: "ByModuleRequest" });
const Paged = z.object({ limit: z.number().int().positive().optional() }).meta({ id: "PagedRequest" });
const FindByName = z
	.object({ name: z.string().min(1), module: ModulePath.optional() })
	.meta({ id: "FindByNameRequest" });
const References = z
	.object({
		symbolId: z.string().min(1),
		limit: z.number().int().positive().optional(),
		within: z.string().min(1).optional(),
	})
	.meta({ id: "ReferencesRequest" });
const UsesFrom = z
	.object({ symbolId: z.string().min(1), limit: z.number().int().positive().optional() })
	.meta({ id: "UsesFromRequest" });
const KnowledgeScopeRequest = z
	.object({
		symbolId: z.string().min(1).optional(),
		module: ModulePath.optional(),
		/** With a symbol: its declared members too. A module always takes everything in it. */
		members: z.boolean().optional(),
		includeLocals: z.boolean().optional(),
	})
	.refine(
		(args) => (args.symbolId === undefined) !== (args.module === undefined),
		"Set exactly one of symbolId or module.",
	)
	.meta({ id: "KnowledgeScopeRequest" });
const Resolve = z.object({ fromModule: ModulePath, specifier: z.string().min(1) }).meta({ id: "ResolveRequest" });
const Rename = z.object({ symbolId: z.string().min(1), newName: z.string().min(1) }).meta({ id: "RenameRequest" });
const Move = z.object({ symbolId: z.string().min(1), toModule: ModulePath }).meta({ id: "MoveRequest" });
const Literals = z
	.object({
		value: z.string().optional(),
		regex: z.string().min(1).optional(),
		kind: z.string().optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		limit: z.number().int().positive().optional(),
		within: z.string().min(1).optional(),
		key: z.string().min(1).optional(),
	})
	.meta({ id: "LiteralsRequest" });
const Comments = z
	.object({
		text: z.string().min(1).optional(),
		regex: z.string().min(1).optional(),
		form: CommentFormSchema.optional(),
		module: ModulePath.optional(),
		limit: z.number().int().positive().max(200).optional(),
		within: z.string().min(1).optional(),
	})
	.meta({ id: "CommentsRequest" });
const Docs = z
	.object({
		text: z.string().min(1).optional(),
		regex: z.string().min(1).optional(),
		fenced: z.boolean().optional(),
		module: ModulePath.optional(),
		limit: z.number().int().positive().max(200).optional(),
	})
	.meta({ id: "DocsRequest" });
const Shared = z
	.object({ minimumFiles: z.number().int().positive().optional(), limit: z.number().int().positive().optional() })
	.meta({ id: "SharedRequest" });
const CoChange = z
	.object({ module: ModulePath, limit: z.number().int().positive().optional() })
	.meta({ id: "CoChangeRequest" });
const Search = z
	.object({
		text: z.string().min(1).optional(),
		regex: z.string().min(1).optional(),
		kind: z.string().min(1).optional(),
		module: z.string().min(1).optional(),
		limit: z.number().int().positive().optional(),
		within: z.string().min(1).optional(),
	})
	.refine((args) => (args.text === undefined) !== (args.regex === undefined), "Set exactly one of text or regex.")
	.meta({ id: "SearchRequest" });
const ResolveFacts = z.object({ factIds: z.array(z.string().min(1)).min(1) }).meta({ id: "ResolveFactsRequest" });
const Mentions = z
	.object({ name: z.string().min(1), limit: z.number().int().positive().optional() })
	.meta({ id: "MentionsRequest" });
const RecordAnswer = z
	.object({
		symbolId: z.string().min(1),
		question: QuestionClassSchema,
		prose: z.string().min(1),
		citations: z.array(z.string().min(1)),
		model: z.string().min(1).optional(),
		resolvesDoubt: z.string().min(1).optional(),
		omitting: z.string().min(1).optional(),
	})
	.meta({ id: "RecordAnswerRequest" });
const RecallAnswer = z
	.object({ symbolId: z.string().min(1), question: QuestionClassSchema.optional() })
	.meta({ id: "RecallAnswerRequest" });
const InvalidateAnswer = z
	.object({
		symbolId: z.string().min(1),
		reason: z.string().min(1),
		question: QuestionClassSchema.optional(),
		by: z.string().min(1).optional(),
	})
	.meta({ id: "InvalidateAnswerRequest" });
const ReaffirmAnswer = z
	.object({
		symbolId: z.string().min(1),
		question: QuestionClassSchema,
		citations: z.array(z.string().min(1)).optional(),
		model: z.string().min(1).optional(),
		resolvesDoubt: z.string().min(1).optional(),
	})
	.meta({ id: "ReaffirmAnswerRequest" });
const Gaps = z
	.object({
		root: z.string().min(1).optional(),
		question: QuestionClassSchema.optional(),
		limit: z.number().int().positive().optional(),
		module: ModulePath.optional(),
	})
	.meta({ id: "GapsRequest" });
const Status = z.object({ concerning: z.string().min(1).optional() }).meta({ id: "StatusRequest" });
const FindImports = z
	.object({
		specifier: z.string().min(1).optional(),
		specifierRegex: z.string().min(1).optional(),
		module: ModulePath.optional(),
		moduleRegex: z.string().min(1).optional(),
		limit: z.number().int().positive().optional(),
	})
	.meta({ id: "FindImportsRequest" });
const SymbolSource = z
	.object({ symbolId: z.string().min(1).optional(), factId: z.string().min(1).optional() })
	.meta({ id: "SymbolSourceRequest" });
const Commit = z.object({ force: z.boolean().optional() }).meta({ id: "CommitRequest" });
const Replace = z
	.object({ symbolId: z.string().min(1).optional(), factId: z.string().min(1).optional(), newText: z.string() })
	.meta({ id: "ReplaceRequest" });
const ReplaceSpan = z
	.object({
		symbolId: z.string().min(1),
		/** `spanHash` from the `symbolSource` read. */
		expectedSpanHash: z.string().min(1),
		newText: z.string(),
		/** Opens and commits its own transaction when none is open. */
		standalone: z.boolean().optional(),
	})
	.meta({ id: "ReplaceSpanRequest" });
const Insert = z
	.object({ after: z.string().min(1).optional(), module: ModulePath.optional(), text: z.string().min(1) })
	.refine((args) => (args.after === undefined) !== (args.module === undefined), "Set exactly one of after or module.")
	.meta({ id: "InsertRequest" });
const ParseFacts = z.object({ module: ModulePath, text: z.string() }).meta({ id: "ParseFactsRequest" });

////////////////////////////////
//  The table

/** How a request meets the index's warmup. Every method and control declares one. */
export type Lifecycle = "query" | "status" | "probe" | "trigger" | "control";

export interface LifecycleRule {
	/** Asking starts indexing a cold store, and lets a client start a daemon to ask. */
	warms: boolean;
	/** Answered "starting" until the warmup pass has read every root. */
	waits: boolean;
	/** Refused once the warmup pass failed. */
	refusedAfterFailedWarmup: boolean;
}

/** The one meaning of each lifecycle. */
export const LIFECYCLES = {
	/** A question about the workspace's code. */
	query: { warms: true, waits: true, refusedAfterFailedWarmup: true },
	/** How the index stands. */
	status: { warms: false, waits: false, refusedAfterFailedWarmup: true },
	/** Answered without the index, even by a daemon whose warmup failed. */
	probe: { warms: false, waits: false, refusedAfterFailedWarmup: false },
	/** A request to start indexing, answered at once. */
	trigger: { warms: true, waits: false, refusedAfterFailedWarmup: true },
	/** The daemon's own lifetime. */
	control: { warms: false, waits: false, refusedAfterFailedWarmup: false },
} as const satisfies Record<Lifecycle, LifecycleRule>;

/** Every method the daemon answers, in dispatch order. The JSDoc line on each is what a facade shows.
 * `mutates` marks a write: a read-only face never asks it, and a lost connection never repeats it. */
export const DAEMON_METHODS = {
	/** Declarations named exactly, optionally within one module. */
	findByName: { request: FindByName, response: z.array(SymbolSummarySchema), lifecycle: "query", mutates: false },
	/** One symbol's surface: members, notes, graph numbers and hierarchy. Null when unknown. */
	describe: { request: BySymbol, response: DescribeResultSchema.nullable(), lifecycle: "query", mutates: false },
	/** The stored row for one symbol id. */
	declarationOf: {
		request: BySymbol,
		response: StoredDeclarationSchema.nullable(),
		lifecycle: "query",
		mutates: false,
	},
	/** Every declaration in one module. */
	declarationsIn: {
		request: ByModule,
		response: z.array(StoredDeclarationSchema),
		lifecycle: "query",
		mutates: false,
	},
	/** Supertypes and subtypes, read from heritage references. */
	typeHierarchy: { request: BySymbol, response: TypeHierarchySchema, lifecycle: "query", mutates: false },
	/** Callers and callees, with every call site. */
	callHierarchy: { request: BySymbol, response: CallHierarchySchema, lifecycle: "query", mutates: false },
	/** Who uses a symbol, capped, optionally within a scope. */
	findReferences: { request: References, response: ReferencesResultSchema, lifecycle: "query", mutates: false },
	/** What a symbol and everything inside it references, bound or not. */
	usesFrom: { request: UsesFrom, response: UsesFromResultSchema, lifecycle: "query", mutates: false },
	/** Where an import specifier lands. */
	resolveImport: { request: Resolve, response: ImportResolutionSchema, lifecycle: "query", mutates: false },
	/** How complete the index is, and whether one file failed. */
	indexStatus: { request: Status, response: IndexStatusSchema, lifecycle: "status", mutates: false },
	/** Start indexing the workspace, and how the index stands as it starts. */
	indexWorkspace: { request: Empty, response: IndexStatusSchema, lifecycle: "trigger", mutates: false },
	/** Literals by value, regex, kind, numeric range, container key or scope. */
	findLiterals: { request: Literals, response: LiteralsResultSchema, lifecycle: "query", mutates: false },
	/** Comment prose by substring or regex, with the symbol each is about. */
	findComments: { request: Comments, response: CommentsResultSchema, lifecycle: "query", mutates: false },
	/** Document prose by substring or regex, with the heading path each sits under. */
	findDocs: { request: Docs, response: DocsResultSchema, lifecycle: "query", mutates: false },
	/** Values written in several files. */
	sharedLiterals: { request: Shared, response: SharedLiteralsResultSchema, lifecycle: "query", mutates: false },
	/** Reference cycles, largest first. */
	cycles: { request: Paged, response: z.array(CycleSchema), lifecycle: "query", mutates: false },
	/** Symbols by resolved reference count. */
	mostReferenced: { request: Paged, response: MostReferencedResultSchema, lifecycle: "query", mutates: false },
	/** The `mostReferenced` answer under the name older clients ask by. */
	hubs: { request: Paged, response: MostReferencedResultSchema, lifecycle: "query", mutates: false },
	/** Result cache hit and miss counts. */
	cacheStats: { request: Empty, response: CacheStatsSchema, lifecycle: "status", mutates: false },
	/** Declared names by substring or regex, with kind, module and scope filters. */
	searchSymbols: { request: Search, response: SearchSymbolsResultSchema, lifecycle: "query", mutates: false },
	/** The declarations of one module. */
	outlineModule: { request: ByModule, response: z.array(SymbolSummarySchema), lifecycle: "query", mutates: false },
	/** A provider's warnings and info for one file. */
	fileNotes: { request: ByModule, response: FileNotesSchema, lifecycle: "query", mutates: false },
	/** Whether one file exists, is claimed, and is indexed, without indexing it. */
	moduleStatus: { request: ByModule, response: ModuleStatusSchema, lifecycle: "query", mutates: false },
	/** One file's status, the hash on disk, the hash indexed and its declarations, from one read. */
	moduleDeclarations: {
		request: ByModule,
		response: ModuleDeclarationsSchema,
		lifecycle: "query",
		mutates: false,
	},
	/** One module's paint facts, stored: declarations, references, literals, comments and words. */
	moduleFacts: { request: ByModule, response: ModuleFactsResultSchema, lifecycle: "query", mutates: false },
	/** Paint facts for text not yet written, parsed by the owning provider; nothing is stored. */
	parseFacts: { request: ParseFacts, response: ParseFactsResultSchema, lifecycle: "probe", mutates: false },
	/** Importers by written specifier or resolved module. */
	findImports: { request: FindImports, response: FindImportsResultSchema, lifecycle: "query", mutates: false },
	/** Files, symbols, coverage and the biggest modules. */
	overview: { request: Empty, response: OverviewResultSchema, lifecycle: "query", mutates: false },
	/** Files that change alongside one file in git history. */
	coChangedWith: { request: CoChange, response: CoChangedWithResultSchema, lifecycle: "probe", mutates: false },
	/** One file's age and churn. */
	fileHistory: { request: ByModule, response: FileHistorySchema, lifecycle: "probe", mutates: false },
	/** Commits whose message names a symbol. */
	commitsMentioning: {
		request: Mentions,
		response: CommitsMentioningResultSchema,
		lifecycle: "probe",
		mutates: false,
	},
	/** Everything tier 1 knows about one symbol, as citable facts. Null when unknown. */
	factsFor: { request: References, response: FactSetSchema.nullable(), lifecycle: "query", mutates: false },
	/** The rows behind fact ids, and which ids no longer resolve. */
	resolveFacts: { request: ResolveFacts, response: ResolveFactsResultSchema, lifecycle: "query", mutates: false },
	/** Save an answer grounded in cited facts. */
	recordAnswer: { request: RecordAnswer, response: RecordOutcomeSchema, lifecycle: "query", mutates: true },
	/** Mark recorded answers doubtful without changing their prose. */
	invalidateAnswer: {
		request: InvalidateAnswer,
		response: InvalidateOutcomeSchema,
		lifecycle: "query",
		mutates: true,
	},
	/** Refresh an answer's evidence or clear its doubt. */
	reaffirmAnswer: { request: ReaffirmAnswer, response: RecordOutcomeSchema, lifecycle: "query", mutates: true },
	/** Recorded answers and their health: one when a question is named, all otherwise. */
	recallAnswer: { request: RecallAnswer, response: RecallAnswerResultSchema, lifecycle: "query", mutates: false },
	/** Missing, stale, shaky or doubted answers, ranked by demand. */
	knowledgeGaps: { request: Gaps, response: KnowledgeGapsSchema, lifecycle: "query", mutates: false },
	/** A scope's declarations with each question's state, members first. Null for an unknown symbol. */
	knowledgeScope: {
		request: KnowledgeScopeRequest,
		response: KnowledgeScopeSchema.nullable(),
		lifecycle: "query",
		mutates: false,
	},
	/** Why an id names no declaration, as every tool answers it. */
	diagnoseSubject: { request: BySymbol, response: SubjectDiagnosisSchema, lifecycle: "query", mutates: false },
	/** A symbol's resolved type. */
	typeOf: { request: BySymbol, response: TypeInfoSchema, lifecycle: "query", mutates: false },
	/** What a rename would touch, with blockers and warnings. */
	prepareRename: { request: Rename, response: RenamePlanSchema, lifecycle: "query", mutates: false },
	/** The edits a rename would make, for a caller that applies them itself. */
	renameEdits: { request: Rename, response: RenameEditPlanSchema, lifecycle: "query", mutates: false },
	/** What a move would touch. */
	planMove: { request: Move, response: MovePlanSchema, lifecycle: "query", mutates: false },
	/** Reindex one file now. */
	indexFile: { request: ByModule, response: IndexOutcomeSchema, lifecycle: "query", mutates: true },
	/** One symbol's source text and the range it occupies. */
	symbolSource: { request: SymbolSource, response: SymbolSourceSchema, lifecycle: "query", mutates: false },
	/** Open the workspace's refactor transaction. */
	refactorStart: { request: Empty, response: RefactorStartResultSchema, lifecycle: "query", mutates: true },
	/** The open transaction: steps, tracked files, outstanding issues. Retirement asks it of a failed daemon. */
	refactorStatus: { request: Empty, response: TransactionStatusSchema, lifecycle: "probe", mutates: false },
	/** Snapshot a file before a hand edit. */
	refactorTrack: { request: ByModule, response: RefactorTrackResultSchema, lifecycle: "query", mutates: true },
	/** Remove the newest step, restoring the files it wrote. */
	refactorUndo: { request: Empty, response: RefactorUndoResultSchema, lifecycle: "query", mutates: true },
	/** Return every tracked file to how the transaction found it, and close it. */
	refactorRevert: { request: Empty, response: RefactorRevertResultSchema, lifecycle: "query", mutates: true },
	/** Keep what is on disk and close the transaction. */
	refactorCommit: { request: Commit, response: RefactorCommitResultSchema, lifecycle: "query", mutates: true },
	/** Replace one symbol's whole span with new text, checked before it is written. */
	refactorReplace: { request: Replace, response: ReplaceOutcomeSchema, lifecycle: "query", mutates: true },
	/** Replace one symbol's span only if it is unchanged since read. */
	refactorReplaceSpan: {
		request: ReplaceSpan,
		response: ReplaceSpanOutcomeSchema,
		lifecycle: "query",
		mutates: true,
	},
	/** Author a declaration after a sibling or at the end of a module. */
	refactorInsert: { request: Insert, response: InsertOutcomeSchema, lifecycle: "query", mutates: true },
	/** Rename a symbol across declarations, uses, imports and re-exports. */
	refactorRename: { request: Rename, response: RenameStepOutcomeSchema, lifecycle: "query", mutates: true },
	/** Move a declaration to another module, rewriting the imports that reach it. */
	refactorMove: { request: Move, response: MoveOutcomeSchema, lifecycle: "query", mutates: true },
} as const satisfies Record<
	string,
	{ request: z.ZodType; response: z.ZodType; lifecycle: Exclude<Lifecycle, "control">; mutates: boolean }
>;

/** What the daemon answers about its own lifetime, outside the service's table. */
export const DAEMON_CONTROLS = {
	/** Stop, answered before stopping. */
	shutdown: { lifecycle: "control" },
} as const satisfies Record<string, { lifecycle: "control" }>;

/** Asked again after a lost connection only when it changes nothing: a write that may have landed is reported, not repeated. */
export function methodMutates(name: DaemonMethod): boolean {
	return DAEMON_METHODS[name].mutates;
}

export type DaemonControl = keyof typeof DAEMON_CONTROLS;

/** A known name's policy, carrying the name narrowed to the table that holds it. */
export type RequestRule = LifecycleRule &
	(
		| { lifecycle: "control"; control: DaemonControl }
		| { lifecycle: Exclude<Lifecycle, "control">; method: DaemonMethod }
	);

/**
 * The one reading of a request name's policy, for the daemon before and after its handler lands and
 * for a client deciding whether it may start one. Null for a name neither table holds.
 */
export function requestRule(name: string): RequestRule | null {
	if (isDaemonMethod(name)) {
		const lifecycle = DAEMON_METHODS[name].lifecycle;
		return { lifecycle, method: name, ...LIFECYCLES[lifecycle] };
	}
	if (Object.hasOwn(DAEMON_CONTROLS, name)) {
		const control = name as DaemonControl;
		return { lifecycle: "control", control, ...LIFECYCLES.control };
	}
	return null;
}

export type DaemonMethod = keyof typeof DAEMON_METHODS;

/** The methods a read-only face may ask: every entry the table does not mark `mutates`. */
export type ReadMethod = {
	[M in DaemonMethod]: (typeof DAEMON_METHODS)[M] extends { mutates: true } ? never : M;
}[DaemonMethod];

////////////////////////////////
//  Functions & Helpers

/** Own keys only: `toString` is `in` the table and must not be dispatched. */
export function isDaemonMethod(name: string): name is DaemonMethod {
	return Object.hasOwn(DAEMON_METHODS, name);
}

export type RequestOf<M extends DaemonMethod> = z.infer<(typeof DAEMON_METHODS)[M]["request"]>;

export type ResponseOf<M extends DaemonMethod> = z.infer<(typeof DAEMON_METHODS)[M]["response"]>;
