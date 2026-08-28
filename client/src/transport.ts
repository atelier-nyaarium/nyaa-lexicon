// The client's end of the daemon wire, and the framing both ends share. Everything above speaks frames.
//
// This is the Bun seam: a Bun-native transport swaps in by reimplementing this file, the way
// core's store.ts isolates node:sqlite.
//
// An open authenticated socket IS a present client, which is what the daemon's lifetime counts.
// Close events cover every way a local process can die; the heartbeat covers alive-but-hung.

import { connect as netConnect, type Socket } from "node:net";
import {
	CLIENT_LINE_CAP,
	CONNECT_TIMEOUT_MS,
	PROTOCOL_VERSION,
	parseVersion,
	type ResponseFrame,
	type ServerFrame,
	ServerFrameSchema,
} from "@nyaa-lexicon/protocol";
import { DaemonError, Incompatible } from "./errors.js";

////////////////////////////////
//  Interfaces & Types

export interface FrameClient {
	request(method: string, params?: unknown): Promise<unknown>;
	close(): void;
	readonly closed: boolean;
}

export interface ConnectFramesOptions {
	/** How long the welcome may take. */
	timeoutMs?: number;
	/** How long a request waits on a starting daemon; zero asks once. */
	patience?: number;
}

/** Not ready yet, answered as retryable. Carries the daemon's own countdown, so a client never
 * runs out of patience before the daemon runs out of time. */
export class DaemonStartingError extends Error {
	constructor(
		message: string,
		readonly retryInMs = 0,
		readonly waitingFor = "startup",
	) {
		super(message);
	}
}

/** The socket died with requests in flight. The caller's cue to reconnect, not to report failure. */
export class ConnectionLostError extends Error {}

////////////////////////////////
//  Constants

const STARTING_RETRY_MS = 250;
/** The default patience: a backstop against a daemon whose countdown never reaches zero, not the
 * normal bound. The daemon publishes the real budget on every starting answer. */
const STARTING_CEILING_MS = 5 * 60 * 1000;

////////////////////////////////
//  Versions

/** A daemon behind this client's major cannot serve its table; ahead serves it whole. */
function behindUs(theirs: string): boolean {
	const them = parseVersion(theirs);
	const us = parseVersion(PROTOCOL_VERSION);
	return them === null || us === null || them.major < us.major;
}

////////////////////////////////
//  Framing

/**
 * One frame per newline. Framing rather than parsing, which is why this is not a cursor pipeline:
 * JSON.parse does the parsing, this only finds the seams. A peer past the cap is cut off.
 */
export function lineSplitter(
	cap: number,
	onLine: (line: string) => void,
	onOverflow: () => void,
): (chunk: Buffer) => void {
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

export function writeFrame(socket: Socket, frame: ServerFrame | Record<string, unknown>): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

////////////////////////////////
//  Connecting

/** Resolves once the server says welcome. Unref'd, so an idle connection cannot hold a client open. */
export function connectFrames(port: number, token: string, options: ConnectFramesOptions = {}): Promise<FrameClient> {
	const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
	const patience = options.patience ?? STARTING_CEILING_MS;
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
				// Judged here as well as from the lock, so a direct connection cannot bypass the rule.
				if (behindUs(frame.protocolVersion)) {
					clearTimeout(connectDeadline);
					rejectConnect(
						new Incompatible(
							`the daemon speaks protocol ${frame.protocolVersion}, this client speaks ${PROTOCOL_VERSION}`,
							PROTOCOL_VERSION,
							frame.protocolVersion,
						),
					);
					socket.destroy();
					return;
				}
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
			if (!welcomed) {
				rejectConnect(
					new ConnectionLostError(`the daemon on port ${port} closed the connection before welcoming`),
				);
			}
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
			// Retried until the EARLIER of the daemon's own countdown and our patience runs out; the
			// daemon's countdown is the normal bound, patience the caller's.
			async request(method: string, params?: unknown): Promise<unknown> {
				const ceiling = Date.now() + patience;
				for (;;) {
					const frame = await sendRequest(method, params);
					if (frame.ok) return frame.result;
					if (!frame.starting) throw new Error(frame.error);
					const remaining = ceiling - Date.now();
					if ((frame.retryInMs ?? 0) > 0 && remaining > 0) {
						await new Promise((resolve) => setTimeout(resolve, Math.min(STARTING_RETRY_MS, remaining)));
						continue;
					}
					const waitingFor = frame.waitingFor ?? "startup";
					throw new DaemonError(
						`${frame.error} (gave up waiting on ${waitingFor}; ask again later)`,
						waitingFor,
					);
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
