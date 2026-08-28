import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonOptions, type RunningDaemon, startDaemon } from "../daemon";
import { lexiconRoot } from "../providers";
import { BUILD_VERSION } from "../version";

////////////////////////////////
//  Helpers

const STATS = { hits: 0, misses: 0, entries: 0, generation: 0 };

/** The bundle this checkout's daemon stamps into its lock. Absent in a checkout never built. */
const OWN_BUNDLE = path.join(lexiconRoot(), "dist", "daemon.js");
const whenBuilt = existsSync(OWN_BUNDLE) ? it : it.skip;

let state: string;
let install: string;
let workspace: string;
let host: PlatformEnv;
let previousStateHome: string | undefined;
let daemon: RunningDaemon | undefined;
const sessions: Session[] = [];

/** An install wearing this daemon's identity: its build, and a bundle with the same size and mtime. */
function installLikeOurs(root: string): void {
	const bundle = path.join(root, "dist", "daemon.js");
	mkdirSync(path.dirname(bundle), { recursive: true });
	copyFileSync(OWN_BUNDLE, bundle);
	const own = statSync(OWN_BUNDLE);
	utimesSync(bundle, own.atime, own.mtime);
	writeFileSync(
		path.join(root, "dist", "version.json"),
		JSON.stringify({ buildVersion: BUILD_VERSION, protocolVersion: PROTOCOL_VERSION }),
	);
}

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
	install = mkdtempSync(path.join(tmpdir(), "lexicon-connect-install-"));
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
	for (const dir of [state, install, workspace]) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a session over a daemon this process started", () => {
	whenBuilt("reaches it through the record and answers through the facade", async () => {
		installLikeOurs(install);
		writeInstallRecord(install, host);
		const running = await launch({ handle: async (method) => (method === "cacheStats" ? STATS : null) });

		const session = await open({ workspaceRoot: workspace });

		expect(await session.cacheStats({})).toEqual(STATS);
		expect(session.lock().token).toBe(running.lock.token);
	});

	whenBuilt("gives up on a starting daemon at zero patience, naming what it waited on", async () => {
		installLikeOurs(install);
		writeInstallRecord(install, host);
		await launch({ startingNote: () => ({ retryInMs: 60_000, waitingFor: "the language providers to start" }) });
		const session = await open({ workspaceRoot: workspace, patience: 0 });

		const failed = session.cacheStats({});

		await expect(failed).rejects.toThrow(DaemonError);
		await expect(failed).rejects.toMatchObject({ waitingFor: "the language providers to start" });
	});

	whenBuilt("stops it on request and returns once the lock is gone", async () => {
		installLikeOurs(install);
		writeInstallRecord(install, host);
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
