import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { bundleStamp, daemonCommand, findDaemon, lockHolderAlive, processIsAlive } from "../discover";
import { canonicalRoot, type PlatformEnv, workspacePaths } from "../paths";
import { processIdentity } from "../procfs";

////////////////////////////////
//  Helpers

/** A pid that certainly ran and certainly exited, for dead-holder cases. */
function deadPid(): number {
	const child = spawnSync("true");
	if (child.pid === undefined) throw new Error("could not spawn a child to die");
	return child.pid;
}

const onLinux = process.platform === "linux" ? it : it.skip;

const made: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** A lock this very process holds, so liveness and identity both pass. */
function ownLock(workspaceRoot: string, buildVersion: string) {
	const identity = processIdentity(process.pid);
	return {
		port: 41234,
		token: "t".repeat(32),
		pid: process.pid,
		...(identity === null ? {} : { pidStart: identity.startTicks }),
		protocolVersion: PROTOCOL_VERSION,
		buildVersion,
		workspaceRoot,
		startedAt: 1,
	};
}

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

// Issue #7: kill(0) said a dead daemon's lock was live, because its pid had been reused. Ticks
// are minted at birth, so a reused pid can never present the old ones.
describe("judging a lock holder", () => {
	it("accepts the very process that wrote the lock", () => {
		const identity = processIdentity(process.pid);
		const holder = identity === null ? { pid: process.pid } : { pid: process.pid, pidStart: identity.startTicks };

		expect(lockHolderAlive(holder)).toBe(true);
	});

	onLinux("rejects a live pid wearing someone else's birth ticks", () => {
		expect(processIsAlive(process.pid)).toBe(true);
		expect(lockHolderAlive({ pid: process.pid, pidStart: "1" })).toBe(false);
	});

	it("rejects a dead pid outright", () => {
		expect(lockHolderAlive({ pid: deadPid() })).toBe(false);
	});

	it("still accepts a lock too old to carry an identity", () => {
		expect(lockHolderAlive({ pid: process.pid })).toBe(true);
	});
});

describe("finding a daemon on disk", () => {
	const source = { buildVersion: "1.10.2", bundleStamp: null };

	it("spawns when the workspace has no lock at all", () => {
		const state = scratch("lexicon-find-");
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: state }, home: state };

		expect(findDaemon("/w", source, host)).toMatchObject({ action: "spawn", reason: "no daemon is registered" });
	});

	it("connects to a live lock judged against the source it is given", () => {
		const state = scratch("lexicon-find-");
		const workspace = scratch("lexicon-work-");
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: state }, home: state };
		const paths = workspacePaths(host, workspace);
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.lockFile, JSON.stringify(ownLock(canonicalRoot(workspace), "1.10.2")));

		expect(findDaemon(workspace, source, host)).toMatchObject({ action: "connect" });
		expect(findDaemon(workspace, { ...source, buildVersion: "1.11.0" }, host)).toMatchObject({
			action: "replace",
			cause: "build",
		});
	});

	// A custom directory is the store's identity: the lock is read there and nowhere else.
	it("reads the lock from a caller's own state directory when one is given", () => {
		const state = scratch("lexicon-find-");
		const custom = scratch("lexicon-custom-");
		const workspace = scratch("lexicon-work-");
		const host: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: state }, home: state };
		writeFileSync(path.join(custom, "daemon.json"), JSON.stringify(ownLock(canonicalRoot(workspace), "1.10.2")));

		expect(findDaemon(workspace, source, host, custom)).toMatchObject({ action: "connect" });
		expect(findDaemon(workspace, source, host)).toMatchObject({ action: "spawn" });
	});
});

describe("the bundle under a root", () => {
	it("stamps and commands nothing when the root was never built", () => {
		const root = scratch("lexicon-root-");

		expect(bundleStamp(root)).toBeNull();
		expect(daemonCommand(root, "/w")).toBeNull();
	});

	it("runs the bundle on this runtime against the workspace it is given", () => {
		const root = scratch("lexicon-root-");
		const bundle = path.join(root, "dist", "daemon.js");
		mkdirSync(path.dirname(bundle), { recursive: true });
		writeFileSync(bundle, "// bundle\n");

		expect(bundleStamp(root)).toMatch(/^1:[0-9a-f]{16}$/);
		expect(daemonCommand(root, "/w")).toEqual([process.execPath, bundle, "/w"]);
	});

	// A provider rebuilt alone must retire a daemon still serving its old copy.
	it("changes its stamp when any bundle under dist changes, not only the daemon's", () => {
		const root = scratch("lexicon-root-");
		const provider = path.join(root, "dist", "providers", "alpha", "main.js");
		mkdirSync(path.dirname(provider), { recursive: true });
		writeFileSync(path.join(root, "dist", "daemon.js"), "// daemon\n");
		writeFileSync(provider, "// provider\n");
		const before = bundleStamp(root);

		writeFileSync(provider, "// provider, rebuilt\n");

		expect(before).toMatch(/^2:[0-9a-f]{16}$/);
		expect(bundleStamp(root)).not.toBe(before);
	});

	// Two plugin hosts install the same release into two directories, each copy with its own mtimes;
	// equal bytes must agree or their daemons retire each other on every connect.
	it("stamps two copies of the same bundles alike, whatever their mtimes", () => {
		const first = scratch("lexicon-root-");
		const second = scratch("lexicon-root-");
		for (const root of [first, second]) {
			mkdirSync(path.join(root, "dist", "providers", "alpha"), { recursive: true });
			writeFileSync(path.join(root, "dist", "daemon.js"), "// daemon\n");
			writeFileSync(path.join(root, "dist", "providers", "alpha", "main.js"), "// provider\n");
		}
		const past = new Date(Date.now() - 86_400_000);
		utimesSync(path.join(second, "dist", "daemon.js"), past, past);
		utimesSync(path.join(second, "dist", "providers", "alpha", "main.js"), past, past);

		expect(bundleStamp(second)).toBe(bundleStamp(first));
	});

	// A directory or dangling symlink wearing the name is not a program.
	it("refuses a directory wearing the bundle's name", () => {
		const root = scratch("lexicon-root-");
		mkdirSync(path.join(root, "dist", "daemon.js"), { recursive: true });

		expect(daemonCommand(root, "/w")).toBeNull();
	});
});
