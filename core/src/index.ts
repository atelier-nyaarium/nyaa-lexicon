// The core's public surface. Adapters take named symbols from here, never from the domain files.

// Re-exported because it names the answer of a core method. An adapter must not have to depend on
// the protocol package to spell the return type of something core hands it.
export type { SymbolKind, TypeInfo } from "@nyaa-lexicon/protocol";
export {
	type Answer,
	type Doubt,
	isQuestionClass,
	MAX_PROSE,
	QUESTION_CLASSES,
	type QuestionClass,
	type RecalledAnswer,
	type RecordOutcome,
} from "./answers.js";
export { type ApplyOutcome, type FileEdits, writeAll } from "./applyEdits.js";
export { type Clock, systemClock, type TimerHandle } from "./clock.js";
export { type DaemonOptions, type Handle, type RunningDaemon, type StartOutcome, startDaemon } from "./daemon.js";
export { DAEMON_USAGE, type DaemonArgs, type ParsedDaemonArgs, parseDaemonArgs } from "./daemonArgs.js";
export {
	type Collector,
	type CollectorOptions,
	type Diagnostics,
	DiagnosticsSchema,
	enableSelfReports,
	HEAP_SNAPSHOT_ENV,
	HIGH_WATER_SIGNAL,
	type Incident,
	listReports,
	type NodeReportSetup,
	nodeReportSetup,
	pruneReports,
	type ReadDiagnostics,
	type ReportSummary,
	readDiagnostics,
	type SampleContext,
	startDiagnostics,
} from "./diagnostics.js";
export { createDispatch, daemonHandlers } from "./dispatch.js";
export {
	CONFIG_FILE,
	describeScope,
	type FileScope,
	fileScopeFor,
	generatedFiles,
	gitFiles,
	globToRegExp,
	includedFiles,
	readScopeConfig,
	type ScopeConfig,
} from "./fileScope.js";
export { storeCompatibilityKey } from "./fingerprint.js";
export { type Cycle, type Edge, findCycles } from "./graph.js";
export {
	type CoChange,
	type Commit,
	coChangesFor,
	commitsMentioning,
	DEFAULT_DEPTH,
	DEFAULT_MENTION_LIMIT,
	DEFAULT_WIDTH_LIMIT,
	type FileChange,
	type FileHistory,
	type FileHistoryCommit,
	fileHistoryFor,
	filesOf,
	type HistoryReport,
	type Mention,
	readHistory,
} from "./history.js";
export { type IndexOutcome, type IndexStatus, WorkspaceIndexer } from "./indexer.js";
export {
	type AnswerTier,
	type CallHierarchy,
	type CallHierarchyEdge,
	type CommentAnchor,
	type CommentQuery,
	type CommentsResult,
	DEFAULT_COMMENT_LIMIT,
	DEFAULT_LITERAL_LIMIT,
	DEFAULT_REFERENCE_LIMIT,
	type DescribeResult,
	type DocQuery,
	type DocsResult,
	type FoundComment,
	type FoundDoc,
	type GraphSummary,
	IndexReadModel,
	type LiteralQuery,
	type LiteralsResult,
	REGEX_SCAN_LIMIT,
	type ReferencesResult,
	type SymbolSummary,
	type TypeHierarchy,
} from "./indexReads.js";
export {
	coalesce,
	decideInvalidation,
	type FileEvent,
	type Invalidation,
	type InvalidationContext,
} from "./invalidation.js";
export {
	type CitedFact,
	DEFAULT_FACT_LIMIT,
	DEFAULT_GAP_LIMIT,
	type FactSet,
	type GapRow,
	INLINE_GAP_THRESHOLD,
	type InvalidateOutcome,
	type KnowledgeGaps,
	KnowledgeLedger,
} from "./knowledge.js";
export { DEFAULT_LINGER_MS, type Linger, type LingerOptions, lingerWhileEmpty } from "./lifetime.js";
export { ownSource } from "./ownSource.js";
export {
	type Count,
	type Counted,
	type CountReason,
	type Paged,
	pageCounted,
	pageProbed,
	pageScanned,
	wire,
} from "./paging.js";
export {
	type AdmitVerdict,
	findProject,
	forgetProject,
	type RegisteredProject,
	type RegisterOutcome,
	readRegistry,
	registerProject,
	sameStore,
} from "./projectRegistry.js";
export {
	type DeleteOutcome,
	deleteProjectStore,
	findProjectStore,
	listProjectStores,
	type ProjectStore,
	storeKeyFor,
} from "./projectStores.js";
export {
	describeStart,
	discoverProviders,
	lexiconRoot,
	type ProviderCommand,
	type StartOptions,
	type StartReport,
	startProviders,
} from "./providers.js";
export {
	type MoveEditsOutcome,
	type MovePlan,
	RefactorPlanner,
	type RenameConcern,
	type RenameEditPlan,
	type RenameFile,
	type RenamePlan,
	type ReplacementPlan,
} from "./refactorPlanner.js";
export { type QueueStats, RequestQueue } from "./requestQueue.js";
export { type CacheStats, ResultCache } from "./resultCache.js";
export {
	modulesFor,
	type ProviderClaims,
	type Route,
	type RoutingContext,
	routeModule,
	routingContextOf,
} from "./routing.js";
export { compileSearchRegex, type SearchPattern, searchTerm } from "./search.js";
export {
	LexiconService,
	type RenameOutcome,
} from "./service.js";
export {
	type BindOutcome,
	createSessionBinds,
	type ProjectRename,
	type SessionBinds,
	type SessionProject,
	type SessionSyncOutcome,
	storeIdentity,
} from "./sessionBinds.js";
export { type FrameServer, serveFrames } from "./socketTransport.js";
export {
	fromText,
	MAX_SOURCE_BYTES,
	readSource,
	type SourceRead,
	type SourceReader,
	sourceReader,
	textOf,
} from "./sourceRead.js";
export { SourceWorkspace, type SymbolSource } from "./sourceWorkspace.js";
export {
	type ContentCounts,
	type ContentTotals,
	type FileNote,
	type FileNotes,
	IndexStore,
	SCHEMA_VERSION,
	type StoredDeclaration,
	type StoredFact,
	type StoredImport,
	type StoredLiteral,
	type StoredReference,
} from "./store.js";
export { type ProviderExit, type ProviderSpec, ProviderSupervisor } from "./supervisor.js";
export {
	type FileImage,
	type ImageScope,
	type RefactorIssue,
	type StepKind,
	type StepPhase,
	TransactionManager,
	type TransactionStatus,
	type TransactionStep,
} from "./transactions.js";
export {
	hashContent,
	isIgnored,
	type RunningWatcher,
	readEvent,
	toModule,
	type WatchOptions,
	watchWorkspace,
} from "./watcher.js";
export {
	type Admission,
	admitStateDir,
	admitWorkspace,
	currentOwner,
	type DirectoryOwner,
} from "./workspaceAdmission.js";
export { type GateStats, WorkspaceGate } from "./workspaceGate.js";
