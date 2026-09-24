// The long-lived indexer. Thin clients find it through the lock file and talk to it over
// localhost, so several agent sessions share one warm index instead of each building its own.
//
// The lock claim decides which of two racing daemons serves the workspace: the loser exits before
// ever opening the store, which is what holds the single-writer invariant DURING the race.
//
// Transport lives in socketTransport.ts and the claim in daemonLock.ts; this file never touches a socket.

import {
	canonicalRoot,
	currentHost,
	DaemonStartingError,
	lockHolderAlive,
	type PlatformEnv,
	workspacePaths,
} from "@nyaa-lexicon/client";
import {
	DAEMON_STOPPING_MESSAGE,
	type DaemonLock,
	DaemonLockSchema,
	defined,
	type LockRole,
	PROTOCOL_VERSION,
} from "@nyaa-lexicon/protocol";
import { type Clock, systemClock } from "./clock.js";
import { claimLock, holderIdentity, mintToken, readLock, releaseLock } from "./daemonLock.js";
import { ownSource } from "./ownSource.js";
import { type FrameServer, serveFrames } from "./socketTransport.js";

////////////////////////////////
//  Interfaces & Types

export type Handle = (method: string, params: unknown) => Promise<unknown>;

export interface DaemonOptions {
	workspaceRoot: string;
	/** A store directory of the caller's choosing; the default is derived from the workspace. */
	stateDir?: string;
	/** Optional so the lock is claimed BEFORE the store opens; until it lands, requests get "starting". */
	handle?: Handle;
	host?: PlatformEnv;
	/** Fires with the connected-client count on every change. The lifetime signal. */
	onConnections?: (count: number) => void;
	/** Called before the handler.
	 * The client waits on this countdown. */
	startingNote?: (method: string) => { retryInMs: number; waitingFor: string };
	/** Once, when a request finds the lock gone or taken; the daemon has already refused it. */
	onLockLost?: (reason: string) => void;
	/** Test seams for the heartbeat; production uses the transport's defaults. */
	heartbeatMs?: number;
	missedLimit?: number;
	/** The daemon's one time source: the startup allowance, the lock stamp and the transport's timers. */
	clock?: Clock;
}

export interface RunningDaemon {
	lock: DaemonLock;
	/** Installs the query handler. Until it is called, every request answers retryable "starting". */
	setHandle: (handle: Handle) => void;
	/** Authenticated clients connected right now. */
	connections: () => number;
	/** Still this process's lock on disk: false once removed or taken by a successor. */
	holdsLock: () => boolean;
	/** Removes the lock file and stops listening. Safe to call twice. */
	stop: () => Promise<void>;
}

/** Winning the claim is the only way to get a daemon; the loser exits without touching the store.
 * `stolenRole` is `"delete"` only when the claim stole a dead delete's lock. */
export type StartOutcome =
	| { claimed: true; daemon: RunningDaemon; stolenRole?: LockRole }
	| { claimed: false; reason: string };

////////////////////////////////
//  Constants

/** Patience given when no startingNote offers a real countdown. */
const DEFAULT_STARTING_ALLOWANCE_MS = 15_000;

////////////////////////////////
//  Starting

/** Port zero so two workspaces never contend, and a token so binding a port is safe on a shared box.
 * Binding precedes claiming because the lock carries the port. */
export async function startDaemon(options: DaemonOptions): Promise<StartOutcome> {
	const host = options.host ?? currentHost();
	// The one derivation: the claim, the loss check and the release all read this lock file.
	const paths = workspacePaths(host, options.workspaceRoot, options.stateDir);
	const token = mintToken();
	const clock = options.clock ?? systemClock;
	const startedAt = clock.now();
	let handle = options.handle ?? null;
	let stopped = false;
	let lockLost: string | null = null;
	let announceLoss = options.onLockLost;

	// Null while held; read per request.
	function lostLock(): string | null {
		const current = readLock(paths.lockFile);
		if (current === null) return "the workspace lock is gone, as when its state directory is removed";
		if (current.token !== token) return `the workspace lock now names pid ${current.pid}`;
		return null;
	}

	const server: FrameServer = await serveFrames({
		token,
		handle: async (method, params) => {
			if (handle === null) {
				const note = options.startingNote?.(method) ?? {
					retryInMs: Math.max(0, startedAt + DEFAULT_STARTING_ALLOWANCE_MS - clock.now()),
					waitingFor: "startup",
				};
				throw new DaemonStartingError(
					`the daemon is starting, waiting on ${note.waitingFor}`,
					note.retryInMs,
					note.waitingFor,
				);
			}
			// Never answer from a lost store. Closing drops every client onto its reconnect path.
			lockLost ??= lostLock();
			if (lockLost !== null) {
				announceLoss?.(lockLost);
				announceLoss = undefined;
				void server.close();
				// Longer than DAEMON_STOPPING_MESSAGE on purpose: a client must never read this as the
				// same wait a retiring daemon's refusal gets, only an exact match may.
				throw new Error(`${lockLost}; ${DAEMON_STOPPING_MESSAGE}`);
			}
			return handle(method, params);
		},
		...defined({
			onConnections: options.onConnections,
			heartbeatMs: options.heartbeatMs,
			missedLimit: options.missedLimit,
		}),
		clock,
	});

	const source = ownSource();
	const lock = DaemonLockSchema.parse({
		port: server.port,
		token,
		...holderIdentity(),
		protocolVersion: PROTOCOL_VERSION,
		buildVersion: source.buildVersion,
		...(source.bundleStamp === null ? {} : { bundleStamp: source.bundleStamp }),
		workspaceRoot: canonicalRoot(options.workspaceRoot),
		startedAt: clock.now(),
		role: "daemon",
	});

	const claim = claimLock(paths.lockFile, lock, lockHolderAlive);
	if (!claim.claimed) {
		await server.close();
		return {
			claimed: false,
			reason:
				claim.holder.role === "delete"
					? `pid ${claim.holder.pid} is deleting ${claim.holder.workspaceRoot} right now`
					: `pid ${claim.holder.pid} already serves ${claim.holder.workspaceRoot} on port ${claim.holder.port}`,
		};
	}

	async function stop(): Promise<void> {
		if (stopped) return;
		stopped = true;
		// Removed before the socket closes, so a client cannot read a lock naming a dead port.
		releaseLock(paths.lockFile, token);
		await server.close();
	}

	return {
		claimed: true,
		...(claim.stolenRole === undefined ? {} : { stolenRole: claim.stolenRole }),
		daemon: {
			lock,
			setHandle: (next) => {
				handle = next;
			},
			connections: () => server.connections(),
			holdsLock: () => lostLock() === null,
			stop,
		},
	};
}
