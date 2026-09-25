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
	InsertPreviewSchema,
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
	MovePreviewSchema,
	OverviewResultSchema,
	ParseFactsResultSchema,
	QuestionClassSchema,
	RecallAnswerResultSchema,
	RecordOutcomeSchema,
	RefactorBeforeImageSchema,
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
	SymbolAtReplySchema,
	SymbolSourceSchema,
	SymbolSummarySchema,
	TransactionStatusSchema,
	TypeHierarchySchema,
	UsesFromResultSchema,
} from "./daemonShapes.js";
import { ImportResolutionSchema } from "./project.js";
import { normalizeModulePath } from "./symbolId.js";
import { PositionSchema } from "./symbols.js";
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
/** Rejects stale transaction expectations. */
const Expectation = z
	.object({ id: z.string().min(1), revision: z.number().int().nonnegative() })
	.meta({ id: "RefactorExpectation" });
const Commit = z
	.object({ force: z.boolean().optional(), expect: Expectation.optional() })
	.meta({ id: "CommitRequest" });
const Unwind = z.object({ expect: Expectation.optional() }).meta({ id: "UnwindRequest" });
const BeforeImage = z
	.object({ module: ModulePath, id: z.string().min(1).optional() })
	.meta({ id: "BeforeImageRequest" });
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
const SymbolAt = z
	.object({
		module: ModulePath,
		position: PositionSchema,
		/** The bytes the caller holds. Sent `text` names its own and wins. */
		contentHash: z.string().min(1).optional(),
		text: z.string().optional(),
	})
	.meta({ id: "SymbolAtRequest" });

////////////////////////////////
//  The table

/** How each request interacts with index warmup. */
export type Lifecycle = "query" | "status" | "probe" | "trigger" | "control";

export interface LifecycleRule {
	/** A client may start a daemon to ask it. */
	starts: boolean;
	/** Starts cold-store indexing. */
	warms: boolean;
	/** Answers "starting" until warmup reads every root. */
	waits: boolean;
	/** Refuses after warmup fails. */
	refusedAfterFailedWarmup: boolean;
}

/** Warmup policy by lifecycle. */
export const LIFECYCLES = {
	query: { starts: true, warms: true, waits: true, refusedAfterFailedWarmup: true },
	/** Absence is the answer, so never starts a daemon. */
	status: { starts: false, warms: false, waits: false, refusedAfterFailedWarmup: true },
	/** Runs without indexing, even after warmup failure. */
	probe: { starts: true, warms: false, waits: false, refusedAfterFailedWarmup: false },
	/** Starts indexing without waiting. */
	trigger: { starts: true, warms: true, waits: false, refusedAfterFailedWarmup: true },
	/** Controls daemon lifetime. */
	control: { starts: false, warms: false, waits: false, refusedAfterFailedWarmup: false },
} as const satisfies Record<Lifecycle, LifecycleRule>;

/** Client-side wait limits by method class. */
export const BUDGETS = {
	/** Provider-backed requests. */
	read: 180_000,
	/** In-memory status queries. */
	status: 30_000,
	/** Git-history queries. */
	history: 120_000,
	/** Multiple provider calls per step. */
	refactor: 300_000,
	control: 15_000,
} as const;

export type Budget = keyof typeof BUDGETS;

/** Method table for dispatch and facades. */
export const DAEMON_METHODS = {
	/** Exact names, optional module filter. */
	findByName: {
		request: FindByName,
		response: z.array(SymbolSummarySchema),
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Symbol summary and hierarchy. */
	describe: {
		request: BySymbol,
		response: DescribeResultSchema.nullable(),
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Stored declaration by id. */
	declarationOf: {
		request: BySymbol,
		response: StoredDeclarationSchema.nullable(),
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Declarations in one module. */
	declarationsIn: {
		request: ByModule,
		response: z.array(StoredDeclarationSchema),
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Heritage-based type hierarchy. */
	typeHierarchy: {
		request: BySymbol,
		response: TypeHierarchySchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Callers, callees, and sites. */
	callHierarchy: {
		request: BySymbol,
		response: CallHierarchySchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Capped symbol uses by scope. */
	findReferences: {
		request: References,
		response: ReferencesResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** References inside a symbol. */
	usesFrom: { request: UsesFrom, response: UsesFromResultSchema, lifecycle: "query", mutates: false, budget: "read" },
	/** Resolve one written import. */
	resolveImport: {
		request: Resolve,
		response: ImportResolutionSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Index completeness and failures. */
	indexStatus: {
		request: Status,
		response: IndexStatusSchema,
		lifecycle: "status",
		mutates: false,
		budget: "status",
	},
	/** Start indexing and return status. */
	indexWorkspace: {
		request: Empty,
		response: IndexStatusSchema,
		lifecycle: "trigger",
		mutates: false,
		budget: "status",
	},
	/** Search literals by value and scope. */
	findLiterals: {
		request: Literals,
		response: LiteralsResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Search comments and declaration links. */
	findComments: {
		request: Comments,
		response: CommentsResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Search document prose and headings. */
	findDocs: { request: Docs, response: DocsResultSchema, lifecycle: "query", mutates: false, budget: "read" },
	/** Values shared across files. */
	sharedLiterals: {
		request: Shared,
		response: SharedLiteralsResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Largest reference cycles first. */
	cycles: { request: Paged, response: z.array(CycleSchema), lifecycle: "query", mutates: false, budget: "read" },
	/** Symbols by incoming references. */
	mostReferenced: {
		request: Paged,
		response: MostReferencedResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Alias for `mostReferenced`. */
	hubs: { request: Paged, response: MostReferencedResultSchema, lifecycle: "query", mutates: false, budget: "read" },
	/** Cache hits and misses. */
	cacheStats: { request: Empty, response: CacheStatsSchema, lifecycle: "status", mutates: false, budget: "status" },
	/** Search declarations by name. */
	searchSymbols: {
		request: Search,
		response: SearchSymbolsResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Declarations in one module. */
	outlineModule: {
		request: ByModule,
		response: z.array(SymbolSummarySchema),
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Provider notes for one file. */
	fileNotes: { request: ByModule, response: FileNotesSchema, lifecycle: "query", mutates: false, budget: "read" },
	/** Claim and index status for one file. */
	moduleStatus: {
		request: ByModule,
		response: ModuleStatusSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** File status, hashes, and declarations. */
	moduleDeclarations: {
		request: ByModule,
		response: ModuleDeclarationsSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Stored paint facts for one module. */
	moduleFacts: {
		request: ByModule,
		response: ModuleFactsResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Paint facts for candidate text. */
	parseFacts: {
		request: ParseFacts,
		response: ParseFactsResultSchema,
		lifecycle: "probe",
		mutates: false,
		budget: "read",
	},
	/** Symbol under a source position. */
	symbolAt: { request: SymbolAt, response: SymbolAtReplySchema, lifecycle: "query", mutates: false, budget: "read" },
	/** Importers by specifier or module. */
	findImports: {
		request: FindImports,
		response: FindImportsResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Workspace coverage and largest modules. */
	overview: { request: Empty, response: OverviewResultSchema, lifecycle: "query", mutates: false, budget: "read" },
	/** Files changed with one module. */
	coChangedWith: {
		request: CoChange,
		response: CoChangedWithResultSchema,
		lifecycle: "probe",
		mutates: false,
		budget: "history",
	},
	/** Age and churn for one file. */
	fileHistory: {
		request: ByModule,
		response: FileHistorySchema,
		lifecycle: "probe",
		mutates: false,
		budget: "history",
	},
	/** Commits whose messages name a symbol. */
	commitsMentioning: {
		request: Mentions,
		response: CommitsMentioningResultSchema,
		lifecycle: "probe",
		mutates: false,
		budget: "history",
	},
	/** Citable facts for one symbol. */
	factsFor: {
		request: References,
		response: FactSetSchema.nullable(),
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Fact rows and unresolved ids. */
	resolveFacts: {
		request: ResolveFacts,
		response: ResolveFactsResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Save an answer with citations. */
	recordAnswer: {
		request: RecordAnswer,
		response: RecordOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "read",
	},
	/** Mark answers doubtful. */
	invalidateAnswer: {
		request: InvalidateAnswer,
		response: InvalidateOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "read",
	},
	/** Refresh evidence or clear doubt. */
	reaffirmAnswer: {
		request: ReaffirmAnswer,
		response: RecordOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "read",
	},
	/** Recorded answers and health. */
	recallAnswer: {
		request: RecallAnswer,
		response: RecallAnswerResultSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Rank answer gaps and doubts. */
	knowledgeGaps: {
		request: Gaps,
		response: KnowledgeGapsSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Question state across a declaration scope. */
	knowledgeScope: {
		request: KnowledgeScopeRequest,
		response: KnowledgeScopeSchema.nullable(),
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Explain an unresolved symbol id. */
	diagnoseSubject: {
		request: BySymbol,
		response: SubjectDiagnosisSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Resolved type for a symbol. */
	typeOf: { request: BySymbol, response: TypeInfoSchema, lifecycle: "query", mutates: false, budget: "read" },
	/** Rename impact, blockers, and warnings. */
	prepareRename: {
		request: Rename,
		response: RenamePlanSchema,
		lifecycle: "query",
		mutates: false,
		budget: "refactor",
	},
	/** Rename edits for external application. */
	renameEdits: {
		request: Rename,
		response: RenameEditPlanSchema,
		lifecycle: "query",
		mutates: false,
		budget: "refactor",
	},
	/** Move impact and blockers. */
	planMove: { request: Move, response: MovePlanSchema, lifecycle: "query", mutates: false, budget: "refactor" },
	previewMove: { request: Move, response: MovePreviewSchema, lifecycle: "query", mutates: false, budget: "refactor" },
	previewInsert: {
		request: Insert,
		response: InsertPreviewSchema,
		lifecycle: "query",
		mutates: false,
		budget: "refactor",
	},
	/** Reindex one file. */
	indexFile: { request: ByModule, response: IndexOutcomeSchema, lifecycle: "query", mutates: true, budget: "read" },
	/** Source text and range for a symbol. */
	symbolSource: {
		request: SymbolSource,
		response: SymbolSourceSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Open a refactor transaction. */
	refactorStart: {
		request: Empty,
		response: RefactorStartResultSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Refactor state and issues. */
	refactorStatus: {
		request: Empty,
		response: TransactionStatusSchema,
		lifecycle: "probe",
		mutates: false,
		budget: "status",
	},
	/** Snapshot a file before editing. */
	refactorTrack: {
		request: ByModule,
		response: RefactorTrackResultSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	refactorBeforeImage: {
		request: BeforeImage,
		response: RefactorBeforeImageSchema,
		lifecycle: "query",
		mutates: false,
		budget: "read",
	},
	/** Undo the newest step. */
	refactorUndo: {
		request: Unwind,
		response: RefactorUndoResultSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Restore tracked files and close. */
	refactorRevert: {
		request: Unwind,
		response: RefactorRevertResultSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Keep disk changes and close. */
	refactorCommit: {
		request: Commit,
		response: RefactorCommitResultSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Replace a symbol's full span. */
	refactorReplace: {
		request: Replace,
		response: ReplaceOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Replace an unchanged symbol span. */
	refactorReplaceSpan: {
		request: ReplaceSpan,
		response: ReplaceSpanOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Insert a declaration beside another. */
	refactorInsert: {
		request: Insert,
		response: InsertOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Rename symbols across the workspace. */
	refactorRename: {
		request: Rename,
		response: RenameStepOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
	/** Move declarations and rewrite imports. */
	refactorMove: {
		request: Move,
		response: MoveOutcomeSchema,
		lifecycle: "query",
		mutates: true,
		budget: "refactor",
	},
} as const satisfies Record<
	string,
	{
		request: z.ZodType;
		response: z.ZodType;
		lifecycle: Exclude<Lifecycle, "control">;
		mutates: boolean;
		budget: Exclude<Budget, "control">;
	}
>;

/** Daemon controls outside the service method table. */
export const DAEMON_CONTROLS = {
	/** Stop after replying. */
	shutdown: { lifecycle: "control", budget: "control" },
} as const satisfies Record<string, { lifecycle: "control"; budget: "control" }>;

/** Whether a lost request may have changed state. */
export function methodMutates(name: DaemonMethod): boolean {
	return DAEMON_METHODS[name].mutates;
}

/** Select an answer limit by method name. */
export function answerBudgetMs(name: string): number {
	if (isDaemonMethod(name)) return BUDGETS[DAEMON_METHODS[name].budget];
	if (Object.hasOwn(DAEMON_CONTROLS, name)) return BUDGETS[DAEMON_CONTROLS[name as DaemonControl].budget];
	return BUDGETS.read;
}

export type DaemonControl = keyof typeof DAEMON_CONTROLS;

/** Policy with a name narrowed to its owning table. */
export type RequestRule = LifecycleRule &
	(
		| { lifecycle: "control"; control: DaemonControl }
		| { lifecycle: Exclude<Lifecycle, "control">; method: DaemonMethod }
	);

/**
 * One policy for clients and both daemon paths; null for unknown names.
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
