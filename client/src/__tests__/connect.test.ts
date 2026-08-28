import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Session } from "../connect";
import { bundleStamp } from "../discover";
import { DaemonError, Incompatible, NotInstalled } from "../errors";
import { writeInstallRecord } from "../install";
import { canonicalRoot, type PlatformEnv, workspacePaths } from "../paths";
import { type FakeAnswer, type FakeDaemon, fakeDaemon, ownLock } from "./fakeDaemon";

////////////////////////////////
//  Helpers

const TOKEN = "t".repeat(32);
const BUILD = "2.2.0";
const STATS = { hits: 1, misses: 2, entries: 3, generation: 4 };

let state: string;
let install: string;
let workspace: string;
let host: PlatformEnv;
let previousStateHome: string | undefined;
const fakes: FakeDaemon[] = [];
const sessions: Session[] = [];

/** A checkout as the build leaves it: a bundle and a version file under dist/. */
function installAt(root: string, protocolVersion: string = PROTOCOL_VERSION): void {
	mkdirSync(path.join(root, "dist"), { recursive: true });
	writeFileSync(path.join(root, "dist", "daemon.js"), "// bundle\n");
	writeFileSync(path.join(root, "dist", "version.json"), JSON.stringify({ buildVersion: BUILD, protocolVersion }));
}

/** A daemon serving the workspace, its lock wearing the install's identity. */
async function daemonAnswering(
	answer: (method: string) => FakeAnswer | Promise<FakeAnswer>,
	protocolVersion: string = PROTOCOL_VERSION,
): Promise<FakeDaemon> {
	const fake = await fakeDaemon({ token: TOKEN, answer, protocolVersion });
	fakes.push(fake);
	const paths = workspacePaths(host, workspace);
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(
		paths.lockFile,
		JSON.stringify(
			ownLock({
				port: fake.port,
				token: TOKEN,
				workspaceRoot: canonicalRoot(workspace),
				buildVersion: BUILD,
				bundleStamp: bundleStamp(install),
				protocolVersion,
			}),
		),
	);
	return fake;
}

const serving = (method: string): FakeAnswer => {
	if (method === "cacheStats") return { ok: true, result: STATS };
	if (method === "shutdown") {
		rmSync(workspacePaths(host, workspace).lockFile, { force: true });
		return { ok: true, result: { stopping: true } };
	}
	return { ok: false, error: `unknown method: ${method}` };
};

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
	installAt(install);
});

afterEach(async () => {
	for (const session of sessions.splice(0)) session.close();
	for (const fake of fakes.splice(0)) await fake.close();
	if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
	else process.env["XDG_STATE_HOME"] = previousStateHome;
	for (const dir of [state, install, workspace]) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("reaching a daemon", () => {
	it("finds the running daemon through the record and answers through the facade and through ask", async () => {
		writeInstallRecord(install, host);
		const fake = await daemonAnswering(serving);

		const session = await open({ workspaceRoot: workspace });

		expect(await session.cacheStats({})).toEqual(STATS);
		expect(await session.ask("cacheStats", {})).toEqual(STATS);
		expect(fake.asked).toEqual(["cacheStats", "cacheStats"]);
		expect(session.lock().port).toBe(fake.port);
	});

	it("takes an explicit lexiconRoot over the record", async () => {
		writeInstallRecord(path.join(state, "moved-away"), host);
		await daemonAnswering(serving);

		const session = await open({ workspaceRoot: workspace, lexiconRoot: install });

		expect(await session.cacheStats({})).toEqual(STATS);
	});

	it("rides an install and a daemon ahead of this client's protocol major", async () => {
		const ahead = "99.0.0";
		installAt(install, ahead);
		writeInstallRecord(install, host);
		await daemonAnswering(serving, ahead);

		const session = await open({ workspaceRoot: workspace });

		expect(await session.cacheStats({})).toEqual(STATS);
	});
});

describe("refusing before any daemon is asked", () => {
	it("says nothing is installed when there is no record", async () => {
		const refused = connect({ workspaceRoot: workspace });

		await expect(refused).rejects.toThrow(NotInstalled);
		await expect(refused).rejects.toMatchObject({ root: undefined });
	});

	it("names the root a record points at once nothing built is there", async () => {
		const gone = path.join(state, "moved-away");
		writeInstallRecord(gone, host);

		const refused = connect({ workspaceRoot: workspace });

		await expect(refused).rejects.toThrow(NotInstalled);
		await expect(refused).rejects.toMatchObject({ root: gone, message: expect.stringContaining(gone) });
	});

	it("names the root given explicitly once nothing built is there", async () => {
		const empty = mkdtempSync(path.join(tmpdir(), "lexicon-connect-empty-"));
		try {
			await expect(connect({ workspaceRoot: workspace, lexiconRoot: empty })).rejects.toMatchObject({
				name: "NotInstalled",
				root: empty,
			});
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	// No lock and a bundle that would exit at once: had the lock been read, this would have spawned
	// and failed as a DaemonError instead.
	it("refuses an install behind this client's protocol major, naming both, before reading any lock", async () => {
		installAt(install, "1.0.0");
		writeInstallRecord(install, host);

		const refused = connect({ workspaceRoot: workspace });

		await expect(refused).rejects.toThrow(Incompatible);
		await expect(refused).rejects.toMatchObject({ client: PROTOCOL_VERSION, installed: "1.0.0" });
	});
});

describe("what the daemon says back", () => {
	it("carries the daemon's own refusal as a DaemonError", async () => {
		writeInstallRecord(install, host);
		await daemonAnswering(() => ({ ok: false, error: "unknown method: cacheStats (this daemon runs 9.9.9)" }));
		const session = await open({ workspaceRoot: workspace });

		const refused = session.cacheStats({});

		await expect(refused).rejects.toThrow(DaemonError);
		await expect(refused).rejects.toThrow(/unknown method: cacheStats/);
	});

	it("gives up at once on a starting daemon with no patience, naming what it waited on", async () => {
		writeInstallRecord(install, host);
		const fake = await daemonAnswering(() => ({
			ok: false,
			error: "the daemon is starting, waiting on the warmup pass",
			starting: true,
			retryInMs: 60_000,
			waitingFor: "the warmup pass",
		}));
		const session = await open({ workspaceRoot: workspace, patience: 0 });

		const failed = session.cacheStats({});

		await expect(failed).rejects.toThrow(DaemonError);
		await expect(failed).rejects.toMatchObject({ waitingFor: "the warmup pass" });
		expect(fake.asked).toEqual(["cacheStats"]);
	});
});

describe("stopping the daemon", () => {
	it("asks it to stop and returns once its lock is gone", async () => {
		writeInstallRecord(install, host);
		const fake = await daemonAnswering(serving);
		const session = await open({ workspaceRoot: workspace });
		const lockFile = workspacePaths(host, workspace).lockFile;
		expect(existsSync(lockFile)).toBe(true);

		await session.stopDaemon();

		expect(existsSync(lockFile)).toBe(false);
		expect(fake.asked).toEqual(["shutdown"]);
	});
});
