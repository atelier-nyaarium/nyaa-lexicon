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

		expect(outcome).toEqual({ claimed: true });
		expect(readLock(lockFile)?.token).toBe(lockFor(2222).token);
		expect(readdirSync(directory)).toEqual([path.basename(lockFile)]);
	});
});
