// The core's public surface. Adapters take named symbols from here, never from the domain files.

// Re-exported because it names the answer of a core method. An adapter must not have to depend on
// the protocol package to spell the return type of something core hands it.
export type { SymbolKind, TypeInfo } from "@nyaa-lexicon/protocol";
export { type FileEdits, stageAll } from "./applyEdits.js";
export { type Clock, systemClock, type TimerHandle } from "./clock.js";
export { type DaemonOptions, type Handle, type RunningDaemon, type StartOutcome, startDaemon } from "./daemon.js";
export { DAEMON_USAGE, type DaemonArgs, type ParsedDaemonArgs, parseDaemonArgs } from "./daemonArgs.js";
export {
	type Diagnostics,
	DiagnosticsSchema,
	type Incident,
	listReports,
	type ReadDiagnostics,
	type ReportSummary,
	readDiagnostics,
	type SampleContext,
} from "./diagnosticFiles.js";
export {
	type Collector,
	type CollectorOptions,
	HEAP_SNAPSHOT_ENV,
	pruneReports,
	startDiagnostics,
} from "./diagnostics.js";
export { createDispatch, daemonHandlers } from "./dispatch.js";
export {
	CONFIG_FILE,
	collectScopeEvidence,
	describeScope,
	discoverSubmodules,
	type FileScope,
	type GeneratedReason,
	type GeneratedVerdict,
	type GitTracking,
	generatedVerdicts,
	includedFiles,
	type ScopeConfig,
	type ScopeConfigRead,
	scopeFor,
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
	type ReferenceUse,
	type SymbolSummary,
	type TypeHierarchy,
	type UsesFromResult,
} from "./indexReads.js";
export {
	coalesce,
	decideInvalidation,
	type FileEvent,
	type Invalidation,
	type InvalidationContext,
} from "./invalidation.js";
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
export { type EvidenceKind, type EvidenceView, PolicyEvidence, type PolicyEvidenceInput } from "./policyEvidence.js";
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
	PRUNE_AFTER_MS,
	type ProjectStore,
	type PrunedStore,
	pruneProjectStores,
	stampProjectStores,
	storeKeyFor,
} from "./projectStores.js";
export type { MethodRequest, MethodResponse, ProviderPort, ProviderStarter } from "./providerPort.js";
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
	type PolicyChange,
	type PolicyIndex,
	type PolicyJournal,
	type PolicyTrigger,
	SecretPolicy,
	type SecretPolicyConfig,
	type SecretPolicyInitialOptions,
	SecretPolicySnapshot,
} from "./secretPolicy.js";
export { LexiconService } from "./service.js";
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
	type AllowedView,
	fromText,
	MAX_SOURCE_BYTES,
	readSource,
	type SealedRead,
	type SourceReader,
	sourceReader,
	type ViewReader,
	type WritableSource,
	writableSource,
	writableText,
} from "./sourceRead.js";
export { SourceWorkspace, type SymbolSource } from "./sourceWorkspace.js";
export {
	type ContentCounts,
	type ContentTotals,
	type FileNote,
	type FileNotes,
	IndexStore,
	type ReplaceFileInput,
	SCHEMA_VERSION,
	type StoredDeclaration,
	type StoredFact,
	type StoredImport,
	type StoredLiteral,
	type StoredReference,
} from "./store.js";
export { type ProviderExit, type ProviderSpec, ProviderSupervisor } from "./supervisor.js";
export { Timings } from "./timings.js";
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
	type EventHasher,
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
