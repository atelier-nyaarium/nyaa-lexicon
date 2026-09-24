import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ClientFrameSchema,
	type DaemonLock,
	DaemonLockSchema,
	type IndexStatus,
	PROTOCOL_VERSION,
} from "@nyaa-lexicon/protocol";
import { type DaemonChannelOptions, daemonChannel } from "../channel";
import type { EnsureResult } from "../ensure";
import { DaemonError } from "../errors";
import { lineSplitter, writeFrame } from "../transport";

const TOKEN = "t".repeat(32);
const BUILD = "2.2.0";
const STATS = { hits: 1, misses: 2, entries: 3, generation: 4 };

type Answer =
	| { ok: true; result: unknown }
	| { ok: false; error: string; starting?: boolean; retryInMs?: number; waitingFor?: string };
type ScriptAnswer = Answer | "close" | "close-before-welcome" | "close-after-welcome" | "slow-welcome" | "hang";

interface FakeDaemon {
	port: number;
	connections: number;
	requests: number;
	/** Sockets still open. */
	open: number;
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
						if (hello === "slow-welcome") {
							setTimeout(() => {
								welcomed = true;
								writeFrame(socket, { kind: "welcome", protocolVersion: PROTOCOL_VERSION });
							}, 100);
							return;
						}
						welcomed = true;
						writeFrame(socket, { kind: "welcome", protocolVersion: PROTOCOL_VERSION });
						if (hello === "close-after-welcome") return socket.destroy();
						return;
					}
					if (!welcomed || frame.kind !== "request") return;
					const answer = script(connection, ++requests);
					if (answer === "hang" || answer === "slow-welcome") return;
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
				get open() {
					return sockets.size;
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
	it("starts a daemon for any ask but a status read, and only when the session may start", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		const source = { root: path.join(workspaceRoot, "missing-install"), buildVersion: BUILD, bundleStamp: null };
		const starting = daemonChannel({ workspaceRoot, stateDir, source });
		const attaching = daemonChannel({ workspaceRoot, stateDir, source, start: false });
		const cause = (asked: Promise<unknown>) =>
			asked.then(
				() => "answered",
				(error: unknown) => (error as DaemonError).cause,
			);

		expect({
			query: await cause(starting.ask("overview", {})),
			status: await cause(starting.ask("indexStatus", {})),
			counters: await cause(starting.ask("cacheStats", {})),
			probe: await cause(starting.ask("fileHistory", { module: "a.ts" })),
			trigger: await cause(starting.ask("indexWorkspace", {})),
			attachOnly: await cause(attaching.ask("overview", {})),
		}).toEqual({
			query: "spawnFailed",
			status: "notRunning",
			counters: "notRunning",
			probe: "spawnFailed",
			trigger: "spawnFailed",
			attachOnly: "notRunning",
		});
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

	it("close stops reconnects; reads fail closed and sent writes report an unknown outcome", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		fake = await fakeDaemon(() => "hang");
		writeLock(fake.port);

		const session = channel();
		const read = session.ask("cacheStats", {});
		const write = session.ask("refactorStart", {});
		while (fake.requests < 2) await new Promise((resolve) => setTimeout(resolve, 5));
		session.close();

		const outcomes = await Promise.allSettled([read, write, session.ask("cacheStats", {})]);
		expect({
			causes: outcomes.map((outcome) => (outcome.status === "rejected" ? outcome.reason.cause : "answered")),
			connections: fake.connections,
		}).toEqual({ causes: ["closed", "connectionLost", "closed"], connections: 1 });
	});

	it("close during handshake sends no request and drops the connection", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		fake = await fakeDaemon((_connection, request) =>
			request === 0 ? "slow-welcome" : { ok: true, result: STATS },
		);
		writeLock(fake.port);

		const session = channel();
		const connecting = session.ask("cacheStats", {});
		while (fake.connections === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		session.close();

		await expect(connecting).rejects.toMatchObject({ cause: "closed" });
		for (let wait = 0; wait < 100 && fake.open > 0; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect({ connections: fake.connections, requests: fake.requests, open: fake.open }).toEqual({
			connections: 1,
			requests: 0,
			open: 0,
		});
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

describe("daemon channel acquisition", () => {
	const READY: IndexStatus = {
		state: "ready",
		done: 0,
		total: 0,
		failures: 0,
		failed: [],
		stored: 0,
		fullFiles: 0,
		outlineFiles: 0,
	};

	function lockFor(port: number): DaemonLock {
		return DaemonLockSchema.parse({
			port,
			token: TOKEN,
			pid: process.pid,
			protocolVersion: PROTOCOL_VERSION,
			buildVersion: BUILD,
			workspaceRoot,
			startedAt: 1,
		});
	}

	function held(ensure: DaemonChannelOptions["ensure"]) {
		stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-channel-state-"));
		workspaceRoot = mkdtempSync(path.join(tmpdir(), "lexicon-channel-work-"));
		return daemonChannel({
			workspaceRoot,
			stateDir,
			source: { root: workspaceRoot, buildVersion: BUILD, bundleStamp: null },
			...(ensure === undefined ? {} : { ensure }),
		});
	}

	const causeOf = (asked: Promise<unknown>) =>
		asked.then(
			() => "answered",
			(error: unknown) => (error as DaemonError).cause,
		);

	it("lets an ask that may start wait out an attach attempt, then start its own; an attach ask never starts one", async () => {
		fake = await fakeDaemon(() => ({ ok: true, result: READY }));
		const port = fake.port;
		const found = Promise.withResolvers<EnsureResult>();
		const modes: string[] = [];
		const session = held(async (options) => {
			modes.push(options.mode ?? "start");
			return options.mode === "attach" ? found.promise : { connected: true, lock: lockFor(port) };
		});

		const status = session.ask("indexStatus", {});
		const trigger = session.ask("indexWorkspace", {});
		found.resolve({ connected: false, reason: "notRunning", detail: "no daemon is registered" });

		expect({
			status: await causeOf(status),
			trigger: await trigger,
			later: await session.ask("indexStatus", {}),
			modes,
			connections: fake.connections,
		}).toEqual({ status: "notRunning", trigger: READY, later: READY, modes: ["attach", "start"], connections: 1 });
		session.close();
	});

	it("close aborts acquisition, and a daemon found anyway is never connected", async () => {
		fake = await fakeDaemon(() => ({ ok: true, result: READY }));
		const port = fake.port;
		const found = Promise.withResolvers<EnsureResult>();
		const signals: AbortSignal[] = [];
		const session = held(async (options) => {
			if (options.signal !== undefined) signals.push(options.signal);
			return found.promise;
		});

		const asked = session.ask("overview", {});
		await Promise.resolve();
		session.close();
		found.resolve({ connected: true, lock: lockFor(port) });

		expect({
			asked: await causeOf(asked),
			later: await causeOf(session.ask("overview", {})),
			aborted: signals.map((signal) => signal.aborted),
			connections: fake.connections,
		}).toEqual({ asked: "closed", later: "closed", aborted: [true], connections: 0 });
	});

	it("names the daemon behind every refusal, without its token", async () => {
		fake = await fakeDaemon(() => ({ ok: false, error: "warmup failed: provider outage; restart the daemon" }));
		const session = held(undefined);
		writeLock(fake.port);

		const refused: unknown = await session.ask("indexStatus", {}).catch((error: unknown) => error);
		if (!(refused instanceof DaemonError)) throw new Error("the refusal should be a DaemonError");

		expect({
			pid: refused.from?.pid,
			serialized: JSON.stringify(refused.from).includes(TOKEN),
		}).toEqual({ pid: process.pid, serialized: false });
		session.close();
	});
});
