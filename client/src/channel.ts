// One persistent daemon connection, reconnected rather than reported.
//
// The open socket counts as presence; stale attempts cannot advance session state.

import {
	DAEMON_METHODS,
	type DaemonMethod,
	defined,
	methodMutates,
	type RequestOf,
	type ResponseOf,
	requestRule,
} from "@nyaa-lexicon/protocol";
import { DaemonRef } from "./daemonRef.js";
import { type EnsureMode, ensureDaemon, ensureFailure, type InstallSource } from "./ensure.js";
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
	/** False only attaches. True lets a method whose lifecycle `starts` start a daemon. */
	start?: boolean;
	/** Acquisition seam for tests. */
	ensure?: typeof ensureDaemon;
}

export interface DaemonChannel {
	/** Reconnects once if the connection died. */
	ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>>;
	/** Cancels acquisition and closes the channel; later asks fail closed. */
	close(): void;
}

interface Open {
	client: FrameClient;
	from: DaemonRef;
}

interface Attempt {
	mode: EnsureMode;
	abort: AbortController;
	done: Promise<Open>;
}

type State =
	| { kind: "idle" }
	| { kind: "opening"; attempt: Attempt }
	| { kind: "open"; open: Open }
	| { kind: "closed" };

////////////////////////////////
//  Functions & Helpers

/**
 * Connected lazily, so a handshake never waits on spawning a daemon.
 *
 * One retry only. Start requests share attach attempts, then start if none exists; attach requests
 * never start.
 */
export function daemonChannel(options: DaemonChannelOptions): DaemonChannel {
	const { workspaceRoot } = options;
	const ensure = options.ensure ?? ensureDaemon;
	let state: State = { kind: "idle" };
	const closedError = () => new DaemonError(`the session for ${workspaceRoot} is closed`, "closed");

	function modeFor(method: DaemonMethod): EnsureMode {
		return options.start !== false && requestRule(method)?.starts === true ? "start" : "attach";
	}

	async function open(mode: EnsureMode, signal: AbortSignal): Promise<Open> {
		const daemon = await ensure({
			workspaceRoot,
			source: options.source,
			mode,
			signal,
			...defined({ stateDir: options.stateDir, onWaiting: options.onWaiting, bundledBun: options.bundledBun }),
		});
		if (!daemon.connected) throw ensureFailure(daemon, `no indexer for ${workspaceRoot}: `);
		const from = new DaemonRef(daemon.lock);
		const client = await connectFrames(daemon.lock.port, daemon.lock.token, {
			signal,
			from,
			...defined({ patience: options.patience, onWaiting: options.onWaiting }),
		});
		return { client, from };
	}

	function begin(mode: EnsureMode): Attempt {
		const abort = new AbortController();
		const attempt: Attempt = { mode, abort, done: open(mode, abort.signal) };
		state = { kind: "opening", attempt };
		attempt.done.then(
			(opened) => {
				if (state.kind === "opening" && state.attempt === attempt) state = { kind: "open", open: opened };
				// Connections outliving close() keep the daemon alive.
				else opened.client.close();
			},
			() => {
				if (state.kind === "opening" && state.attempt === attempt) state = { kind: "idle" };
			},
		);
		return attempt;
	}

	/** Closing makes any pending acquisition settle as `closed`. */
	async function settle(attempt: Attempt): Promise<Open> {
		try {
			return await attempt.done;
		} catch (error) {
			if (state.kind === "closed") throw closedError();
			throw error;
		}
	}

	async function acquire(mode: EnsureMode): Promise<Open> {
		for (;;) {
			if (state.kind === "closed") throw closedError();
			if (state.kind === "open") {
				if (!state.open.client.closed) return state.open;
				state = { kind: "idle" };
			}
			if (state.kind === "idle") return settle(begin(mode));
			const { attempt } = state;
			if (mode === "attach" || attempt.mode === "start") return settle(attempt);
			try {
				return await settle(attempt);
			} catch (error) {
				if (!(error instanceof DaemonError && error.cause === "notRunning")) throw error;
			}
		}
	}

	async function request<M extends DaemonMethod>(
		current: Open,
		method: M,
		params: RequestOf<M>,
	): Promise<ResponseOf<M>> {
		const { from } = current;
		let answer: unknown;
		try {
			answer = await current.client.request(method, params);
		} catch (error) {
			// Reads retry; sent writes report unknown outcomes instead.
			if (error instanceof ConnectionLostError && error.sent && methodMutates(method))
				throw new DaemonError(
					`the daemon connection was lost after ${method} was sent; the outcome is unknown`,
					"connectionLost",
					{ from },
				);
			throw error;
		}
		// This client's schema strips extras and rejects unreadable answers.
		const parsed = DAEMON_METHODS[method].response.safeParse(answer);
		if (!parsed.success) {
			// Report the field path, not Zod's issue list.
			const field = parsed.error.issues[0]?.path.join(".") || "the answer";
			throw new DaemonError(
				`the daemon answered ${method} with a shape this client cannot read at ${field}`,
				"daemon",
				{ from },
			);
		}
		return parsed.data as ResponseOf<M>;
	}

	return {
		async ask<M extends DaemonMethod>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>> {
			const mode = modeFor(method);
			for (let attempt = 0; attempt < 2; attempt++) {
				let current: Open | null = null;
				try {
					current = await acquire(mode);
					return await request(current, method, params);
				} catch (error) {
					if (!(error instanceof ConnectionLostError)) throw error;
					if (state.kind === "closed") throw closedError();
					if (state.kind === "open" && state.open === current) state = { kind: "idle" };
				}
			}
			throw new DaemonError(
				`the daemon for ${workspaceRoot} dropped the connection twice; giving up`,
				"connectionLost",
			);
		},

		close(): void {
			const previous = state;
			state = { kind: "closed" };
			if (previous.kind === "opening") previous.attempt.abort.abort();
			if (previous.kind === "open") previous.open.client.close();
		},
	};
}
