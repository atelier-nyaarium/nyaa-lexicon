import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	connect,
	DaemonError,
	type PlatformEnv,
	type Session,
	workspacePaths,
	writeInstallRecord,
} from "@nyaa-lexicon/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonOptions, type RunningDaemon, startDaemon } from "../daemon";
import { lexiconRoot } from "../providers";

////////////////////////////////
//  Helpers

const STATS = { hits: 0, misses: 0, entries: 0, generation: 0 };

// The install IS this checkout, so the lock's bundle stamp and the install's come from one file;
// a copy with a matched mtime compared unequal on one filesystem and read as a rebuilt daemon.
const INSTALL = lexiconRoot();
const whenBuilt = ["daemon.js", "version.json"].every((file) => existsSync(path.join(INSTALL, "dist", file)))
	? it
	: it.skip;

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
	// connect() reads the live host, so the record and the lock land in this test's state root.
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
	whenBuilt("reaches it through the record and answers through the facade", async () => {
		writeInstallRecord(INSTALL, host);
		const running = await launch({ handle: async (method) => (method === "cacheStats" ? STATS : null) });

		const session = await open({ workspaceRoot: workspace });

		expect(await session.cacheStats({})).toEqual(STATS);
		expect(session.lock().token).toBe(running.lock.token);
	});

	whenBuilt("gives up on a starting daemon at zero patience, naming what it waited on", async () => {
		writeInstallRecord(INSTALL, host);
		await launch({ startingNote: () => ({ retryInMs: 60_000, waitingFor: "the language providers to start" }) });
		const session = await open({ workspaceRoot: workspace, patience: 0 });

		const failed = session.cacheStats({});

		await expect(failed).rejects.toThrow(DaemonError);
		await expect(failed).rejects.toMatchObject({ waitingFor: "the language providers to start" });
	});

	whenBuilt("stops it on request and returns once the lock is gone", async () => {
		writeInstallRecord(INSTALL, host);
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
});
