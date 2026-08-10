// The ONE module that touches daemon-wire sockets, on either end. Everything above speaks frames.
//
// This is the Bun seam: a Bun-native transport swaps in by reimplementing this file, the way
// store.ts isolates node:sqlite.
//
// An open authenticated socket IS a present client, which is what the daemon's lifetime counts.
// Close events cover every way a local process can die; the heartbeat covers alive-but-hung.

import { createServer as createNetServer, connect as netConnect, type Server, type Socket } from "node:net";
import {
	ClientFrameSchema,
	PROTOCOL_VERSION,
	type RequestFrame,
	type ResponseFrame,
	type ServerFrame,
	ServerFrameSchema,
} from "@nyaa-lexicon/protocol";

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
}

export interface FrameServer {
	port: number;
	connections(): number;
	close(): Promise<void>;
}

export interface FrameClient {
	request(method: string, params?: unknown): Promise<unknown>;
	close(): void;
	readonly closed: boolean;
}

/** The store is not open yet. The transport answers it as retryable rather than as a failure. */
export class DaemonStartingError extends Error {}

/** The socket died with requests in flight. The caller's cue to reconnect, not to report failure. */
export class ConnectionLostError extends Error {}

////////////////////////////////
//  Constants

const HEARTBEAT_MS = 30_000;
const MISSED_LIMIT = 2;
/** An unauthenticated socket may not linger; a real client hellos immediately. */
const HELLO_DEADLINE_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;

/** Requests are small (prose caps at 4KB); a line beyond this is a flood, not a query. */
const SERVER_LINE_CAP = 8 * 1024 * 1024;
/** Responses carry real result sets, so the client's cap is generous rather than symmetric. */
const CLIENT_LINE_CAP = 512 * 1024 * 1024;

/** Covers the claim-to-ready window: store open plus provider spawns, with slow-disk headroom. */
const STARTING_BUDGET_MS = 15_000;
const STARTING_RETRY_MS = 250;

////////////////////////////////
//  Functions & Helpers

/**
 * One frame per newline. Framing rather than parsing, which is why this is not a cursor pipeline:
 * JSON.parse does the parsing, this only finds the seams. A peer past the cap is cut off.
 */
function lineSplitter(cap: number, onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void {
	let buffered: Buffer = Buffer.alloc(0);
	return (chunk) => {
		buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
		let newlineAt = buffered.indexOf(10);
		while (newlineAt !== -1) {
			const line = buffered.subarray(0, newlineAt).toString("utf8").trim();
			buffered = buffered.subarray(newlineAt + 1);
			if (line.length > 0) onLine(line);
			newlineAt = buffered.indexOf(10);
		}
		if (buffered.length > cap) onOverflow();
	};
}

function writeFrame(socket: Socket, frame: ServerFrame | Record<string, unknown>): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

////////////////////////////////
//  Serving

/** Binds an ephemeral localhost port and serves frames until closed. */
export async function serveFrames(options: FrameServerOptions): Promise<FrameServer> {
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	const missedLimit = options.missedLimit ?? MISSED_LIMIT;
	const authed = new Set<Socket>();

	const server: Server = createNetServer((socket) => {
		let helloed = false;
		let missed = 0;
		let pings = 0;
		socket.setNoDelay(true);

		const helloDeadline = setTimeout(() => {
			if (!helloed) socket.destroy();
		}, HELLO_DEADLINE_MS);
		helloDeadline.unref?.();

		// Increment-then-check, switchboard's shape: with a limit of 2, a silent peer is gone on the
		// second quiet tick rather than the third.
		const heartbeat = setInterval(() => {
			if (!helloed) return;
			missed += 1;
			if (missed >= missedLimit) {
				socket.destroy();
				return;
			}
			pings += 1;
			writeFrame(socket, { kind: "ping", n: pings });
		}, heartbeatMs);
		heartbeat.unref?.();

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
				const starting = error instanceof DaemonStartingError ? { starting: true } : {};
				writeFrame(socket, { kind: "response", id: frame.id, ok: false, error: message, ...starting });
			}
		}

		socket.on(
			"data",
			lineSplitter(SERVER_LINE_CAP, onFrame, () => socket.destroy()),
		);
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			clearInterval(heartbeat);
			clearTimeout(helloDeadline);
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
			for (const socket of [...authed]) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

////////////////////////////////
//  Connecting

/**
 * Connect and authenticate, resolving once the server says welcome.
 *
 * Unref'd on purpose: an idle daemon connection must not keep a finished client process alive.
 */
export function connectFrames(port: number, token: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<FrameClient> {
	return new Promise((resolveConnect, rejectConnect) => {
		const socket = netConnect({ port, host: "127.0.0.1" });
		socket.setNoDelay(true);
		socket.unref();

		let welcomed = false;
		let closed = false;
		let nextId = 0;
		const pending = new Map<number, { resolve: (frame: ResponseFrame) => void; reject: (error: Error) => void }>();

		const connectDeadline = setTimeout(() => {
			if (!welcomed) {
				socket.destroy();
				rejectConnect(new Error(`the daemon did not answer the handshake within ${timeoutMs}ms`));
			}
		}, timeoutMs);
		connectDeadline.unref?.();

		function onFrame(line: string): void {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				socket.destroy();
				return;
			}
			const parsed = ServerFrameSchema.safeParse(raw);
			if (!parsed.success) {
				socket.destroy();
				return;
			}
			const frame = parsed.data;

			if (frame.kind === "welcome") {
				if (welcomed) return;
				welcomed = true;
				clearTimeout(connectDeadline);
				resolveConnect(client);
				return;
			}
			if (frame.kind === "reject") {
				socket.destroy();
				rejectConnect(new Error(`the daemon refused the connection: ${frame.reason}`));
				return;
			}
			if (frame.kind === "ping") {
				writeFrame(socket, { kind: "pong", n: frame.n });
				return;
			}
			const waiter = pending.get(frame.id);
			if (waiter) {
				pending.delete(frame.id);
				waiter.resolve(frame);
			}
		}

		socket.on(
			"data",
			lineSplitter(CLIENT_LINE_CAP, onFrame, () => socket.destroy()),
		);
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			closed = true;
			clearTimeout(connectDeadline);
			const lost = new ConnectionLostError("the daemon connection closed");
			for (const waiter of pending.values()) waiter.reject(lost);
			pending.clear();
			if (!welcomed) rejectConnect(new ConnectionLostError("the daemon closed the connection before welcoming"));
		});

		socket.on("connect", () => writeFrame(socket, { kind: "hello", token }));

		function sendRequest(method: string, params: unknown): Promise<ResponseFrame> {
			return new Promise((resolve, reject) => {
				if (closed) {
					reject(new ConnectionLostError("the daemon connection is closed"));
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				writeFrame(socket, { kind: "request", id, method, params });
			});
		}

		const client: FrameClient = {
			get closed() {
				return closed;
			},
			// A `starting` answer is the daemon between claiming its lock and opening its store, so
			// it is retried within a budget rather than surfaced: the lock exists precisely so a
			// client can find a daemon that is still coming up.
			async request(method: string, params?: unknown): Promise<unknown> {
				const deadline = Date.now() + STARTING_BUDGET_MS;
				for (;;) {
					const frame = await sendRequest(method, params);
					if (frame.ok) return frame.result;
					if (frame.starting && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, STARTING_RETRY_MS));
						continue;
					}
					throw new Error(frame.error);
				}
			},
			close(): void {
				socket.destroy();
			},
		};
	});
}

/** One question, one connection: for callers that ask and exit. */
export async function requestOnce(port: number, token: string, method: string, params?: unknown): Promise<unknown> {
	const client = await connectFrames(port, token);
	try {
		return await client.request(method, params);
	} finally {
		client.close();
	}
}
