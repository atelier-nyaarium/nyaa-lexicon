import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformEnv } from "../paths";
import { stateRoot, workspacePaths } from "../paths";
import { deleteProjectStore, listProjectStores } from "../projectStores";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

let stateDir: string;
let workDir: string;
let host: PlatformEnv;

const NOBODY_ALIVE = () => false;
const EVERYBODY_ALIVE = () => true;

/** A real index for `workspaceRoot`, written the way the daemon writes one. */
function seedStore(workspaceRoot: string): string {
	const paths = workspacePaths(host, workspaceRoot);
	mkdirSync(paths.dir, { recursive: true });
	IndexStore.open(paths.index, null, workspaceRoot).store.close();
	return path.basename(paths.dir);
}

function seedLock(workspaceRoot: string, pid: number): void {
	const paths = workspacePaths(host, workspaceRoot);
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(
		paths.lockFile,
		JSON.stringify({
			port: 1234,
			token: "t".repeat(48),
			pid,
			protocolVersion: "1.0.0",
			workspaceRoot,
			startedAt: 0,
		}),
	);
}

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "lexicon-stores-"));
	workDir = mkdtempSync(path.join(tmpdir(), "lexicon-work-"));
	host = { platform: "linux", env: { XDG_STATE_HOME: stateDir }, home: stateDir };
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("listing what this machine has indexed", () => {
	it("says nothing rather than throwing when no project has ever been indexed", () => {
		expect(listProjectStores(NOBODY_ALIVE, host)).toEqual([]);
	});

	it("reports the workspace an index was built from, with no daemon running", () => {
		seedStore(workDir);

		const [store] = listProjectStores(NOBODY_ALIVE, host);

		expect(store?.workspaceRoot).toBe(workDir);
		expect(store?.workspace).toBe("present");
		expect(store?.bytes).toBeGreaterThan(0);
		expect(store?.livePid).toBeNull();
	});

	it("reports the newest file indexing time", () => {
		const paths = workspacePaths(host, workDir);
		mkdirSync(paths.dir, { recursive: true });
		const indexed = IndexStore.open(paths.index, null, workDir).store;
		indexed.replaceFile("src/a.ts", "h1", [], []);
		indexed.close();

		expect(listProjectStores(NOBODY_ALIVE, host)[0]?.lastIndexedAt).toBeTypeOf("number");
	});

	// The whole reason the path is recorded: a hashed directory name cannot tell you whether the
	// project it indexed still exists, and that is exactly what "delete the long gone ones" needs.
	it("flags a store whose workspace is gone from disk", () => {
		const vanished = path.join(workDir, "was-here");
		mkdirSync(vanished);
		seedStore(vanished);
		rmSync(vanished, { recursive: true });

		const [store] = listProjectStores(NOBODY_ALIVE, host);

		expect(store?.workspaceRoot).toBe(vanished);
		expect(store?.workspace).toBe("missing");
	});

	// The defect a live probe found: an index written before the path was recorded looked exactly
	// like an abandoned one, so nine live repositories were listed as orphaned.
	it("says unknown, not missing, for an index that never recorded its workspace", () => {
		const paths = workspacePaths(host, workDir);
		mkdirSync(paths.dir, { recursive: true });
		IndexStore.open(paths.index).store.close();

		const [store] = listProjectStores(NOBODY_ALIVE, host);

		expect(store?.workspaceRoot).toBeNull();
		expect(store?.workspace).toBe("unknown");
	});

	it("names the pid serving a store, and ignores a lock whose process is gone", () => {
		seedStore(workDir);
		seedLock(workDir, 4242);

		expect(listProjectStores(EVERYBODY_ALIVE, host)[0]?.livePid).toBe(4242);
		expect(listProjectStores(NOBODY_ALIVE, host)[0]?.livePid).toBeNull();
	});

	it("lists every project, not just the one asked about", () => {
		const other = path.join(workDir, "second");
		mkdirSync(other);
		seedStore(workDir);
		seedStore(other);

		expect(listProjectStores(NOBODY_ALIVE, host)).toHaveLength(2);
	});
});

describe("deleting a project's index", () => {
	it("removes the whole state directory and reports what it freed", () => {
		const key = seedStore(workDir);

		const outcome = deleteProjectStore(key, NOBODY_ALIVE, host);

		expect(outcome).toMatchObject({ deleted: true, key });
		expect(existsSync(path.join(stateRoot(host), key))).toBe(false);
		expect(listProjectStores(NOBODY_ALIVE, host)).toEqual([]);
	});

	// Deleting a file under its own live writer corrupts what it is mid-write, so the refusal
	// names the way out rather than just saying no.
	it("refuses while a daemon is serving it, and says how to proceed", () => {
		const key = seedStore(workDir);
		seedLock(workDir, 4242);

		const outcome = deleteProjectStore(key, EVERYBODY_ALIVE, host);

		expect(outcome).toMatchObject({ deleted: false });
		expect((outcome as { reason: string }).reason).toContain("4242");
		expect((outcome as { reason: string }).reason).toContain("shut it down first");
		expect(existsSync(path.join(stateRoot(host), key))).toBe(true);
	});

	it("refuses a key naming no store rather than reporting a delete that did nothing", () => {
		seedStore(workDir);

		expect(deleteProjectStore("not-a-real-store", NOBODY_ALIVE, host)).toMatchObject({ deleted: false });
		expect(listProjectStores(NOBODY_ALIVE, host)).toHaveLength(1);
	});

	// A key is a directory NAME. One carrying separators would leave the state root entirely, and
	// this is the only irreversible operation in the codebase.
	it("refuses a key that would escape the state root", () => {
		seedStore(workDir);

		for (const key of ["..", "../..", "a/b", "a\\b", ""]) {
			expect(deleteProjectStore(key, NOBODY_ALIVE, host)).toMatchObject({ deleted: false });
		}
		expect(existsSync(stateDir)).toBe(true);
	});
});
