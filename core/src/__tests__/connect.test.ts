import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, DaemonError, type PlatformEnv, type Session, workspacePaths } from "@nyaa-lexicon/client";
import { rejection, rethrown } from "@nyaa-lexicon/protocol/rejection";
import { type DaemonOptions, type RunningDaemon, startDaemon } from "../daemon";

////////////////////////////////
//  Helpers

const STATS = { hits: 0, misses: 0, entries: 0, generation: 0 };

let state: string;
let workspace: string;
let host: PlatformEnv;
let previousStateHome: string | undefined;
let daemon: RunningDaemon | undefined;
const sessions: Session[] = [];

async function launch(overrides: Partial<DaemonOptions> = {}): Promise<RunningDaemon> {
	const outcome = await startDaemon({ workspaceRoot: workspace, host, ...overrides });
	if (!outcome.claimed) throw new Error(outcome.reason);
	daemon = outcome.daemon;
	return outcome.daemon;
}

async function open(options: Parameters<typeof connect>[0]): Promise<Session> {
	const session = await connect(options);
	sessions.push(session);
	return session;
}

beforeEach(() => {
	state = mkdtempSync(path.join(tmpdir(), "lexicon-connect-state-"));
	workspace = mkdtempSync(path.join(tmpdir(), "lexicon-connect-work-"));
	host = { platform: "linux", env: { XDG_STATE_HOME: state }, home: state };
	// Keep daemon locks isolated.
	previousStateHome = process.env["XDG_STATE_HOME"];
	process.env["XDG_STATE_HOME"] = state;
});

afterEach(async () => {
	for (const session of sessions.splice(0)) session.close();
	await daemon?.stop();
	daemon = undefined;
	if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
	else process.env["XDG_STATE_HOME"] = previousStateHome;
	for (const dir of [state, workspace]) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a session over a daemon this process started", () => {
	it("reaches it through the lock and answers through the facade", async () => {
		const running = await launch({ handle: async (method) => (method === "cacheStats" ? STATS : null) });

		const session = await open({ workspaceRoot: workspace });

		expect(await session.cacheStats({})).toEqual(STATS);
		expect(session.lock().token).toBe(running.lock.token);
	});

	it("gives up on a starting daemon at zero patience, naming what it waited on", async () => {
		await launch({
			early: () => ({ kind: "starting", retryInMs: 60_000, waitingFor: "the language providers to start" }),
		});
		const session = await open({ workspaceRoot: workspace, patience: 0 });

		const failed = session.cacheStats({});

		expect(await rethrown(failed)).toThrow(DaemonError);
		expect(await rejection(failed)).toMatchObject({ waitingFor: "the language providers to start" });
	});

	it("stops it on request and returns once the lock is gone", async () => {
		// Answered before stopping, as the daemon program does, or the caller reads its own success
		// as a dropped connection.
		await launch({
			handle: async (method) => {
				if (method !== "shutdown") return null;
				setTimeout(() => void daemon?.stop(), 0);
				return { stopping: true };
			},
		});
		const session = await open({ workspaceRoot: workspace });
		const lockFile = workspacePaths(host, workspace).lockFile;
		expect(existsSync(lockFile)).toBe(true);

		await session.stopDaemon();

		expect(existsSync(lockFile)).toBe(false);
	});

	it("stops only the daemon that refused, never the one that replaced it", async () => {
		await launch({ handle: async () => Promise.reject(new Error("warmup failed: provider outage")) });
		const session = await open({ workspaceRoot: workspace });
		const refused: unknown = await session.indexStatus({}).catch((error: unknown) => error);
		if (!(refused instanceof DaemonError) || refused.from === undefined) throw new Error("no daemon named");

		await daemon?.stop();
		const replacement = await launch({ handle: async () => STATS });
		await session.stopDaemon(refused.from);

		expect(replacement.holdsLock()).toBe(true);
	});
});

describe("a session that may not start a daemon", () => {
	it("fails notRunning with no daemon, and an aborted connect fails closed; neither spawns", async () => {
		const lockFile = workspacePaths(host, workspace).lockFile;
		const causeOf = (connecting: Promise<Session>) =>
			connecting.then(
				(session) => {
					sessions.push(session);
					return "connected";
				},
				(error: unknown) => (error as DaemonError).cause,
			);

		const midway = new AbortController();
		const abortedMidway = connect({ workspaceRoot: workspace, start: false, signal: midway.signal });
		midway.abort();

		expect({
			attach: await causeOf(connect({ workspaceRoot: workspace, start: false })),
			aborted: await causeOf(connect({ workspaceRoot: workspace, signal: AbortSignal.abort() })),
			abortedMidway: await causeOf(abortedMidway),
			spawned: existsSync(lockFile),
		}).toEqual({ attach: "notRunning", aborted: "closed", abortedMidway: "closed", spawned: false });
	});
});
