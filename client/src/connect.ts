// One call to reach lexicon: find the install, judge it, get its daemon, hand back a session.
//
// Three versions stay apart here: this client's protocol, the install's, and the running daemon's.
// The install is judged before any lock is read, and the lock is judged against the INSTALL's
// identity, never this package's, since a consumer bundles the client and not the daemon.

import {
	DAEMON_METHODS,
	type DaemonLock,
	type DaemonMethod,
	type InstallVersion,
	PROTOCOL_VERSION,
	parseVersion,
	type RequestOf,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { awaitIndexed, type IndexedAnswer } from "./awaitIndexed.js";
import { type ChainAnswer, resolveChain } from "./chain.js";
import { daemonChannel } from "./channel.js";
import { bundleStamp, type DaemonSource, findDaemon } from "./discover.js";
import { ensureDaemon, ensureFailure } from "./ensure.js";
import { DaemonError, Incompatible, NotInstalled } from "./errors.js";
import { readInstallRecord, readInstallVersion } from "./install.js";
import { currentHost, type PlatformEnv, workspacePaths } from "./paths.js";
import { shutdownDaemon } from "./stop.js";

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
}

/** Every daemon method as a typed call. Mapped from the table, so its JSDoc reaches hover. */
export type Facade = { [M in DaemonMethod]: (params: RequestOf<M>) => Promise<ResponseOf<M>> };

export interface Session extends Facade {
	/** The method by name, for a caller holding the name rather than the call. */
	ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>>;
	/** Drops this session's connection; the daemon stays up for whoever else holds one. */
	close(): void;
	/** Asks the daemon to stop and waits for its lock to go. */
	stopDaemon(): Promise<void>;
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

/** An explicit root wins; otherwise the record's. Either is trusted only as far as its version file. */
function locateInstall(options: ConnectOptions, host: PlatformEnv): { root: string; version: InstallVersion } {
	const root = options.lexiconRoot ?? readInstallRecord(host)?.root;
	if (root === undefined) throw new NotInstalled("no lexicon is installed here");

	const version = bundleStamp(root) === null ? null : readInstallVersion(root);
	if (version === null) {
		throw new NotInstalled(
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
 * Reach the workspace's daemon, starting the install's if there is none.
 *
 * Every failure is `NotInstalled`, `Incompatible` or `DaemonError`. The socket itself opens on the
 * first question, and reopens once if it drops.
 */
export async function connect(options: ConnectOptions): Promise<Session> {
	const { workspaceRoot } = options;
	const host = currentHost();
	const install = locateInstall(options, host);
	refuseAhead(install.root, install.version.protocolVersion);

	const source = (): DaemonSource => {
		const current = locateInstall(options, currentHost());
		refuseAhead(current.root, current.version.protocolVersion);
		return {
			root: current.root,
			buildVersion: current.version.buildVersion,
			bundleStamp: bundleStamp(current.root),
		};
	};
	const stateDir = options.stateDir === undefined ? {} : { stateDir: options.stateDir };
	const daemon = await ensureDaemon({
		workspaceRoot,
		source,
		...stateDir,
		...(options.onWaiting === undefined ? {} : { onWaiting: options.onWaiting }),
	}).catch((error: unknown) => {
		throw asDaemonError(error);
	});
	if (!daemon.connected) throw ensureFailure(daemon);

	let lock = daemon.lock;
	const lockFile = workspacePaths(host, workspaceRoot, options.stateDir).lockFile;
	const channelOptions = {
		workspaceRoot,
		source,
		...stateDir,
		...(options.patience === undefined ? {} : { patience: options.patience }),
		...(options.onWaiting === undefined ? {} : { onWaiting: options.onWaiting }),
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
			const now = findDaemon(workspaceRoot, source(), host, options.stateDir);
			if (now.action === "connect") lock = now.lock;
			return lock;
		},
		stopDaemon: async () => {
			// The install is judged before the channel closes, so a refusal leaves the session whole.
			const current = findDaemon(workspaceRoot, source(), host, options.stateDir);
			if (current.action === "connect") lock = current.lock;
			// Closed before the stop, or the channel would reconnect to a daemon on its way out.
			channel.close();
			await shutdownDaemon(lock, lockFile);
		},
		resolveChain: (module: string, segments: string[]) => resolveChain({ ask }, module, segments),
		awaitIndexed: (module: string) => awaitIndexed({ ask }, module),
	});
}
