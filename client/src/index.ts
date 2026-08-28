// The client's public surface. Consumers take named symbols from here, never from the domain files.

// Re-exported because it names the answer of a client call. A consumer must not have to depend on
// the protocol package to spell the lock `findDaemon` or `ensureDaemon` hands it.
export type { DaemonLock } from "@nyaa-lexicon/protocol";
export { awaitIndexed, type IndexedAnswer } from "./awaitIndexed.js";
export { type ChainAnswer, type ChainCandidate, resolveChain } from "./chain.js";
export { type DaemonChannel, type DaemonChannelOptions, daemonChannel } from "./channel.js";
export { type ConnectOptions, connect, type Facade, type Session } from "./connect.js";
export {
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
} from "./discover.js";
export { type EnsureDaemonOptions, type EnsureResult, ensureDaemon, type Sleeper } from "./ensure.js";
export { DaemonError, Incompatible, NotInstalled } from "./errors.js";
export { installRecordFile, readInstallRecord, readInstallVersion, writeInstallRecord } from "./install.js";
export { decideFromLock, type LockContext, type LockDecision, newerBuild, type ReplaceCause } from "./lock.js";
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
	processIdentity,
	processMemory,
} from "./procfs.js";
export { BUN_FLOOR, type RuntimeVerdict, refuseRuntime, runtimeVerdict } from "./runtime.js";
export { type ShutdownWait, shutdownDaemon } from "./stop.js";
export {
	type ConnectFramesOptions,
	ConnectionLostError,
	connectFrames,
	DaemonStartingError,
	type FrameClient,
	lineSplitter,
	requestOnce,
	writeFrame,
} from "./transport.js";
