// One persistent daemon connection, reconnected rather than reported.
//
// The open connection is how the daemon counts who is still here.

import {
	DAEMON_METHODS,
	type DaemonMethod,
	methodMutates,
	type RequestOf,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import type { DaemonSource } from "./discover.js";
import { ensureDaemon } from "./ensure.js";
import { DaemonError } from "./errors.js";
import { ConnectionLostError, connectFrames, type FrameClient } from "./transport.js";

////////////////////////////////
//  Interfaces & Types

export interface DaemonChannelOptions {
	workspaceRoot: string;
	/** Where a daemon is spawned from, and what a found lock is judged against. */
	source: DaemonSource | (() => DaemonSource);
	/** A store directory of the caller's choosing; the default is derived from the workspace. */
	stateDir?: string;
	/** How long a request waits on a starting daemon, in milliseconds. Zero asks once. */
	patience?: number;
	onWaiting?: (event: { waitingFor: string; retryInMs: number; elapsedMs: number }) => void;
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

	return {
		async ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>> {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					if (client === null || client.closed) {
						const daemonOptions = {
							workspaceRoot,
							source: options.source,
							...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
							...(options.onWaiting === undefined ? {} : { onWaiting: options.onWaiting }),
						};
						const daemon = await ensureDaemon(daemonOptions);
						if (!daemon.connected)
							throw new DaemonError(
								`no indexer for ${workspaceRoot}: ${daemon.detail}`,
								daemon.reason === "spawnFailed" ||
									daemon.reason === "unbuilt" ||
									daemon.reason === "noBunRuntime"
									? "spawnFailed"
									: "daemon",
							);
						const frameOptions = {
							...(options.patience === undefined ? {} : { patience: options.patience }),
							...(options.onWaiting === undefined ? {} : { onWaiting: options.onWaiting }),
						};
						client = await connectFrames(daemon.lock.port, daemon.lock.token, frameOptions);
					}
					const answer = await client.request(method, params);
					// Parsed through this client's table: a newer daemon's extra fields are stripped, and a
					// shape this client cannot read is an error here rather than a typed value that lies.
					const parsed = DAEMON_METHODS[method].response.safeParse(answer);
					if (!parsed.success) {
						throw new DaemonError(
							`the daemon answered ${method} with a shape this client cannot read: ${parsed.error.message}`,
							"daemon",
						);
					}
					return parsed.data as ResponseOf<M>;
				} catch (error) {
					if (!(error instanceof ConnectionLostError)) throw error;
					// A read asked twice answers the same; a write that may have landed is not repeated.
					if (error.sent && methodMutates(method))
						throw new DaemonError(
							`the daemon connection was lost after ${method} was sent; the outcome is unknown`,
							"connectionLost",
						);
					client = null;
				}
			}
			throw new DaemonError(
				`the daemon for ${workspaceRoot} dropped the connection twice; giving up`,
				"connectionLost",
			);
		},

		close(): void {
			client?.close();
			client = null;
		},
	};
}
