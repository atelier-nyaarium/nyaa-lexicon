// The long-lived indexer. Thin clients find it through the lock file and talk to it over
// localhost, so several agent sessions share one warm index instead of each building its own.
//
// The lock claim decides which of two racing daemons serves the workspace: the loser exits before
// ever opening the store, which is what holds the single-writer invariant DURING the race.
//
// Transport lives in socketTransport.ts; this file owns the claim and never touches a socket.

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { processIsAlive } from "./client.js";
import { type DaemonLock, DaemonLockSchema } from "./lockFile.js";
import { currentHost, type PlatformEnv, workspacePaths } from "./paths.js";
import { DaemonStartingError, type FrameServer, serveFrames } from "./socketTransport.js";
import { BUILD_VERSION } from "./version.js";

////////////////////////////////
//  Interfaces & Types

export type Handle = (method: string, params: unknown) => Promise<unknown>;

export interface DaemonOptions {
	workspaceRoot: string;
	/** Optional so the lock is claimed BEFORE the store opens; until it lands, requests get "starting". */
	handle?: Handle;
	host?: PlatformEnv;
	/** Fires with the connected-client count on every change. The lifetime signal. */
	onConnections?: (count: number) => void;
	/** Asked on every request that beats the handler; the client waits on this countdown. */
	startingNote?: () => { retryInMs: number; waitingFor: string };
	/** Test seams for the heartbeat; production uses the transport's defaults. */
	heartbeatMs?: number;
	missedLimit?: number;
}

export interface RunningDaemon {
	lock: DaemonLock;
	/** Installs the query handler. Until it is called, every request answers retryable "starting". */
	setHandle: (handle: Handle) => void;
	/** Authenticated clients connected right now. */
	connections: () => number;
	/** Removes the lock file and stops listening. Safe to call twice. */
	stop: () => Promise<void>;
}

/** Winning the claim is the only way to get a daemon; the loser exits without touching the store. */
export type StartOutcome = { claimed: true; daemon: RunningDaemon } | { claimed: false; reason: string };

////////////////////////////////
//  Constants

const TOKEN_BYTES = 24;
const CLAIM_ATTEMPTS = 4;

/** Patience given when no startingNote offers a real countdown. */
const DEFAULT_STARTING_ALLOWANCE_MS = 15_000;

////////////////////////////////
//  Functions & Helpers

/** The lock parsed if it resolves, or null when absent, unreadable, or not a lock at all. */
function readLock(lockFile: string): DaemonLock | null {
	let raw: string;
	try {
		raw = readFileSync(lockFile, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = DaemonLockSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Linked from a fully-written staging file, since a `wx` write has a create-then-fill gap where a
 * reader sees half a JSON and steals a live daemon's lock. A stale lock is stolen by rename. */
function claimLock(lockFile: string, lock: DaemonLock): { claimed: true } | { claimed: false; holder: DaemonLock } {
	mkdirSync(path.dirname(lockFile), { recursive: true });
	const staging = `${lockFile}.${process.pid}.claim`;
	writeFileSync(staging, JSON.stringify(lock, null, 2));

	try {
		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
			try {
				linkSync(staging, lockFile);
				return { claimed: true };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}

			const holder = readLock(lockFile);
			if (holder !== null && processIsAlive(holder.pid)) return { claimed: false, holder };

			const grave = `${lockFile}.${process.pid}.stale`;
			try {
				renameSync(lockFile, grave);
				rmSync(grave, { force: true });
			} catch {
				// Another contender stole it first; loop and contend on the link.
			}
		}
	} finally {
		rmSync(staging, { force: true });
	}

	// Losing every round means live contention each time; whoever kept winning holds the file now.
	const holder = readLock(lockFile);
	if (holder !== null) return { claimed: false, holder };
	throw new Error(`could not claim ${lockFile} after ${CLAIM_ATTEMPTS} attempts`);
}

////////////////////////////////
//  Starting

/** Port zero so two workspaces never contend, and a token so binding a port is safe on a shared box.
 * Binding precedes claiming because the lock carries the port. */
export async function startDaemon(options: DaemonOptions): Promise<StartOutcome> {
	const host = options.host ?? currentHost();
	const paths = workspacePaths(host, options.workspaceRoot);
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	const startedAt = Date.now();
	let handle = options.handle ?? null;
	let stopped = false;

	const server: FrameServer = await serveFrames({
		token,
		handle: async (method, params) => {
			if (handle === null) {
				const note = options.startingNote?.() ?? {
					retryInMs: Math.max(0, startedAt + DEFAULT_STARTING_ALLOWANCE_MS - Date.now()),
					waitingFor: "startup",
				};
				throw new DaemonStartingError(
					`the daemon is starting, waiting on ${note.waitingFor}`,
					note.retryInMs,
					note.waitingFor,
				);
			}
			return handle(method, params);
		},
		...(options.onConnections === undefined ? {} : { onConnections: options.onConnections }),
		...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
		...(options.missedLimit === undefined ? {} : { missedLimit: options.missedLimit }),
	});

	const lock = DaemonLockSchema.parse({
		port: server.port,
		token,
		pid: process.pid,
		protocolVersion: PROTOCOL_VERSION,
		buildVersion: BUILD_VERSION,
		workspaceRoot: options.workspaceRoot,
		startedAt: Date.now(),
	});

	const claim = claimLock(paths.lockFile, lock);
	if (!claim.claimed) {
		await server.close();
		return {
			claimed: false,
			reason: `pid ${claim.holder.pid} already serves ${claim.holder.workspaceRoot} on port ${claim.holder.port}`,
		};
	}

	async function stop(): Promise<void> {
		if (stopped) return;
		stopped = true;
		// Removed before the socket closes, so a client cannot read a lock naming a dead port. Only
		// OUR lock: a successor who stole a stale claim must not lose its file to the corpse it
		// replaced.
		if (readLock(paths.lockFile)?.token === token) rmSync(paths.lockFile, { force: true });
		await server.close();
	}

	return {
		claimed: true,
		daemon: {
			lock,
			setHandle: (next) => {
				handle = next;
			},
			connections: () => server.connections(),
			stop,
		},
	};
}
