import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import {
	ConnectionLostError,
	callDaemon,
	connectFrames,
	findDaemon,
	type PlatformEnv,
	workspacePaths,
} from "@nyaa-lexicon/client";
import { type DaemonOptions, type RunningDaemon, startDaemon } from "../daemon";
import { ownSource } from "../ownSource";

////////////////////////////////
//  Helpers

let stateDir: string;
let host: PlatformEnv;
let daemon: RunningDaemon | undefined;

const WORKSPACE = "/tmp/lexicon-test-workspace";

async function launch(overrides: Partial<DaemonOptions> = {}): Promise<RunningDaemon> {
	const outcome = await startDaemon({
		workspaceRoot: WORKSPACE,
		handle: async (method, params) => ({ method, params }),
		host,
		...overrides,
	});
	if (!outcome.claimed) throw new Error(outcome.reason);
	return outcome.daemon;
}

/** A raw socket for probing the gate. It reads because a socket with no data listener stays paused,
 * and a paused stream holding unread bytes never reaches close. */
function rawConnect(port: number, heard: string[] = []): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ port, host: "127.0.0.1" });
		socket.on("data", (chunk) => heard.push(chunk.toString()));
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function closedOf(socket: Socket): Promise<void> {
	return new Promise((resolve) => socket.once("close", () => resolve()));
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A client sees its own close before the server books it, so asserting off the client's close
 * measures two processes racing rather than the count. */
async function settledAt(running: RunningDaemon, want: number): Promise<number> {
	for (let waited = 0; waited < 2_000 && running.connections() !== want; waited += 20) await wait(20);
	return running.connections();
}

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-daemon-"));
	host = { platform: "linux", env: { XDG_STATE_HOME: stateDir }, home: stateDir };
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	rmSync(stateDir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("starting and publishing", () => {
	it("binds a port and writes a lock a client can find", async () => {
		daemon = await launch();

		expect(daemon.lock.port).toBeGreaterThan(0);
		expect(existsSync(workspacePaths(host, WORKSPACE).lockFile)).toBe(true);
		expect(findDaemon(WORKSPACE, ownSource(), host)).toMatchObject({ action: "connect" });
	});

	it("removes the lock on stop, so nobody connects to a dead port", async () => {
		daemon = await launch();
		const lockFile = workspacePaths(host, WORKSPACE).lockFile;

		await daemon.stop();
		daemon = undefined;

		expect(existsSync(lockFile)).toBe(false);
		expect(findDaemon(WORKSPACE, ownSource(), host)).toMatchObject({ action: "spawn" });
	});

	// A manual rm of the state directory.
	it("drops every client once its lock is gone, so each reconnects to whoever serves", async () => {
		const lost: string[] = [];
		daemon = await launch({ onLockLost: (reason) => lost.push(reason) });
		const lockFile = workspacePaths(host, WORKSPACE).lockFile;
		const client = await connectFrames(daemon.lock.port, daemon.lock.token);
		await expect(client.request("describe", {})).resolves.toBeDefined();
		expect(daemon.holdsLock()).toBe(true);

		rmSync(lockFile, { force: true });

		expect(daemon.holdsLock()).toBe(false);
		// The reconnect path is a lost connection, never a stale answer or a bare error.
		await expect(client.request("describe", {})).rejects.toThrow(ConnectionLostError);
		expect(client.closed).toBe(true);
		expect(lost).toEqual([expect.stringMatching(/lock is gone/)]);
		expect(daemon.connections()).toBe(0);
	});

	it("treats a successor's lock as its own loss, and leaves that lock alone", async () => {
		const lost: string[] = [];
		daemon = await launch({ onLockLost: (reason) => lost.push(reason) });
		const lockFile = workspacePaths(host, WORKSPACE).lockFile;
		writeFileSync(lockFile, JSON.stringify({ ...daemon.lock, pid: 4242, token: "s".repeat(48) }));

		expect(daemon.holdsLock()).toBe(false);
		await expect(callDaemon(daemon.lock, "describe", {})).rejects.toThrow(ConnectionLostError);
		expect(lost).toEqual([expect.stringMatching(/names pid 4242/)]);
		await daemon.stop();
		daemon = undefined;
		expect(existsSync(lockFile)).toBe(true);
	});

	it("tolerates being stopped twice", async () => {
		const running = await launch();
		await running.stop();
		await expect(running.stop()).resolves.toBeUndefined();
	});

	it("gives two workspaces separate ports and separate locks", async () => {
		const first = await launch();
		const outcome = await startDaemon({ workspaceRoot: "/tmp/other-workspace", handle: async () => ({}), host });
		if (!outcome.claimed) throw new Error(outcome.reason);
		const second = outcome.daemon;

		expect(first.lock.port).not.toBe(second.lock.port);
		expect(first.lock.token).not.toBe(second.lock.token);

		await first.stop();
		await second.stop();
	});
});

describe("a store directory of the caller's choosing", () => {
	// A store's identity is its directory: one workspace may be served from two of them at once,
	// and each daemon claims, rereads and releases the lock where it was told to, nowhere else.
	it("serves one workspace from two directories, each lock found only where it lives", async () => {
		const dirA = mkdtempSync(path.join(tmpdir(), "lexicon-store-a-"));
		const dirB = mkdtempSync(path.join(tmpdir(), "lexicon-store-b-"));
		const a = await launch({ stateDir: dirA, handle: async () => ({ from: "a" }) });
		const b = await launch({ stateDir: dirB, handle: async () => ({ from: "b" }) });
		try {
			expect(a.lock.port).not.toBe(b.lock.port);
			expect(existsSync(path.join(dirA, "daemon.json"))).toBe(true);
			expect(existsSync(path.join(dirB, "daemon.json"))).toBe(true);
			expect(existsSync(workspacePaths(host, WORKSPACE).lockFile)).toBe(false);
			await expect(callDaemon(a.lock, "describe")).resolves.toEqual({ from: "a" });
			await expect(callDaemon(b.lock, "describe")).resolves.toEqual({ from: "b" });

			expect(findDaemon(WORKSPACE, ownSource(), host, dirA)).toMatchObject({ action: "connect", lock: a.lock });
			expect(findDaemon(WORKSPACE, ownSource(), host, dirB)).toMatchObject({ action: "connect", lock: b.lock });
			expect(findDaemon(WORKSPACE, ownSource(), host)).toMatchObject({ action: "spawn" });

			const third = await startDaemon({
				workspaceRoot: WORKSPACE,
				stateDir: dirA,
				handle: async () => ({}),
				host,
			});
			expect(third).toMatchObject({ claimed: false, reason: expect.stringContaining(String(a.lock.pid)) });

			rmSync(path.join(dirA, "daemon.json"));
			expect(a.holdsLock()).toBe(false);
			expect(b.holdsLock()).toBe(true);
		} finally {
			await a.stop();
			await b.stop();
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	});
});

describe("the claim", () => {
	it("gives one workspace one daemon: the second claimant loses and learns who won", async () => {
		daemon = await launch();

		const outcome = await startDaemon({ workspaceRoot: WORKSPACE, handle: async () => ({}), host });

		expect(outcome.claimed).toBe(false);
		if (outcome.claimed) return;
		expect(outcome.reason).toContain(String(daemon.lock.pid));
		expect(outcome.reason).toContain(WORKSPACE);

		// The loser changed nothing: the winner's lock is intact and still answers.
		expect(findDaemon(WORKSPACE, ownSource(), host)).toMatchObject({ action: "connect", lock: daemon.lock });
		await expect(callDaemon(daemon.lock, "describe")).resolves.toBeDefined();
	});

	// The hard link decides a race two clients start at once; neither side opens a store before it.
	it("settles two simultaneous claims on one workspace: one holds the lock, the other names it", async () => {
		const start = () => startDaemon({ workspaceRoot: WORKSPACE, handle: async () => ({}), host });
		const [a, b] = await Promise.all([start(), start()]);

		const winners = [a, b].filter((outcome) => outcome.claimed);
		expect(winners).toHaveLength(1);
		const winner = winners[0];
		if (winner === undefined || !winner.claimed) return;
		daemon = winner.daemon;

		const loser = a.claimed ? b : a;
		expect(loser.claimed).toBe(false);
		if (!loser.claimed) expect(loser.reason).toContain(String(winner.daemon.lock.pid));
		expect(findDaemon(WORKSPACE, ownSource(), host)).toMatchObject({ action: "connect", lock: winner.daemon.lock });
		await expect(callDaemon(winner.daemon.lock, "describe")).resolves.toBeDefined();
	});

	it("steals a lock left by a dead daemon rather than refusing to start", async () => {
		const paths = workspacePaths(host, WORKSPACE);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(
			paths.lockFile,
			JSON.stringify({
				port: 1,
				token: "x".repeat(48),
				pid: 2 ** 30,
				protocolVersion: "1.0.0",
				workspaceRoot: WORKSPACE,
				startedAt: 0,
			}),
		);

		daemon = await launch();

		expect(findDaemon(WORKSPACE, ownSource(), host)).toMatchObject({ action: "connect", lock: daemon.lock });
	});

	it("steals a corrupt lock, since half a JSON cannot name a live daemon", async () => {
		const paths = workspacePaths(host, WORKSPACE);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.lockFile, "{ not a lock");

		daemon = await launch();

		expect(findDaemon(WORKSPACE, ownSource(), host)).toMatchObject({ action: "connect", lock: daemon.lock });
	});

	it("stops without disturbing a successor's lock", async () => {
		const first = await launch();
		const paths = workspacePaths(host, WORKSPACE);

		// Simulate a successor having replaced the lock while `first` was on its way out.
		rmSync(paths.lockFile);
		const successor = {
			port: 2,
			token: "y".repeat(48),
			pid: process.pid,
			protocolVersion: "1.0.0",
			workspaceRoot: WORKSPACE,
			startedAt: 1,
		};
		writeFileSync(paths.lockFile, JSON.stringify(successor));

		await first.stop();

		expect(JSON.parse(readFileSync(paths.lockFile, "utf8"))).toMatchObject({ token: successor.token });
	});
});

describe("the token gate", () => {
	it("answers a query carrying the token", async () => {
		daemon = await launch();
		await expect(callDaemon(daemon.lock, "describe", { id: "x" })).resolves.toEqual({
			method: "describe",
			params: { id: "x" },
		});
	});

	it("rejects a wrong token before anything else is said", async () => {
		daemon = await launch();
		await expect(callDaemon({ ...daemon.lock, token: "w".repeat(48) }, "describe")).rejects.toThrow(/bad token/);
	});

	it("cuts off a caller that skips the hello, so it learns nothing", async () => {
		daemon = await launch();
		const answered: string[] = [];
		const socket = await rawConnect(daemon.lock.port, answered);

		socket.write(`${JSON.stringify({ kind: "request", id: 0, method: "describe" })}\n`);
		await closedOf(socket);

		expect(answered).toEqual([]);
	});
});

describe("answering", () => {
	it("reports a handler's failure as an error rather than a lost reply", async () => {
		daemon = await launch({
			handle: async () => {
				throw new Error("index is rebuilding");
			},
		});
		// Caught by hand: bun's `rejects` fails the test on the handler's own throw before the reply lands.
		const failed = await callDaemon(daemon.lock, "describe").then(
			() => null,
			(error: unknown) => error,
		);
		expect(failed).toBeInstanceOf(Error);
		expect((failed as Error).message).toMatch(/index is rebuilding/);
	});

	it("drops a client speaking garbage without taking the daemon down", async () => {
		daemon = await launch();
		const socket = await rawConnect(daemon.lock.port);
		socket.write(`${JSON.stringify({ kind: "hello", token: daemon.lock.token })}\n`);
		await wait(50);

		socket.write("{ not json\n");
		await closedOf(socket);

		// Still serving: one broken client is not a reason to take the index down.
		await expect(callDaemon(daemon.lock, "describe")).resolves.toBeDefined();
	});
});

describe("the starting window", () => {
	it("answers starting with no handler, then serves once one is installed", async () => {
		const outcome = await startDaemon({ workspaceRoot: WORKSPACE, host });
		if (!outcome.claimed) throw new Error(outcome.reason);
		daemon = outcome.daemon;

		// The client retries a starting answer, so a call issued mid-window resolves once the
		// handler lands.
		const pending = callDaemon(daemon.lock, "describe", { id: "x" });
		setTimeout(() => daemon?.setHandle(async (method, params) => ({ method, params })), 300);

		await expect(pending).resolves.toEqual({ method: "describe", params: { id: "x" } });
	});

	// The defect: a private 15s client budget against three 60s provider starts reported permanent
	// failure for a daemon still coming up.
	it("waits as long as the daemon says it still needs, not a budget of its own", async () => {
		const outcome = await startDaemon({
			workspaceRoot: WORKSPACE,
			host,
			startingNote: () => ({ retryInMs: 60_000, waitingFor: "the language providers to start" }),
		});
		if (!outcome.claimed) throw new Error(outcome.reason);
		daemon = outcome.daemon;

		const pending = callDaemon(daemon.lock, "describe");
		setTimeout(() => daemon?.setHandle(async (method) => ({ method })), 400);

		await expect(pending).resolves.toEqual({ method: "describe" });
	});

	it("gives up once the daemon's countdown reaches zero, naming what it waited for", async () => {
		const outcome = await startDaemon({
			workspaceRoot: WORKSPACE,
			host,
			startingNote: () => ({ retryInMs: 0, waitingFor: "the language providers to start" }),
		});
		if (!outcome.claimed) throw new Error(outcome.reason);
		daemon = outcome.daemon;

		await expect(callDaemon(daemon.lock, "describe")).rejects.toThrow(/the language providers to start/);
	});
});

describe("presence", () => {
	it("counts authenticated connections and their departures", async () => {
		const counts: number[] = [];
		daemon = await launch({ onConnections: (n) => counts.push(n) });

		const first = await connectFrames(daemon.lock.port, daemon.lock.token);
		const second = await connectFrames(daemon.lock.port, daemon.lock.token);
		expect(daemon.connections()).toBe(2);

		first.close();
		expect(await settledAt(daemon, 1)).toBe(1);

		second.close();
		expect(await settledAt(daemon, 0)).toBe(0);
		expect(counts).toEqual([1, 2, 1, 0]);
	});

	it("disconnects a hung client by heartbeat, while a live one stays", async () => {
		daemon = await launch({ heartbeatMs: 60, missedLimit: 2 });

		// Raw socket: hellos, then never answers a ping.
		const hung = await rawConnect(daemon.lock.port);
		hung.write(`${JSON.stringify({ kind: "hello", token: daemon.lock.token })}\n`);
		const live = await connectFrames(daemon.lock.port, daemon.lock.token);

		await closedOf(hung);
		expect(await settledAt(daemon, 1)).toBe(1);
		await expect(live.request("describe")).resolves.toBeDefined();
		live.close();
	});
});

describe("staying up", () => {
	it("goes away only when told to, which is what makes the lock trustworthy", async () => {
		daemon = await launch();
		await daemon.stop();

		expect(existsSync(workspacePaths(host, WORKSPACE).lockFile)).toBe(false);
	});

	// Enforces WHERE the decision lives, not that it exists: a timer here is one no test could
	// decide, since a 150ms test passes just as happily against a 30 minute default.
	it("keeps lifetime decisions out of the transport, where no test could reach them", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "daemon.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.replace(/\/\/[^\n]*/g, " ");

		expect(source).not.toMatch(/setTimeout|setInterval/);
		expect(source.toLowerCase()).not.toMatch(/linger|idle/);
	});
});
