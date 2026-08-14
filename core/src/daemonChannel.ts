// One persistent connection to a workspace's daemon, and the rule for getting it back.
//
// Every long-lived client needs the same three things and gets them wrong in the same three ways:
// the connection must be persistent (the daemon counts open connections to decide whether anyone is
// still here), it must be re-established rather than reported when it drops, and re-establishing
// must go through ensureDaemon so a client that outlives its daemon starts another instead of
// failing for the rest of the session.
//
// This existed once, inside the MCP adapter. The editor adapter needed the same thing, and a second
// copy of a retry rule is how two surfaces come to disagree about when a daemon is gone.

import { ensureDaemon } from "./ensureDaemon.js";
import { ConnectionLostError, connectFrames, type FrameClient } from "./socketTransport.js";

////////////////////////////////
//  Interfaces & Types

export interface DaemonChannel {
	/** Ask the daemon one question, reconnecting once if the connection died since the last one. */
	ask<T>(method: string, params?: unknown): Promise<T>;
	close(): void;
}

////////////////////////////////
//  Functions & Helpers

/**
 * A channel to the daemon serving `workspaceRoot`, connected lazily on the first question.
 *
 * Lazily on purpose: a client's startup handshake must not be held behind spawning a daemon, and a
 * session that never asks anything should never start one.
 *
 * One retry, not a loop. A connection lost between two questions is ordinary and worth re-opening;
 * a second loss on the freshly opened connection means something is wrong that retrying will not
 * fix, and a client silently retrying forever is indistinguishable from a hang.
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
