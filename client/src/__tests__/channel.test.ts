import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClientFrameSchema, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { daemonChannel } from "../channel";
import { DaemonError } from "../errors";
import { lineSplitter, writeFrame } from "../transport";

const TOKEN = "t".repeat(32);
const BUILD = "2.2.0";
const STATS = { hits: 1, misses: 2, entries: 3, generation: 4 };

type Answer =
	| { ok: true; result: unknown }
	| { ok: false; error: string; starting?: boolean; retryInMs?: number; waitingFor?: string };
type ScriptAnswer = Answer | "close" | "close-before-welcome" | "close-after-welcome";

interface FakeDaemon {
	port: number;
	connections: number;
	requests: number;
	close(): Promise<void>;
}

function fakeDaemon(script: (connection: number, request: number) => ScriptAnswer): Promise<FakeDaemon> {
	let connections = 0;
	let requests = 0;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		const connection = ++connections;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
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
						if (frame.token !== TOKEN) return socket.destroy();
						const hello = script(connection, 0);
						if (hello === "close-before-welcome") return socket.destroy();
						welcomed = true;
						writeFrame(socket, { kind: "welcome", protocolVersion: PROTOCOL_VERSION });
						if (hello === "close-after-welcome") return socket.destroy();
						return;
					}
					if (!welcomed || frame.kind !== "request") return;
					const answer = script(connection, ++requests);
					if (answer === "close" || answer === "close-before-welcome" || answer === "close-after-welcome")
						return socket.destroy();
					writeFrame(socket, { kind: "response", id: frame.id, ...answer });
				},
				() => socket.destroy(),
			),
		);
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as { port: number };
			resolve({
				get port() {
					return address.port;
				},
				get connections() {
					return connections;
				},
				get requests() {
					return requests;
				},
				close: () =>
					new Promise<void>((done) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => done());
					}),
			});
		});
	});
}

let stateDir: string;
let workspaceRoot: string;
let fake: FakeDaemon | undefined;

function writeLock(port: number): void {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		path.join(stateDir, "daemon.json"),
		JSON.stringify({
			port,
			token: TOKEN,
			pid: process.pid,
			protocolVersion: PROTOCOL_VERSION,
			buildVersion: BUILD,
			workspaceRoot,
			startedAt: Date.now(),
		}),
	);
}

function channel(onWaiting?: (event: { waitingFor: string; retryInMs: number; elapsedMs: number }) => void) {
	return daemonChannel({
		workspaceRoot,
		stateDir,
		source: { root: workspaceRoot, buildVersion: BUILD, bundleStamp: null },
		patience: 2_000,
		...(onWaiting === undefined ? {} : { onWaiting }),
	});
}

afterEach(async () => {
	if (fake !== undefined) await fake.close();
	fake = undefined;
	rmSync(stateDir, { recursive: true, force: true });
	rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("daemon channel reconnects", () => {
	it("maps an unbuilt daemon source to spawnFailed", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		const session = daemonChannel({
			workspaceRoot,
			stateDir,
			source: { root: path.join(workspaceRoot, "missing-install"), buildVersion: BUILD, bundleStamp: null },
		});
		await expect(session.ask("cacheStats", {})).rejects.toMatchObject({ cause: "spawnFailed" });
	});

	it("reopens and asks a read again when the first connection closes right after its welcome", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		fake = await fakeDaemon((connection, request) =>
			connection === 1 && request === 0 ? "close-after-welcome" : { ok: true, result: STATS },
		);
		writeLock(fake.port);

		const session = channel();
		expect(await session.ask("cacheStats", {})).toEqual(STATS);
		expect(fake.connections).toBe(2);
		session.close();
	});

	it("fails with an unknown outcome when the connection is lost after a write was sent", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		fake = await fakeDaemon((_connection, request) => (request === 1 ? "close" : { ok: true, result: STATS }));
		writeLock(fake.port);

		const session = channel();
		await expect(session.ask("refactorCommit", {})).rejects.toMatchObject({
			cause: "connectionLost",
			message: expect.stringContaining("outcome is unknown"),
		});
		expect(fake.connections).toBe(1);
		session.close();
	});

	it("reopens after the first connection closes before welcome", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		fake = await fakeDaemon((connection) =>
			connection === 1 ? "close-before-welcome" : { ok: true, result: STATS },
		);
		writeLock(fake.port);

		const session = channel();
		expect(await session.ask("cacheStats", {})).toEqual(STATS);
		expect(fake.connections).toBe(2);
		session.close();
	});

	it("reports connectionLost after two consecutive losses", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		fake = await fakeDaemon(() => "close");
		writeLock(fake.port);

		const session = channel();
		try {
			await session.ask("cacheStats", {});
			expect.unreachable("the channel should give up after two losses");
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonError);
			expect(error).toMatchObject({ cause: "connectionLost" });
		}
		expect(fake.connections).toBe(2);
		session.close();
	});

	it("notifies once for each distinct starting wait", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		fake = await fakeDaemon((_connection, request) => {
			if (request < 3) return { ok: false, error: "starting", starting: true, retryInMs: 1, waitingFor: "index" };
			if (request === 3)
				return { ok: false, error: "starting", starting: true, retryInMs: 1, waitingFor: "providers" };
			return { ok: true, result: STATS };
		});
		writeLock(fake.port);
		const waitingFor: string[] = [];

		const session = channel((event) => {
			waitingFor.push(event.waitingFor);
			return Promise.reject(new Error("ignored"));
		});
		expect(await session.ask("cacheStats", {})).toEqual(STATS);
		expect(waitingFor).toEqual(["index", "providers"]);
		session.close();
	});
});
