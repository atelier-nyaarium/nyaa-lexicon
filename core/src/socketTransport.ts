// The daemon's end of the wire. The client's end, and the framing both share, is the client
// package's transport; everything above either speaks frames.
//
// The server socket lives in this one file, the way store.ts holds the one sqlite driver, so a
// transport change touches nothing above it.
//
// An open authenticated socket IS a present client, which is what the daemon's lifetime counts.
// Close events cover every way a local process can die; the heartbeat covers alive-but-hung.

import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { DaemonStartingError, lineSplitter, writeFrame } from "@nyaa-lexicon/client";
import {
	ClientFrameSchema,
	HEARTBEAT_MISSED_LIMIT,
	HEARTBEAT_MS,
	HELLO_DEADLINE_MS,
	PROTOCOL_VERSION,
	type RequestFrame,
	SERVER_LINE_CAP,
} from "@nyaa-lexicon/protocol";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";

////////////////////////////////
//  Interfaces & Types

export type FrameHandle = (method: string, params: unknown) => Promise<unknown>;

export interface FrameServerOptions {
	/** From the lock file; a hello presenting anything else is rejected and the socket closed. */
	token: string;
	/** Answers one request. Throw DaemonStartingError to answer "retry me" instead of "failed". */
	handle: FrameHandle;
	/** Fires with the authenticated-connection count on every change. The lifetime signal. */
	onConnections?: (count: number) => void;
	heartbeatMs?: number;
	missedLimit?: number;
	/** The daemon's one time source; the heartbeat and the hello deadline tick on it. */
	clock?: Clock;
}

export interface FrameServer {
	port: number;
	connections(): number;
	close(): Promise<void>;
}

////////////////////////////////
//  Serving

/** Binds an ephemeral localhost port and serves frames until closed. */
export async function serveFrames(options: FrameServerOptions): Promise<FrameServer> {
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	const missedLimit = options.missedLimit ?? HEARTBEAT_MISSED_LIMIT;
	const clock = options.clock ?? systemClock;
	const authed = new Set<Socket>();
	// ALL sockets, so close() cannot be held open by one that never authenticated.
	const sockets = new Set<Socket>();

	const server: Server = createNetServer((socket) => {
		let helloed = false;
		let missed = 0;
		let pings = 0;
		socket.setNoDelay(true);
		sockets.add(socket);

		const helloDeadline = clock.setTimer(() => {
			if (!helloed) socket.destroy();
		}, HELLO_DEADLINE_MS);

		// Increment-then-check, switchboard's shape: with a limit of 2, a silent peer is gone on the
		// second quiet tick rather than the third. Re-armed per tick against an absolute deadline, so
		// the clock needs no interval and the cadence does not drift; a closed socket arms nothing.
		let closed = false;
		let heartbeat: TimerHandle | null = null;
		let due = clock.now();
		const tick = () => {
			if (closed) return;
			due += heartbeatMs;
			heartbeat = clock.setTimer(
				() => {
					if (closed) return;
					if (helloed) {
						missed += 1;
						if (missed >= missedLimit) {
							socket.destroy();
							return;
						}
						pings += 1;
						writeFrame(socket, { kind: "ping", n: pings });
					}
					tick();
				},
				Math.max(0, due - clock.now()),
			);
		};
		tick();

		function onFrame(line: string): void {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				socket.destroy();
				return;
			}
			const parsed = ClientFrameSchema.safeParse(raw);
			// A malformed frame is a broken or hostile peer either way; there is no id to answer.
			if (!parsed.success) {
				socket.destroy();
				return;
			}
			missed = 0;
			const frame = parsed.data;

			if (frame.kind === "hello") {
				if (helloed) return;
				if (frame.token !== options.token) {
					writeFrame(socket, { kind: "reject", reason: "bad token" });
					socket.end();
					return;
				}
				helloed = true;
				authed.add(socket);
				options.onConnections?.(authed.size);
				writeFrame(socket, { kind: "welcome", protocolVersion: PROTOCOL_VERSION });
				return;
			}

			// Everything past hello requires it; the token is checked first so an unauthorized
			// caller learns nothing else, same rule the HTTP gate had.
			if (!helloed) {
				socket.destroy();
				return;
			}

			if (frame.kind === "request") {
				void answer(frame);
				return;
			}
			// pong: the reset above was the whole point.
		}

		async function answer(frame: RequestFrame): Promise<void> {
			try {
				const result = await options.handle(frame.method, frame.params);
				writeFrame(socket, { kind: "response", id: frame.id, ok: true, result });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const starting =
					error instanceof DaemonStartingError
						? {
								starting: true,
								retryInMs: Math.max(0, Math.round(error.retryInMs)),
								waitingFor: error.waitingFor,
							}
						: {};
				writeFrame(socket, { kind: "response", id: frame.id, ok: false, error: message, ...starting });
			}
		}

		socket.on(
			"data",
			lineSplitter(SERVER_LINE_CAP, onFrame, () => socket.destroy()),
		);
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			closed = true;
			if (heartbeat !== null) clock.clearTimer(heartbeat);
			clock.clearTimer(helloDeadline);
			sockets.delete(socket);
			if (authed.delete(socket)) options.onConnections?.(authed.size);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("daemon did not bind a port");

	return {
		port: address.port,
		connections: () => authed.size,
		close: async () => {
			for (const socket of [...sockets]) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
