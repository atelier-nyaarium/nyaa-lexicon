// The core's public surface. Adapters take named symbols from here, never from the domain files.

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
export { type ApplyOutcome, applyEdits, type FileEdits, writeAll } from "./applyEdits.js";
export { callDaemon, findDaemon, processIsAlive } from "./client.js";
export { type DaemonOptions, type Handle, type RunningDaemon, type StartOutcome, startDaemon } from "./daemon.js";
export { createDispatch } from "./dispatch.js";
export { daemonCommand, type EnsureResult, ensureDaemon } from "./ensureDaemon.js";
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
export { indexerFingerprint } from "./fingerprint.js";
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
	fileHistoryFor,
	filesOf,
	type HistoryReport,
	type Mention,
	readHistory,
} from "./history.js";
export {
	coalesce,
	decideInvalidation,
	type FileEvent,
	type Invalidation,
	type InvalidationContext,
} from "./invalidation.js";
export { DEFAULT_LINGER_MS, type Linger, type LingerOptions, lingerWhileEmpty } from "./lifetime.js";
export { type DaemonLock, DaemonLockSchema, decideFromLock, type LockDecision } from "./lockFile.js";
export { currentHost, type PlatformEnv, stateRoot, workspaceKey, workspacePaths } from "./paths.js";
export {
	findProject,
	forgetProject,
	type RegisteredProject,
	type RegisterOutcome,
	readRegistry,
	registerProject,
} from "./projectRegistry.js";
export {
	type DeleteOutcome,
	deleteProjectStore,
	listProjectStores,
	type ProjectStore,
	storeKeyFor,
} from "./projectStores.js";
export {
	describeStart,
	discoverProviders,
	lexiconRoot,
	type ProviderCommand,
	type StartReport,
	startProviders,
} from "./providers.js";
export { type QueueStats, RequestQueue } from "./requestQueue.js";
export { type CacheStats, ResultCache } from "./resultCache.js";
export { modulesFor, type ProviderClaims, type Route, routeModule } from "./routing.js";
export {
	type AnswerTier,
	type CallHierarchy,
	type CallHierarchyEdge,
	type CitedFact,
	DEFAULT_FACT_LIMIT,
	DEFAULT_REFERENCE_LIMIT,
	type DescribeResult,
	type FactSet,
	type GapRow,
	type GraphSummary,
	INLINE_GAP_THRESHOLD,
	type IndexOutcome,
	type IndexStatus,
	type InvalidateOutcome,
	type KnowledgeGaps,
	LexiconService,
	type LiteralQuery,
	type LiteralsResult,
	type ReferencesResult,
	type RenameConcern,
	type RenameFile,
	type RenameOutcome,
	type RenamePlan,
	type SymbolSummary,
	type TypeHierarchy,
} from "./service.js";
export {
	type BindOutcome,
	createSessionBinds,
	type ProjectRename,
	type SessionBinds,
	type SessionProject,
	type SessionSyncOutcome,
} from "./sessionBinds.js";
export {
	ConnectionLostError,
	connectFrames,
	DaemonStartingError,
	type FrameClient,
	type FrameServer,
	requestOnce,
	serveFrames,
} from "./socketTransport.js";
export {
	IndexStore,
	SCHEMA_VERSION,
	type StoredDeclaration,
	type StoredFact,
	type StoredImport,
	type StoredLiteral,
	type StoredReference,
} from "./store.js";
export { type ProviderSpec, ProviderSupervisor } from "./supervisor.js";
export {
	hashContent,
	isIgnored,
	type RunningWatcher,
	readEvent,
	toModule,
	type WatchOptions,
	watchWorkspace,
} from "./watcher.js";
export { type Admission, admitWorkspace } from "./workspaceAdmission.js";
