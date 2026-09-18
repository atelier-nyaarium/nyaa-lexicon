import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { storePaths } from "@nyaa-lexicon/client";
import type { DaemonLock } from "@nyaa-lexicon/protocol";
import { claimLock, type HolderAlive, readLock } from "../daemonLock";

////////////////////////////////
//  Helpers

let root: string;

function lockFor(pid: number): DaemonLock {
	return {
		port: 1234,
		token: `${pid}`.repeat(12),
		pid,
		protocolVersion: "1.0.0",
		workspaceRoot: "/tmp/lexicon-test-workspace",
		startedAt: 0,
	};
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-lock-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the claim", () => {
	// A delete moves a store aside whole, a contender's staging file with it.
	it("restages when the directory is moved away before the link, and claims the fresh one", () => {
		const directory = path.join(root, "store");
		const lockFile = storePaths(directory).lockFile;
		mkdirSync(directory);
		writeFileSync(lockFile, JSON.stringify(lockFor(1111)));
		let moved = false;
		const stale: HolderAlive = () => {
			if (!moved) {
				moved = true;
				renameSync(directory, `${directory}.gone`);
			}
			return false;
		};

		const outcome = claimLock(lockFile, lockFor(2222), stale);

		// Not a resume: what is claimed at the fresh name is not the vanished holder's.
		expect(outcome).toEqual({ claimed: true });
		expect(readLock(lockFile)?.token).toBe(lockFor(2222).token);
		expect(readdirSync(directory)).toEqual([path.basename(lockFile)]);
	});

	it("claims cleanly with no stolen role when nothing was there to steal", () => {
		const directory = path.join(root, "store");
		const lockFile = storePaths(directory).lockFile;

		expect(claimLock(lockFile, lockFor(2222), () => true)).toEqual({ claimed: true });
	});

	it("names the stolen role when it steals a dead daemon's lock", () => {
		const directory = path.join(root, "store");
		const lockFile = storePaths(directory).lockFile;
		mkdirSync(directory);
		writeFileSync(lockFile, JSON.stringify(lockFor(1111)));

		expect(claimLock(lockFile, lockFor(2222), () => false)).toEqual({ claimed: true, stolenRole: "daemon" });
	});

	// A dead delete's own claim is stolen too, and its role rides along with it.
	it("names the stolen role when it steals a dead delete's lock", () => {
		const directory = path.join(root, "store");
		const lockFile = storePaths(directory).lockFile;
		mkdirSync(directory);
		writeFileSync(lockFile, JSON.stringify({ ...lockFor(1111), role: "delete" }));

		expect(claimLock(lockFile, lockFor(2222), () => false)).toEqual({ claimed: true, stolenRole: "delete" });
	});

	// An unreadable lock carries no role to trust, so stealing it never reads as a delete.
	it("reads an unparseable lock's stolen role as a daemon's, never a delete's", () => {
		const directory = path.join(root, "store");
		const lockFile = storePaths(directory).lockFile;
		mkdirSync(directory);
		writeFileSync(lockFile, "{ not a lock");

		expect(claimLock(lockFile, lockFor(2222), () => false)).toEqual({ claimed: true, stolenRole: "daemon" });
	});
});
