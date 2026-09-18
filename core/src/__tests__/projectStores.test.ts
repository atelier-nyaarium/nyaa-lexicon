import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalRoot, type PlatformEnv, stateRoot, storePaths, workspacePaths } from "@nyaa-lexicon/client";
import type { DaemonLock } from "@nyaa-lexicon/protocol";
import type { Clock } from "../clock";
import { claimLock, type HolderAlive, readLock } from "../daemonLock";
import { registerProject } from "../projectRegistry";
import {
	deleteProjectStore,
	findProjectStore,
	finishAbandonedDelete,
	listProjectStores,
	PRUNE_AFTER_MS,
	type ProjectStore,
	pruneProjectStores,
	stampIndex,
	stampProjectStores,
	storeKeyFor,
} from "../projectStores";
import { IndexStore } from "../store";
import { fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

let stateDir: string;
let workDir: string;
let host: PlatformEnv;

const NOBODY_ALIVE = () => false;
const EVERYBODY_ALIVE = () => true;
const admitAll = () => ({ admitted: true });

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** A real index for `workspaceRoot`, written the way the daemon writes one, at the clock's time. */
function seedStore(workspaceRoot: string, clock?: Clock): string {
	const paths = workspacePaths(host, workspaceRoot);
	mkdirSync(paths.dir, { recursive: true });
	IndexStore.open(paths.index, null, workspaceRoot, clock).store.close();
	return path.basename(paths.dir);
}

/** A workspace under `workDir`, indexed at `seenAt`, then removed from disk. */
function seedOrphan(name: string, seenAt: number): string {
	const root = path.join(workDir, name);
	mkdirSync(root);
	const key = seedStore(root, fakeClock(seenAt));
	rmSync(root, { recursive: true });
	return key;
}

/** One file indexed at the clock's time. */
function indexFileAt(workspaceRoot: string, clock: Clock): void {
	const paths = workspacePaths(host, workspaceRoot);
	const indexed = IndexStore.open(paths.index, null, workspaceRoot, clock).store;
	indexed.replaceFile({ module: "src/a.ts", contentHash: "h1", declarations: [], references: [] });
	indexed.close();
}

/** As a store written before the stamp existed. */
function unstamp(workspaceRoot: string): void {
	const db = new DatabaseSync(workspacePaths(host, workspaceRoot).index);
	db.exec("DELETE FROM meta WHERE key = 'lastSeenAt'");
	db.close();
}

/** The raw seen stamp on disk, read outside the listing, so a stamp attempt leaves a trace here
 * even when the listing's own answer says nothing changed. */
function seenValue(directory: string): string | undefined {
	const db = new DatabaseSync(storePaths(directory).index, { readOnly: true });
	try {
		const row = db.prepare("SELECT value FROM meta WHERE key = 'lastSeenAt'").get() as
			| { value: string }
			| undefined;
		return row?.value;
	} finally {
		db.close();
	}
}

function seenOf(key: string, stores = listProjectStores(NOBODY_ALIVE, host)): number | null | undefined {
	return stores.find((store) => store.key === key)?.lastSeenAt;
}

/** The same, in a directory the project chose: registered, so the listing knows to look there.
 * Directory admission is injected, since the mode rule belongs to its own tests and to no umask. */
function seedCustom(workspaceRoot: string, directory: string): void {
	mkdirSync(directory, { recursive: true });
	const outcome = registerProject(workspaceRoot, admitAll, host, directory, admitAll);
	if (!outcome.registered) throw new Error(outcome.reason);
	IndexStore.open(storePaths(directory).index, null, workspaceRoot).store.close();
}

function lockFor(workspaceRoot: string, pid: number): DaemonLock {
	return { port: 1234, token: "t".repeat(48), pid, protocolVersion: "1.0.0", workspaceRoot, startedAt: 0 };
}

function seedLock(workspaceRoot: string, pid: number, directory = workspacePaths(host, workspaceRoot).dir): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(storePaths(directory).lockFile, JSON.stringify(lockFor(workspaceRoot, pid)));
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
		indexed.replaceFile({
			module: "src/a.ts",
			contentHash: "h1",
			declarations: [],
			references: [],
		});
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

	// An index written before the path was recorded is unknown, never abandoned.
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

	// A delete's own claim on the store's lock is not a daemon serving it.
	it("names no daemon at all while a delete is claiming the store's lock", () => {
		seedStore(workDir);
		const directory = workspacePaths(host, workDir).dir;
		writeFileSync(storePaths(directory).lockFile, JSON.stringify({ ...lockFor(workDir, 4242), role: "delete" }));

		expect(listProjectStores(EVERYBODY_ALIVE, host)[0]?.livePid).toBeNull();
	});

	// The lock's role is read before the index is.
	it("answers deleting without reading or stamping the index while a delete claims it", () => {
		const key = seedStore(workDir);
		const directory = workspacePaths(host, workDir).dir;
		writeFileSync(storePaths(directory).lockFile, JSON.stringify({ ...lockFor(workDir, 4242), role: "delete" }));

		const [listed] = listProjectStores(EVERYBODY_ALIVE, host);
		expect(listed).toMatchObject({
			key,
			deleting: true,
			livePid: null,
			workspaceRoot: null,
			lastIndexedAt: null,
			lastSeenAt: null,
		});

		const before = seenValue(directory);
		const [stamped] = stampProjectStores(EVERYBODY_ALIVE, NOW, host);
		expect(stamped?.lastSeenAt).toBeNull();
		expect(seenValue(directory)).toBe(before);
	});

	it("lists every project, not just the one asked about", () => {
		const other = path.join(workDir, "second");
		mkdirSync(other);
		seedStore(workDir);
		seedStore(other);

		expect(listProjectStores(NOBODY_ALIVE, host)).toHaveLength(2);
	});

	// A delete moves a default directory aside before removing it; what sits there is not a store.
	it("never lists a directory a delete moved aside", () => {
		const key = seedStore(workDir);
		mkdirSync(path.join(stateRoot(host), `${key}.4242.removing`));

		expect(listProjectStores(NOBODY_ALIVE, host).map((store) => store.key)).toEqual([key]);
	});
});

describe("when a workspace was last seen", () => {
	it("reads a store with no stamp as its newest indexing, or as undated", () => {
		const key = seedStore(workDir, fakeClock(NOW));
		indexFileAt(workDir, fakeClock(NOW + DAY));
		unstamp(workDir);
		const empty = path.join(workDir, "empty");
		mkdirSync(empty);
		const emptyKey = seedStore(empty, fakeClock(NOW));
		unstamp(empty);

		const stores = listProjectStores(NOBODY_ALIVE, host);

		expect(seenOf(key, stores)).toBe(NOW + DAY);
		expect(seenOf(emptyKey, stores)).toBeNull();
	});

	// A daemon opening on its root has seen it, and a clock behind what is held changes nothing.
	it("is stamped forward when a daemon opens on its root, never backward", () => {
		const key = seedStore(workDir, fakeClock(NOW));
		expect(seenOf(key)).toBe(NOW);

		seedStore(workDir, fakeClock(NOW + DAY));
		expect(seenOf(key)).toBe(NOW + DAY);

		seedStore(workDir, fakeClock(NOW - DAY));
		expect(seenOf(key)).toBe(NOW + DAY);
	});

	// Indexing a file is seeing the workspace, and a daemon stamps only when it opens.
	it("reads the later of the stamp and the newest indexing", () => {
		const clock = fakeClock(NOW);
		const key = seedStore(workDir, clock);
		const indexed = IndexStore.open(workspacePaths(host, workDir).index, null, workDir, clock).store;
		clock.advance(2 * DAY);
		indexed.replaceFile({ module: "src/a.ts", contentHash: "h1", declarations: [], references: [] });
		indexed.close();

		const [store] = listProjectStores(NOBODY_ALIVE, host);
		expect(store?.key).toBe(key);
		expect(store?.lastSeenAt).toBe(NOW + 2 * DAY);
		expect(store?.lastIndexedAt).toBe(NOW + 2 * DAY);
	});

	// A clock behind the newest indexing still writes the row, so the seed outlives the file rows.
	it("keeps a value seeded from the newest indexing once those file rows are gone", () => {
		const key = seedStore(workDir, fakeClock(NOW));
		indexFileAt(workDir, fakeClock(NOW + DAY));
		unstamp(workDir);

		const stamped = stampProjectStores(NOBODY_ALIVE, NOW, host);
		expect(seenOf(key, stamped)).toBe(NOW + DAY);

		const db = new DatabaseSync(workspacePaths(host, workDir).index);
		db.exec("DELETE FROM files");
		db.close();
		expect(seenOf(key)).toBe(NOW + DAY);
	});

	it("stamps a present workspace forward only, and leaves a missing or unrecorded one alone", () => {
		const present = seedStore(workDir, fakeClock(NOW));
		const missing = seedOrphan("gone", NOW);
		const unrecorded = path.join(workDir, "unrecorded");
		mkdirSync(unrecorded);
		const paths = workspacePaths(host, unrecorded);
		mkdirSync(paths.dir, { recursive: true });
		IndexStore.open(paths.index).store.close();
		const unrecordedKey = path.basename(paths.dir);

		const behind = stampProjectStores(NOBODY_ALIVE, NOW - DAY, host);
		expect(seenOf(present, behind)).toBe(NOW);

		const ahead = stampProjectStores(NOBODY_ALIVE, NOW + 7 * DAY, host);
		expect(seenOf(present, ahead)).toBe(NOW + 7 * DAY);
		expect(seenOf(present)).toBe(NOW + 7 * DAY);
		expect(seenOf(missing, ahead)).toBe(NOW);
		expect(seenOf(unrecordedKey, ahead)).toBeNull();
	});
});

// The stamp reads the lock and the file fresh, immediately before it opens either.
describe("the stamp's own re-check right before it writes", () => {
	it("refuses a store a live delete claims, read fresh rather than trusted from a prior look", () => {
		const directory = workspacePaths(host, workDir).dir;
		seedStore(workDir);
		const before = seenValue(directory);
		writeFileSync(storePaths(directory).lockFile, JSON.stringify({ ...lockFor(workDir, 4242), role: "delete" }));

		expect(stampIndex(directory, EVERYBODY_ALIVE, NOW)).toBeNull();
		expect(seenValue(directory)).toBe(before);
	});

	it("refuses without creating a ghost index when the file is not there to open", () => {
		const directory = path.join(workDir, "renamed-away");
		mkdirSync(directory, { recursive: true });
		const index = storePaths(directory).index;

		expect(stampIndex(directory, NOBODY_ALIVE, NOW)).toBeNull();
		expect(existsSync(index)).toBe(false);
	});

	it("still stamps a present store with no delete claiming it", () => {
		seedStore(workDir);
		const directory = workspacePaths(host, workDir).dir;

		expect(stampIndex(directory, NOBODY_ALIVE, NOW)).toBe(NOW);
	});
});

describe("pruning orphans", () => {
	// The three that must survive: a present workspace however stale its stamp, an index that never
	// recorded its root, and one a daemon is serving.
	it("deletes an orphan unseen past the horizon and nothing else", () => {
		const stale = seedOrphan("stale", NOW - PRUNE_AFTER_MS - DAY);
		const recent = seedOrphan("recent", NOW - PRUNE_AFTER_MS + DAY);
		const boundary = seedOrphan("boundary", NOW - PRUNE_AFTER_MS);
		const undated = seedOrphan("undated", NOW);
		unstamp(path.join(workDir, "undated"));
		const present = seedStore(workDir, fakeClock(NOW - PRUNE_AFTER_MS - DAY));
		const unrecordedPaths = workspacePaths(host, path.join(workDir, "unrecorded"));
		mkdirSync(unrecordedPaths.dir, { recursive: true });
		const unrecorded = IndexStore.open(
			unrecordedPaths.index,
			null,
			undefined,
			fakeClock(NOW - PRUNE_AFTER_MS - DAY),
		);
		unrecorded.store.replaceFile({ module: "src/a.ts", contentHash: "h1", declarations: [], references: [] });
		unrecorded.store.close();
		const served = path.join(workDir, "served");
		mkdirSync(served);
		const servedKey = seedStore(served, fakeClock(NOW - PRUNE_AFTER_MS - DAY));
		rmSync(served, { recursive: true });
		seedLock(served, 4242);

		const pruned = pruneProjectStores(EVERYBODY_ALIVE, NOW, host);

		expect(pruned.map(({ store, outcome }) => [store.key, outcome.deleted])).toEqual([[stale, true]]);
		expect(existsSync(path.join(stateRoot(host), stale))).toBe(false);
		const kept = listProjectStores(EVERYBODY_ALIVE, host).map((store) => store.key);
		expect(kept.sort()).toEqual(
			[recent, boundary, undated, present, path.basename(unrecordedPaths.dir), servedKey].sort(),
		);
	});

	it("reads an unstamped orphan's age from its newest indexing", () => {
		const root = path.join(workDir, "old");
		mkdirSync(root);
		const key = seedStore(root, fakeClock(NOW - PRUNE_AFTER_MS - DAY));
		indexFileAt(root, fakeClock(NOW - PRUNE_AFTER_MS - DAY));
		unstamp(root);
		rmSync(root, { recursive: true });

		expect(pruneProjectStores(NOBODY_ALIVE, NOW, host)).toMatchObject([
			{ store: { key }, outcome: { deleted: true } },
		]);
		expect(listProjectStores(NOBODY_ALIVE, host)).toEqual([]);
	});

	// The delete road, so a custom directory keeps the owner's files as a delete would.
	it("takes the delete road, leaving what a delete leaves", () => {
		const root = path.join(workDir, "custom");
		const custom = path.join(workDir, "refs-store");
		mkdirSync(root);
		seedCustom(root, custom);
		const db = new DatabaseSync(storePaths(custom).index);
		db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastSeenAt', '${NOW - PRUNE_AFTER_MS - DAY}')`);
		db.close();
		writeFileSync(path.join(custom, "notes.txt"), "mine");
		rmSync(root, { recursive: true });

		const pruned = pruneProjectStores(NOBODY_ALIVE, NOW, host);

		expect(pruned).toMatchObject([{ store: { directory: custom, custom: true }, outcome: { deleted: true } }]);
		expect(readdirSync(custom)).toEqual(["notes.txt"]);
	});

	// Nothing else ever revisits a `.removing` name, so the prune road is the one place that must.
	describe("sweeping abandoned graves", () => {
		function grave(): string {
			const path_ = `${workspacePaths(host, workDir).dir}.9999999.removing`;
			mkdirSync(path_, { recursive: true });
			return path_;
		}

		it("removes a grave whose delete died, and answers it in the outcomes", () => {
			const dir = grave();
			writeFileSync(storePaths(dir).lockFile, JSON.stringify({ ...lockFor(workDir, 2 ** 30), role: "delete" }));
			writeFileSync(storePaths(dir).index, "leftover");

			const pruned = pruneProjectStores(NOBODY_ALIVE, NOW, host);

			expect(pruned).toHaveLength(1);
			expect(pruned[0]).toMatchObject({ outcome: { deleted: true } });
			expect(existsSync(dir)).toBe(false);
		});

		it("leaves a grave alone while its delete is still alive", () => {
			const dir = grave();
			writeFileSync(storePaths(dir).lockFile, JSON.stringify({ ...lockFor(workDir, 4242), role: "delete" }));

			const pruned = pruneProjectStores(EVERYBODY_ALIVE, NOW, host);

			expect(pruned).toEqual([]);
			expect(existsSync(dir)).toBe(true);
		});
	});
});

describe("deleting a project's index", () => {
	it("removes the whole state directory and reports what it freed", () => {
		const key = seedStore(workDir);
		const directory = path.join(stateRoot(host), key);
		writeFileSync(`${storePaths(directory).logFile}.old`, "rotated");

		const outcome = deleteProjectStore(resolve(key), NOBODY_ALIVE, NOW, host);

		expect(outcome).toMatchObject({ deleted: true, key, directory });
		expect(existsSync(directory)).toBe(false);
		expect(listProjectStores(NOBODY_ALIVE, host)).toEqual([]);
	});

	// Deleting a file under its own live writer corrupts what it is mid-write, so the refusal
	// names the way out rather than just saying no.
	it("refuses while a daemon is serving it, and says how to proceed", () => {
		const key = seedStore(workDir);
		seedLock(workDir, 4242);

		const outcome = deleteProjectStore(resolve(key, EVERYBODY_ALIVE), EVERYBODY_ALIVE, NOW, host);

		expect(outcome).toMatchObject({ deleted: false });
		expect((outcome as { reason: string }).reason).toContain("4242");
		expect((outcome as { reason: string }).reason).toContain("shut it down first");
		expect(existsSync(path.join(stateRoot(host), key))).toBe(true);
	});

	// The holder is another delete, not a daemon: there is nothing to shut down, only a race to lose.
	it("refuses while another delete already claims it, without telling the caller to shut anything down", () => {
		const key = seedStore(workDir);
		const directory = workspacePaths(host, workDir).dir;
		writeFileSync(storePaths(directory).lockFile, JSON.stringify({ ...lockFor(workDir, 4242), role: "delete" }));

		const outcome = deleteProjectStore(resolve(key, EVERYBODY_ALIVE), EVERYBODY_ALIVE, NOW, host);

		expect(outcome).toMatchObject({ deleted: false });
		expect((outcome as { reason: string }).reason).toContain("4242");
		expect((outcome as { reason: string }).reason).toContain("already deleting");
		expect((outcome as { reason: string }).reason).not.toContain("shut it down");
	});

	// A lock claimed after the check still refuses the delete.
	it("refuses a daemon that claims the lock after the check and before the removal", () => {
		const key = seedStore(workDir);
		const directory = path.join(stateRoot(host), key);
		const lockFile = storePaths(directory).lockFile;
		seedLock(workDir, 1111);
		let raced = false;
		const racing: HolderAlive = (holder) => {
			if (holder.pid === 2222) return true;
			if (!raced) {
				raced = true;
				expect(claimLock(lockFile, lockFor(workDir, 2222), NOBODY_ALIVE)).toEqual({
					claimed: true,
					stolenRole: "daemon",
				});
			}
			return false;
		};

		const outcome = deleteProjectStore(resolve(key), racing, NOW, host);

		expect(outcome).toMatchObject({ deleted: false, reason: expect.stringContaining("2222") });
		expect(existsSync(storePaths(directory).index)).toBe(true);
		expect(readLock(lockFile)?.pid).toBe(2222);
		expect(readdirSync(directory).filter((entry) => /\.(claim|stale)$/.test(entry))).toEqual([]);
	});

	// Nothing named may remain behind a deleted answer.
	it("answers not deleted, with nothing removed and the lock released, when the directory cannot be moved aside", () => {
		const key = seedStore(workDir);
		const directory = path.join(stateRoot(host), key);
		chmodSync(stateRoot(host), 0o555);

		try {
			const outcome = deleteProjectStore(resolve(key), NOBODY_ALIVE, NOW, host);

			expect(outcome).toMatchObject({ deleted: false, reason: expect.stringContaining(key) });
			expect(existsSync(storePaths(directory).index)).toBe(true);
			expect(existsSync(storePaths(directory).lockFile)).toBe(false);
			expect(listProjectStores(NOBODY_ALIVE, host)).toMatchObject([{ key, livePid: null }]);
		} finally {
			chmodSync(stateRoot(host), 0o755);
		}
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
		expect(deleteProjectStore({ directory: stateRoot(host) }, NOBODY_ALIVE, NOW, host)).toMatchObject({
			deleted: false,
		});
		expect(deleteProjectStore({ directory: stateDir }, NOBODY_ALIVE, NOW, host)).toMatchObject({ deleted: false });
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

		const outcome = deleteProjectStore(resolve(custom), NOBODY_ALIVE, NOW, host);

		expect(outcome).toMatchObject({ deleted: true, directory: custom, key: storeKeyFor(workDir) });
		expect(readdirSync(custom)).toEqual(["notes.txt"]);
	});

	it("takes an emptied directory with it, and refuses one a daemon is serving", () => {
		const custom = path.join(workDir, "refs-store");
		seedCustom(workDir, custom);
		seedLock(workDir, 4242, custom);

		const refused = deleteProjectStore(resolve(custom, EVERYBODY_ALIVE), EVERYBODY_ALIVE, NOW, host);
		expect(refused).toMatchObject({ deleted: false, reason: expect.stringContaining("4242") });
		expect(existsSync(storePaths(custom).index)).toBe(true);

		expect(deleteProjectStore(resolve(custom), NOBODY_ALIVE, NOW, host)).toMatchObject({ deleted: true });
		expect(existsSync(custom)).toBe(false);
	});
});

// Shares its removal with the delete road: one definition of what goes.
describe("finishing a delete a dead process left unfinished", () => {
	it("removes what a delete would, keeps the owner's other files, and keeps the directory itself", () => {
		const directory = path.join(workDir, "abandoned");
		mkdirSync(directory, { recursive: true });
		const paths = storePaths(directory);
		writeFileSync(paths.index, "stale index");
		writeFileSync(paths.logFile, "stale log");
		writeFileSync(paths.diagnosticsFile, "{}");
		writeFileSync(path.join(directory, "notes.txt"), "mine");

		finishAbandonedDelete(directory, false);

		expect(existsSync(paths.index)).toBe(false);
		expect(existsSync(paths.logFile)).toBe(false);
		expect(existsSync(paths.diagnosticsFile)).toBe(false);
		expect(existsSync(directory)).toBe(true);
		expect(readdirSync(directory)).toEqual(["notes.txt"]);
	});

	it("does nothing to a custom directory that never held a lexicon file", () => {
		const directory = path.join(workDir, "empty");
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, "notes.txt"), "mine");

		finishAbandonedDelete(directory, false);

		expect(readdirSync(directory)).toEqual(["notes.txt"]);
	});

	// A default directory is lexicon's alone: everything but its own lock goes.
	it("clears a default directory whole but for its lock, list or no list", () => {
		const directory = path.join(workDir, "abandoned-default");
		mkdirSync(directory, { recursive: true });
		const paths = storePaths(directory);
		writeFileSync(paths.index, "stale index");
		writeFileSync(paths.lockFile, JSON.stringify(lockFor(directory, process.pid)));
		writeFileSync(path.join(directory, "stray.txt"), "not in the list");

		finishAbandonedDelete(directory, true);

		expect(existsSync(paths.index)).toBe(false);
		expect(existsSync(path.join(directory, "stray.txt"))).toBe(false);
		expect(existsSync(paths.lockFile)).toBe(true);
	});
});
