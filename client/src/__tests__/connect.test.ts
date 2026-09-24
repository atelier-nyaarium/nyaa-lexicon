import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { connect, type Session } from "../connect";
import { bundleStamp } from "../discover";
import { DaemonError, Incompatible, NotInstalled } from "../errors";
import { writeInstallRecord } from "../install";
import { canonicalRoot, type PlatformEnv, workspacePaths } from "../paths";
import { CLIENT_BUILD_VERSION } from "../version";
import { type FakeAnswer, type FakeDaemon, fakeDaemon, ownLock } from "./fakeDaemon";

////////////////////////////////
//  Helpers

const TOKEN = "t".repeat(32);
/** A consumer bundles the client of the release it pins, so install, daemon and client agree. */
const BUILD = CLIENT_BUILD_VERSION;
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
	buildVersion: string = BUILD,
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
				buildVersion,
				bundleStamp: bundleStamp(install),
				protocolVersion,
			}),
		),
	);
	return fake;
}

/** A release directory as the build leaves it, settled, whose bundle leaves a mark when run. */
function releaseAt(parent: string, version: string): string {
	const root = path.join(parent, version);
	mkdirSync(path.join(root, "dist"), { recursive: true });
	const bundle = path.join(root, "dist", "daemon.js");
	writeFileSync(bundle, `require("node:fs").writeFileSync(process.argv[1] + ".ran", "");\n`);
	const past = new Date(Date.now() - 60_000);
	utimesSync(bundle, past, past);
	writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
	writeFileSync(
		path.join(root, "dist", "version.json"),
		JSON.stringify({ buildVersion: version, protocolVersion: PROTOCOL_VERSION }),
	);
	return root;
}

async function eventually(check: () => boolean, withinMs = 2_000): Promise<boolean> {
	for (let waited = 0; waited < withinMs; waited += 25) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return check();
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

	it("refuses an install that falls behind this client before a session lock read", async () => {
		writeInstallRecord(install, host);
		await daemonAnswering(serving);
		const session = await open({ workspaceRoot: workspace });
		installAt(install, "1.0.0");

		expect(() => session.lock()).toThrow(Incompatible);
	});

	// An older session's server can record an older release, and the cache can remove the one it
	// names; the release installed beside it is where a daemon now comes from.
	it("spawns from the newest settled release beside the one the record names", async () => {
		const cache = mkdtempSync(path.join(tmpdir(), "lexicon-connect-cache-"));
		try {
			const older = releaseAt(cache, "2.2.0");
			const newer = releaseAt(cache, "2.3.0");
			writeInstallRecord(older, host);

			// The fake bundle exits at once, so the spawn itself fails after running.
			await expect(connect({ workspaceRoot: workspace })).rejects.toThrow(DaemonError);

			expect(await eventually(() => existsSync(path.join(newer, "dist", "daemon.js.ran")))).toBe(true);
			expect(existsSync(path.join(older, "dist", "daemon.js.ran"))).toBe(false);
		} finally {
			rmSync(cache, { recursive: true, force: true });
		}
	});
});

// A consumer finding no install still reaches a daemon another consumer started, and never spawns
// or retires one, since it has no build of its own to put there.
describe("reaching a daemon with no install", () => {
	it("rides a daemon someone else started when nothing is recorded", async () => {
		const fake = await daemonAnswering(serving);

		const session = await open({ workspaceRoot: workspace });

		expect(await session.cacheStats({})).toEqual(STATS);
		expect(session.lock().port).toBe(fake.port);
	});

	// A patch can add a method without moving the protocol, so the protocol alone cannot vouch for it.
	it("leaves a daemon older than this client's build alone and reports nothing installed", async () => {
		const fake = await daemonAnswering(serving, PROTOCOL_VERSION, "0.0.1");

		const refused = connect({ workspaceRoot: workspace });

		await expect(refused).rejects.toThrow(NotInstalled);
		await expect(refused).rejects.toThrow(`the daemon runs 0.0.1, we run ${CLIENT_BUILD_VERSION}`);
		expect(fake.asked).toEqual([]);
		expect(existsSync(workspacePaths(host, workspace).lockFile)).toBe(true);
	});

	// An app update can delete the versioned folder a running session was given.
	it("keeps riding its daemon after the install it was given is removed", async () => {
		const fake = await daemonAnswering(serving);
		const session = await open({ workspaceRoot: workspace, lexiconRoot: install });
		expect(await session.cacheStats({})).toEqual(STATS);

		rmSync(install, { recursive: true, force: true });
		fake.dropConnections();
		while (fake.connections() > 0) await new Promise((resolve) => setTimeout(resolve, 5));

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
