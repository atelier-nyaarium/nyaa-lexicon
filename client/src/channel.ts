// One persistent daemon connection, reconnected rather than reported.
//
// The open connection is how the daemon counts who is still here.

import {
	DAEMON_METHODS,
	type DaemonMethod,
	defined,
	methodMutates,
	type RequestOf,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { ensureDaemon, ensureFailure, type InstallSource } from "./ensure.js";
import { DaemonError } from "./errors.js";
import { ConnectionLostError, connectFrames, type FrameClient } from "./transport.js";

////////////////////////////////
//  Interfaces & Types

export interface DaemonChannelOptions {
	workspaceRoot: string;
	/** Where a daemon is spawned from, and what a found lock is judged against. */
	source: InstallSource;
	/** A store directory of the caller's choosing; the default is derived from the workspace. */
	stateDir?: string;
	/** How long a request waits on a starting daemon, in milliseconds. Zero asks once. */
	patience?: number;
	onWaiting?: (event: { waitingFor: string; retryInMs: number; elapsedMs: number }) => void;
	/** The caller's own bun, for daemons it spawns. */
	bundledBun?: string;
}

export interface DaemonChannel {
	/** Reconnects once if the connection died. */
	ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>>;
	close(): void;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Connected lazily, so a handshake never waits on spawning a daemon.
 *
 * One retry, not a loop: retrying forever looks like a hang.
 */
export function daemonChannel(options: DaemonChannelOptions): DaemonChannel {
	const { workspaceRoot } = options;
	let client: FrameClient | null = null;
	// Concurrent asks share connection.
	let connecting: Promise<FrameClient> | null = null;
	let closed = false;
	const closedError = () => new DaemonError(`the session for ${workspaceRoot} is closed`, "closed");

	async function open(): Promise<FrameClient> {
		const daemonOptions = {
			workspaceRoot,
			source: options.source,
			...defined({
				stateDir: options.stateDir,
				onWaiting: options.onWaiting,
				bundledBun: options.bundledBun,
			}),
		};
		const daemon = await ensureDaemon(daemonOptions);
		if (closed) throw closedError();
		if (!daemon.connected) throw ensureFailure(daemon, `no indexer for ${workspaceRoot}: `);
		const frameOptions = {
			...defined({ patience: options.patience, onWaiting: options.onWaiting }),
		};
		const opened = await connectFrames(daemon.lock.port, daemon.lock.token, frameOptions);
		// Connections outliving close()
		// keep the daemon alive.
		if (closed) {
			opened.close();
			throw closedError();
		}
		// Publish before waiters resume.
		client = opened;
		return opened;
	}

	return {
		async ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>> {
			for (let attempt = 0; attempt < 2; attempt++) {
				// Reconnects can spawn daemons.
				if (closed) throw closedError();
				try {
					let current = client;
					if (current === null || current.closed) {
						connecting ??= open().finally(() => {
							connecting = null;
						});
						current = await connecting;
						if (closed) throw closedError();
					}
					const answer = await current.request(method, params);
					// Parsed through this client's table: a newer daemon's extra fields are stripped, and a
					// shape this client cannot read is an error here rather than a typed value that lies.
					const parsed = DAEMON_METHODS[method].response.safeParse(answer);
					if (!parsed.success) {
						// The field, never the issue list: a consumer reads this sentence, not zod's.
						const field = parsed.error.issues[0]?.path.join(".") || "the answer";
						throw new DaemonError(
							`the daemon answered ${method} with a shape this client cannot read at ${field}`,
							"daemon",
						);
					}
					return parsed.data as ResponseOf<M>;
				} catch (error) {
					// A read asked twice answers the same; a write that may have landed is not repeated.
					if (error instanceof ConnectionLostError && error.sent && methodMutates(method))
						throw new DaemonError(
							`the daemon connection was lost after ${method} was sent; the outcome is unknown`,
							"connectionLost",
						);
					if (closed) throw closedError();
					if (!(error instanceof ConnectionLostError)) throw error;
					client = null;
				}
			}
			throw new DaemonError(
				`the daemon for ${workspaceRoot} dropped the connection twice; giving up`,
				"connectionLost",
			);
		},

		close(): void {
			closed = true;
			client?.close();
			client = null;
		},
	};
}
