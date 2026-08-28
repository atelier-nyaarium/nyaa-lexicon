import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalRoot, type PlatformEnv, stateRoot, storePaths, workspacePaths } from "@nyaa-lexicon/client";
import { registerProject } from "../projectRegistry";
import {
	deleteProjectStore,
	findProjectStore,
	type HolderAlive,
	listProjectStores,
	type ProjectStore,
	storeKeyFor,
} from "../projectStores";
import { IndexStore } from "../store";

////////////////////////////////
//  Helpers

let stateDir: string;
let workDir: string;
let host: PlatformEnv;

const NOBODY_ALIVE = () => false;
const EVERYBODY_ALIVE = () => true;
const admitAll = () => ({ admitted: true });

/** A real index for `workspaceRoot`, written the way the daemon writes one. */
function seedStore(workspaceRoot: string): string {
	const paths = workspacePaths(host, workspaceRoot);
	mkdirSync(paths.dir, { recursive: true });
	IndexStore.open(paths.index, null, workspaceRoot).store.close();
	return path.basename(paths.dir);
}

/** The same, in a directory the project chose: registered, so the listing knows to look there.
 * Directory admission is injected, since the mode rule belongs to its own tests and to no umask. */
function seedCustom(workspaceRoot: string, directory: string): void {
	mkdirSync(directory, { recursive: true });
	const outcome = registerProject(workspaceRoot, admitAll, host, directory, admitAll);
	if (!outcome.registered) throw new Error(outcome.reason);
	IndexStore.open(storePaths(directory).index, null, workspaceRoot).store.close();
}

function seedLock(workspaceRoot: string, pid: number, directory = workspacePaths(host, workspaceRoot).dir): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		storePaths(directory).lockFile,
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

/** As a caller resolves what was typed: against the listing, or not at all. */
function resolve(reference: string, isAlive: HolderAlive = NOBODY_ALIVE): ProjectStore {
	const store = findProjectStore(reference, listProjectStores(isAlive, host));
	if (store === null) throw new Error(`no store for ${reference}`);
	return store;
}

beforeEach(() => {
	// Canonical, so a temp directory reached through a link (macOS /var) compares as itself.
	stateDir = canonicalRoot(mkdtempSync(path.join(tmpdir(), "lexicon-stores-")));
	workDir = canonicalRoot(mkdtempSync(path.join(tmpdir(), "lexicon-work-")));
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
		const directory = path.join(stateRoot(host), key);
		writeFileSync(`${storePaths(directory).logFile}.old`, "rotated");

		const outcome = deleteProjectStore(resolve(key), NOBODY_ALIVE, host);

		expect(outcome).toMatchObject({ deleted: true, key, directory });
		expect(existsSync(directory)).toBe(false);
		expect(listProjectStores(NOBODY_ALIVE, host)).toEqual([]);
	});

	// Deleting a file under its own live writer corrupts what it is mid-write, so the refusal
	// names the way out rather than just saying no.
	it("refuses while a daemon is serving it, and says how to proceed", () => {
		const key = seedStore(workDir);
		seedLock(workDir, 4242);

		const outcome = deleteProjectStore(resolve(key, EVERYBODY_ALIVE), EVERYBODY_ALIVE, host);

		expect(outcome).toMatchObject({ deleted: false });
		expect((outcome as { reason: string }).reason).toContain("4242");
		expect((outcome as { reason: string }).reason).toContain("shut it down first");
		expect(existsSync(path.join(stateRoot(host), key))).toBe(true);
	});

	// A store is deleted as the listing showed it, never as a path built from what was typed: a
	// reference matching no row resolves to nothing, and a directory the listing never named is
	// refused even when handed over directly. This is the only irreversible operation here.
	it("deletes nothing that the listing did not name", () => {
		seedStore(workDir);
		const stores = listProjectStores(NOBODY_ALIVE, host);

		for (const reference of ["not-a-real-store", "..", "../..", "a/b", "a\\b", "", stateRoot(host)]) {
			expect(findProjectStore(reference, stores)).toBeNull();
		}
		expect(deleteProjectStore({ directory: stateRoot(host) }, NOBODY_ALIVE, host)).toMatchObject({
			deleted: false,
		});
		expect(deleteProjectStore({ directory: stateDir }, NOBODY_ALIVE, host)).toMatchObject({ deleted: false });
		expect(listProjectStores(NOBODY_ALIVE, host)).toHaveLength(1);
		expect(existsSync(stateDir)).toBe(true);
	});
});

describe("a store in a directory the project chose", () => {
	it("is listed beside the state root's children, with its directory and its registry key", () => {
		const custom = path.join(workDir, "refs-store");
		seedStore(workDir);
		seedCustom(workDir, custom);

		const stores = listProjectStores(NOBODY_ALIVE, host);

		expect(stores.map((store) => [store.custom, store.directory]).sort()).toEqual([
			[false, workspacePaths(host, workDir).dir],
			[true, custom],
		]);
		expect(stores.find((store) => store.custom)).toMatchObject({
			key: storeKeyFor(workDir),
			workspaceRoot: workDir,
			workspace: "present",
		});
	});

	it("is listed once when the registry names a directory already under the state root", () => {
		const key = seedStore(workDir);
		const other = path.join(workDir, "second");
		mkdirSync(other);
		seedCustom(other, path.join(stateRoot(host), key));

		const stores = listProjectStores(NOBODY_ALIVE, host);

		expect(stores).toHaveLength(1);
		expect(stores[0]).toMatchObject({ key, custom: false, directory: path.join(stateRoot(host), key) });
	});

	it("is named by its directory; its key names the default store or nothing", () => {
		const custom = path.join(workDir, "refs-store");
		const other = path.join(workDir, "second");
		mkdirSync(other);
		const key = seedStore(workDir);
		seedCustom(other, custom);
		const stores = listProjectStores(NOBODY_ALIVE, host);

		expect(findProjectStore(key, stores)).toMatchObject({ custom: false });
		expect(findProjectStore(path.join(stateRoot(host), key), stores)).toMatchObject({ custom: false });
		expect(findProjectStore(custom, stores)).toMatchObject({ custom: true, key: storeKeyFor(other) });
		expect(findProjectStore(storeKeyFor(other), stores)).toBeNull();
	});

	// The owner chose the directory, so only what the daemon wrote there is lexicon's to remove.
	it("is deleted by its directory, leaving the owner's other files and the directory they sit in", () => {
		const custom = path.join(workDir, "refs-store");
		seedCustom(workDir, custom);
		const paths = storePaths(custom);
		writeFileSync(paths.logFile, "log");
		writeFileSync(paths.diagnosticsFile, "{}");
		mkdirSync(paths.reportsDir);
		writeFileSync(path.join(paths.reportsDir, "report.1.json"), "{}");
		writeFileSync(path.join(custom, "notes.txt"), "mine");

		const outcome = deleteProjectStore(resolve(custom), NOBODY_ALIVE, host);

		expect(outcome).toMatchObject({ deleted: true, directory: custom, key: storeKeyFor(workDir) });
		expect(readdirSync(custom)).toEqual(["notes.txt"]);
	});

	it("takes an emptied directory with it, and refuses one a daemon is serving", () => {
		const custom = path.join(workDir, "refs-store");
		seedCustom(workDir, custom);
		seedLock(workDir, 4242, custom);

		const refused = deleteProjectStore(resolve(custom, EVERYBODY_ALIVE), EVERYBODY_ALIVE, host);
		expect(refused).toMatchObject({ deleted: false, reason: expect.stringContaining("4242") });
		expect(existsSync(storePaths(custom).index)).toBe(true);

		expect(deleteProjectStore(resolve(custom), NOBODY_ALIVE, host)).toMatchObject({ deleted: true });
		expect(existsSync(custom)).toBe(false);
	});
});
