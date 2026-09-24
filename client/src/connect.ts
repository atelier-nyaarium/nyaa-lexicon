// One call to reach lexicon: find the install, judge it, get its daemon, hand back a session.
//
// Three versions stay apart here: this client's protocol, the install's, and the running daemon's.
// A known install is judged before any lock is read, and the lock is judged against the INSTALL's
// identity, never this package's, since a consumer bundles the client and not the daemon. With no
// install known, a live daemon serving this client's protocol is ridden, never spawned or retired.

import {
	DAEMON_METHODS,
	type DaemonLock,
	type DaemonMethod,
	defined,
	type InstallVersion,
	PROTOCOL_VERSION,
	parseVersion,
	type RequestOf,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { awaitIndexed, type IndexedAnswer } from "./awaitIndexed.js";
import { type ChainAnswer, resolveChain } from "./chain.js";
import { daemonChannel } from "./channel.js";
import type { DaemonRef } from "./daemonRef.js";
import { bundleStamp, type DaemonSource, findDaemon } from "./discover.js";
import { ensureDaemon, ensureFailure } from "./ensure.js";
import { DaemonError, Incompatible, NotInstalled } from "./errors.js";
import { INSTALL_SETTLE_MS, newestInstallBeside, readInstallRecord, readInstallVersion } from "./install.js";
import { currentHost, type PlatformEnv, workspacePaths } from "./paths.js";
import { shutdownDaemon, shutdownRef } from "./stop.js";

////////////////////////////////
//  Interfaces & Types

export interface ConnectOptions {
	workspaceRoot: string;
	/** A store directory of the caller's choosing; the default is derived from the workspace. */
	stateDir?: string;
	/** The install to use, instead of the one last recorded. */
	lexiconRoot?: string;
	/** How long a request waits on a starting daemon, in milliseconds. Zero asks once. */
	patience?: number;
	onWaiting?: (event: { waitingFor: string; retryInMs: number; elapsedMs: number }) => void;
	/** The caller's own bun. An OS bun spawns a daemon only when at least as new. */
	bundledBun?: string;
	/** False only attaches. True lets the connect and any ask but a status read start one. */
	start?: boolean;
	/** Aborts with `closed`; prevents later retirement, signalling or spawning. */
	signal?: AbortSignal;
}

/** Every daemon method as a typed call. Mapped from the table, so its JSDoc reaches hover. */
export type Facade = { [M in DaemonMethod]: (params: RequestOf<M>) => Promise<ResponseOf<M>> };

export interface Session extends Facade {
	/** The method by name, for a caller holding the name rather than the call. */
	ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>>;
	/** Closes the session; the daemon keeps running.
	 * Later asks fail closed without reconnect; sent writes report unknown outcomes. */
	close(): void;
	/** Closes the session and waits for shutdown. `from` skips daemons gone or replaced. */
	stopDaemon(from?: DaemonRef): Promise<void>;
	/** The lock of the daemon this session reaches. */
	lock: () => DaemonLock;
	/** A name chain inside one module: exact, ambiguous, or none with the reason. */
	resolveChain(module: string, segments: string[]): Promise<ChainAnswer>;
	/** Indexes one module now, or says why nothing will. */
	awaitIndexed(module: string): Promise<IndexedAnswer>;
}

////////////////////////////////
//  Functions & Helpers

/** The client's three classes pass; anything else was the daemon's, or the wire's, and is wrapped. */
function asDaemonError(error: unknown): Error {
	if (error instanceof NotInstalled || error instanceof Incompatible || error instanceof DaemonError) return error;
	return new DaemonError(error instanceof Error ? error.message : String(error), "connectionLost");
}

/** The record's root, or the newest settled install beside it, so an older or removed version the
 * record still names gives way to the release installed next to it. */
function recordedRoot(host: PlatformEnv): string | undefined {
	const recorded = readInstallRecord(host)?.root;
	if (recorded === undefined) return undefined;
	return newestInstallBeside(recorded, Date.now() - INSTALL_SETTLE_MS)?.root ?? recorded;
}

/** An explicit root wins; otherwise the record's. Either is trusted only as far as its version file. */
function locateInstall(
	options: ConnectOptions,
	host: PlatformEnv,
): { root: string; version: InstallVersion } | NotInstalled {
	const root = options.lexiconRoot ?? recordedRoot(host);
	if (root === undefined) return new NotInstalled("no lexicon is installed here");

	const version = bundleStamp(root) === null ? null : readInstallVersion(root);
	if (version === null) {
		return new NotInstalled(
			options.lexiconRoot === undefined
				? `not where lexicon was last seen: ${root}`
				: `no lexicon install under ${root}`,
			root,
		);
	}
	return { root, version };
}

/** A client ahead of the install would ask for a table the install has never heard of. Behind it rides forward. */
function refuseAhead(root: string, installed: string): void {
	const us = parseVersion(PROTOCOL_VERSION);
	const them = parseVersion(installed);
	if (us !== null && them !== null && us.major <= them.major) return;
	throw new Incompatible(
		`this client speaks protocol ${PROTOCOL_VERSION}, the install at ${root} speaks ${installed}`,
		PROTOCOL_VERSION,
		installed,
	);
}

/**
 * Reach the workspace's daemon, starting the install's only if needed and `start` allows.
 *
 * Every failure is `NotInstalled`, `Incompatible` or `DaemonError`. The socket itself opens on the
 * first question, then reopens once after a drop. A status read never starts a daemon on reconnect.
 */
export async function connect(options: ConnectOptions): Promise<Session> {
	const { workspaceRoot } = options;
	const host = currentHost();

	// Resolved on every use, since a handover or an update can move the install under a session.
	const source = (): DaemonSource | NotInstalled => {
		const current = locateInstall(options, currentHost());
		if (current instanceof NotInstalled) return current;
		refuseAhead(current.root, current.version.protocolVersion);
		return {
			root: current.root,
			buildVersion: current.version.buildVersion,
			bundleStamp: bundleStamp(current.root),
		};
	};
	const known = (): DaemonSource | null => {
		const current = source();
		return current instanceof NotInstalled ? null : current;
	};
	const stateDir = options.stateDir === undefined ? {} : { stateDir: options.stateDir };
	const aborted = () => new DaemonError(`connecting to ${workspaceRoot} was aborted`, "closed");
	const daemon = await ensureDaemon({
		workspaceRoot,
		source,
		mode: options.start === false ? "attach" : "start",
		...stateDir,
		...defined({ onWaiting: options.onWaiting, bundledBun: options.bundledBun, signal: options.signal }),
	}).catch((error: unknown) => {
		if (options.signal?.aborted) throw aborted();
		throw asDaemonError(error);
	});
	// An abort that landed while the lock was read still wins.
	if (options.signal?.aborted) throw aborted();
	if (!daemon.connected) throw ensureFailure(daemon);

	let lock = daemon.lock;
	const lockFile = workspacePaths(host, workspaceRoot, options.stateDir).lockFile;
	const channelOptions = {
		workspaceRoot,
		source,
		...stateDir,
		...defined({
			patience: options.patience,
			onWaiting: options.onWaiting,
			bundledBun: options.bundledBun,
			start: options.start,
		}),
	};
	const channel = daemonChannel(channelOptions);

	async function ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>> {
		try {
			return await channel.ask(method, params);
		} catch (error) {
			throw asDaemonError(error);
		}
	}

	// Cast once, so every method exists with no hand-written member to fall behind the table.
	const calls: Record<string, (params: never) => Promise<unknown>> = {};
	for (const method of Object.keys(DAEMON_METHODS) as DaemonMethod[]) {
		calls[method] = (params) => ask(method, params);
	}

	return Object.assign(calls as Facade, {
		ask,
		close: () => channel.close(),
		// Re-read, since a handover replaces the daemon under a session that keeps working.
		lock: () => {
			const now = findDaemon(workspaceRoot, known(), host, options.stateDir);
			if (now.action === "connect") lock = now.lock;
			return lock;
		},
		stopDaemon: async (from?: DaemonRef) => {
			if (from !== undefined) {
				channel.close();
				await shutdownRef(from, lockFile);
				return;
			}
			// The install is judged before the channel closes, so a refusal leaves the session whole.
			const current = findDaemon(workspaceRoot, known(), host, options.stateDir);
			if (current.action === "connect") lock = current.lock;
			// Closed before the stop, or the channel would reconnect to a daemon on its way out.
			channel.close();
			await shutdownDaemon(lock, lockFile);
		},
		resolveChain: (module: string, segments: string[]) => resolveChain({ ask }, module, segments),
		awaitIndexed: (module: string) => awaitIndexed({ ask }, module),
	});
}
