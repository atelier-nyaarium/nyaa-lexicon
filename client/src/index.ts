// The client's public surface. Consumers take named symbols from here, never from the domain files.

// Re-exported because it names the answer of a client call. A consumer must not have to depend on
// the protocol package to spell the lock `findDaemon` or `ensureDaemon` hands it.
export type { DaemonLock } from "@nyaa-lexicon/protocol";
export { awaitIndexed, type IndexedAnswer } from "./awaitIndexed.js";
export { type ChainAnswer, type ChainCandidate, resolveChain } from "./chain.js";
export { type DaemonChannel, type DaemonChannelOptions, daemonChannel } from "./channel.js";
export { type ConnectOptions, connect, type Facade, type Session } from "./connect.js";
export type { DaemonRef } from "./daemonRef.js";
export { beforeDeadline, unlessAborted } from "./deadline.js";
export {
	bundleFiles,
	bundleStamp,
	callDaemon,
	type DaemonSource,
	daemonCommand,
	findDaemon,
	lockHolderAlive,
	processIsAlive,
	type RetireOptions,
	retire,
	type SpawnWatch,
	spawnDaemonProcess,
	stoppingRefusal,
	warmupFailed,
} from "./discover.js";
export {
	type EnsureDaemonOptions,
	type EnsureMode,
	type EnsureResult,
	ensureDaemon,
	type InstallSource,
	type Sleeper,
} from "./ensure.js";
export { DaemonError, type DaemonErrorDetails, Incompatible, NotInstalled } from "./errors.js";
export {
	bundlesSettled,
	INSTALL_SETTLE_MS,
	type InstallBeside,
	installRecordFile,
	newestInstallBeside,
	readInstallRecord,
	readInstallVersion,
	writeInstallRecord,
} from "./install.js";
export { bunCommand, RUNTIME_BUNFIG, RUNTIME_TSCONFIG } from "./launch.js";
export {
	decideFromLock,
	isRelease,
	type LockContext,
	type LockDecision,
	newerBuild,
	type ReplaceCause,
} from "./lock.js";
export {
	canonicalRoot,
	currentHost,
	type PlatformEnv,
	stateRoot,
	storePaths,
	workspaceKey,
	workspacePaths,
} from "./paths.js";
export {
	type HostMemory,
	hostMemory,
	type ProcessIdentity,
	type ProcessMemory,
	parseMeminfo,
	parseProcStat,
	parseProcStatus,
	processesMatching,
	processIdentity,
	processMemory,
} from "./procfs.js";
export {
	BUN_FLOOR,
	type BunExecutable,
	bunExecutable,
	type RuntimeVerdict,
	refuseRuntime,
	runtimeProblem,
	runtimeVerdict,
} from "./runtime.js";
export {
	requestShutdown,
	type ShutdownOutcome,
	type ShutdownWait,
	shutdownDaemon,
	shutdownRef,
} from "./stop.js";
export {
	type ConnectFramesOptions,
	ConnectionLostError,
	connectFrames,
	DaemonStartingError,
	DaemonStoppingError,
	type FrameClient,
	lineSplitter,
	notifyWaiting,
	requestOnce,
	type WaitingCallback,
	type WaitingEvent,
	writeFrame,
} from "./transport.js";
export { CLIENT_BUILD_VERSION } from "./version.js";
export { classifyWorkspaceRoot, type WorkspaceAdmission } from "./workspaceAdmission.js";
