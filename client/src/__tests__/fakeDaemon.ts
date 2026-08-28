// A daemon's end of the wire with a scripted answer, so the client is proven against a frame
// server it cannot influence: its welcome, its starting answers, its refusals.

import { createServer, type Socket } from "node:net";
import { ClientFrameSchema, type DaemonLock, DaemonLockSchema, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { processIdentity } from "../procfs";
import { lineSplitter, writeFrame } from "../transport";

////////////////////////////////
//  Interfaces & Types

export type FakeAnswer =
	| { ok: true; result: unknown }
	| { ok: false; error: string; starting?: boolean; retryInMs?: number; waitingFor?: string };

export interface FakeDaemonOptions {
	token: string;
	/** What the welcome claims. */
	protocolVersion?: string;
	answer: (method: string, params: unknown) => FakeAnswer | Promise<FakeAnswer>;
}

export interface FakeDaemon {
	port: number;
	/** Every method asked, in order. */
	asked: string[];
	/** Sockets open right now. */
	connections(): number;
	close(): Promise<void>;
}

////////////////////////////////
//  Functions & Helpers

export function fakeDaemon(options: FakeDaemonOptions): Promise<FakeDaemon> {
	const asked: string[] = [];
	const sockets = new Set<Socket>();

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		let welcomed = false;
		socket.on(
			"data",
			lineSplitter(
				1024 * 1024,
				(line) => {
					const parsed = ClientFrameSchema.safeParse(JSON.parse(line));
					if (!parsed.success) return;
					const frame = parsed.data;
					if (frame.kind === "hello") {
						if (frame.token !== options.token) {
							writeFrame(socket, { kind: "reject", reason: "bad token" });
							socket.end();
							return;
						}
						welcomed = true;
						writeFrame(socket, {
							kind: "welcome",
							protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
						});
						return;
					}
					if (!welcomed || frame.kind !== "request") return;
					asked.push(frame.method);
					void Promise.resolve(options.answer(frame.method, frame.params)).then((answer) =>
						writeFrame(socket, { kind: "response", id: frame.id, ...answer }),
					);
				},
				() => socket.destroy(),
			),
		);
	});

	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({
				port,
				asked,
				connections: () => sockets.size,
				close: () =>
					new Promise((done) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => done());
					}),
			});
		}),
	);
}

/** A lock this very process holds, so liveness and identity both pass. */
export function ownLock(fields: {
	port: number;
	token: string;
	workspaceRoot: string;
	buildVersion: string;
	bundleStamp: string | null;
	protocolVersion?: string;
}): DaemonLock {
	const identity = processIdentity(process.pid);
	return DaemonLockSchema.parse({
		port: fields.port,
		token: fields.token,
		pid: process.pid,
		...(identity === null ? {} : { pidStart: identity.startTicks }),
		protocolVersion: fields.protocolVersion ?? PROTOCOL_VERSION,
		buildVersion: fields.buildVersion,
		...(fields.bundleStamp === null ? {} : { bundleStamp: fields.bundleStamp }),
		workspaceRoot: fields.workspaceRoot,
		startedAt: Date.now(),
	});
}
