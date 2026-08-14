// One persistent daemon connection, reconnected rather than reported.
//
// The open connection is how the daemon counts who is still here.

import { ensureDaemon } from "./ensureDaemon.js";
import { ConnectionLostError, connectFrames, type FrameClient } from "./socketTransport.js";

////////////////////////////////
//  Interfaces & Types

export interface DaemonChannel {
	/** Reconnects once if the connection died. */
	ask<T>(method: string, params?: unknown): Promise<T>;
	close(): void;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Connected lazily, so a handshake never waits on spawning a daemon.
 *
 * One retry, not a loop: retrying forever looks like a hang.
 */
export function daemonChannel(workspaceRoot: string): DaemonChannel {
	let client: FrameClient | null = null;

	return {
		async ask<T>(method: string, params?: unknown): Promise<T> {
			for (let attempt = 0; attempt < 2; attempt++) {
				if (client === null || client.closed) {
					const daemon = await ensureDaemon({ workspaceRoot });
					if (!daemon.connected) throw new Error(`no indexer for ${workspaceRoot}: ${daemon.reason}`);
					client = await connectFrames(daemon.lock.port, daemon.lock.token);
				}
				try {
					return (await client.request(method, params)) as T;
				} catch (error) {
					if (!(error instanceof ConnectionLostError)) throw error;
					client = null;
				}
			}
			throw new Error(`the daemon for ${workspaceRoot} dropped the connection twice; giving up`);
		},

		close(): void {
			client?.close();
			client = null;
		},
	};
}
