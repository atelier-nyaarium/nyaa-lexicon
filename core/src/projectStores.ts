// What indexes exist on this machine, and removing the ones nobody wants.
//
// Every other module here answers about ONE workspace; this one is about the state root itself,
// which is the only view from which "delete this project" is answerable.
//
// Reads never open a store, because opening one REBUILDS an index whose schema has moved on, so
// inspecting would rewrite the thing being inspected.
//
// The listing is a lock-free reader, so only the stamp's own open, re-checked immediately before
// it, carries a residual race.

import { existsSync, lstatSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	canonicalRoot,
	currentHost,
	type PlatformEnv,
	stateRoot,
	storePaths,
	workspaceKey,
} from "@nyaa-lexicon/client";
import { type DaemonLock, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { claimLock, type HolderAlive, holderIdentity, mintToken, readLock, releaseLock } from "./daemonLock.js";
import { lastSeenOf, newestIndexedAt, readSeenStamp, stampSeen } from "./lastSeen.js";
import { forgetProject, readRegistry } from "./projectRegistry.js";

////////////////////////////////
//  Interfaces & Types

/** Three values, because an index predating the recorded path has nothing to check, and calling
 * that `missing` tells a user their live project is gone. */
export type WorkspaceState = "present" | "missing" | "unknown";

export interface ProjectStore {
	/** The directory name under the state root, or the registry key a custom store was registered under. */
	key: string;
	/** Absolute. The store's identity, and what a delete takes. */
	directory: string;
	/** A directory the project chose, as opposed to the default under the state root. */
	custom: boolean;
	/** The workspace this index was built from, or null when no daemon has recorded one. */
	workspaceRoot: string | null;
	/** Whether that path is still on disk, or that the index never said where it came from. */
	workspace: WorkspaceState;
	/** Bytes of index, excluding WAL companions, or 0 when there is no index file. */
	bytes: number;
	/** Last write to the index, epoch millis, or null when there is no index file. */
	modifiedAt: number | null;
	/** Newest per-file indexing time, epoch millis, or null when no file has been indexed. */
	lastIndexedAt: number | null;
	/** When the workspace was last confirmed on disk, epoch millis; the later of the daemon's stamp
	 * and `lastIndexedAt`, or null when neither exists. */
	lastSeenAt: number | null;
	/** The pid serving it right now, or null. A live daemon blocks deletion. */
	livePid: number | null;
	/** Whether a live delete claims this store's lock right now. True skips reading and stamping
	 * the index entirely, since a delete is free to remove it out from under either. */
	deleting: boolean;
}

export type DeleteOutcome =
	| { deleted: true; key: string; directory: string; bytes: number }
	| { deleted: false; reason: string };

/** A store the prune took to the delete road, and what the road answered. */
export interface PrunedStore {
	store: ProjectStore;
	outcome: DeleteOutcome;
}

////////////////////////////////
//  Constants

/** An orphan unseen this long is deleted unasked. */
export const PRUNE_AFTER_MS = 30 * 86_400_000;

/** A delete listens on nothing; the lock schema still wants a port. */
const NO_PORT = 1;

/** A default directory moved aside for removal; the listing never shows one. */
const REMOVING_SUFFIX = ".removing";

////////////////////////////////
//  Functions & Helpers

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The pid of the daemon holding this lock, or null when it is absent, junk, dead, or a delete's
 * own claim: nothing is serving the store while one is removing it. */
function pidOf(lock: DaemonLock | null, isAlive: HolderAlive): number | null {
	return lock !== null && lock.role !== "delete" && isAlive(lock) ? lock.pid : null;
}

interface IndexMetadata {
	workspaceRoot: string | null;
	lastIndexedAt: number | null;
	lastSeenAt: number | null;
}

const NO_METADATA: IndexMetadata = { workspaceRoot: null, lastIndexedAt: null, lastSeenAt: null };

/** The workspace an index was built from. Null when it is too old to carry the key, never a guess. */
function indexMetadata(indexFile: string): IndexMetadata {
	if (!existsSync(indexFile)) return NO_METADATA;
	let db: DatabaseSync | null = null;
	try {
		db = new DatabaseSync(indexFile, { readOnly: true });
		let workspaceRoot: string | null = null;
		try {
			const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("workspaceRoot") as
				| { value: string }
				| undefined;
			workspaceRoot = row?.value ?? null;
		} catch {
			// Older stores may not have a meta table yet.
		}
		const lastIndexedAt = newestIndexedAt(db);
		return { workspaceRoot, lastIndexedAt, lastSeenAt: lastSeenOf(readSeenStamp(db), lastIndexedAt) };
	} catch {
		return NO_METADATA;
	} finally {
		db?.close();
	}
}

/** What the store holds afterwards, or null when a live delete claims it, its index is not there,
 * or it is too old to carry the key. Re-reads the lock and the file fresh before opening either. */
export function stampIndex(directory: string, isAlive: HolderAlive, now: number): number | null {
	const lock = readLock(storePaths(directory).lockFile);
	if (lock !== null && lock.role === "delete" && isAlive(lock)) return null;
	const indexFile = storePaths(directory).index;
	if (!existsSync(indexFile)) return null;
	let db: DatabaseSync | null = null;
	try {
		db = new DatabaseSync(indexFile);
		return stampSeen(db, now);
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function sizeOf(indexFile: string): { bytes: number; modifiedAt: number | null } {
	try {
		const stats = statSync(indexFile);
		return { bytes: stats.size, modifiedAt: stats.mtimeMs };
	} catch {
		return { bytes: 0, modifiedAt: null };
	}
}

function describeStore(key: string, directory: string, custom: boolean, isAlive: HolderAlive): ProjectStore {
	// The lock's role decides everything below: a live delete may remove the index at any moment,
	// so nothing here opens it, reads it or writes a stamp into it while one claims it.
	const lock = readLock(storePaths(directory).lockFile);
	const deleting = lock !== null && lock.role === "delete" && isAlive(lock);
	const indexFile = storePaths(directory).index;
	const { workspaceRoot, lastIndexedAt, lastSeenAt } = deleting ? NO_METADATA : indexMetadata(indexFile);
	const { bytes, modifiedAt } = sizeOf(indexFile);
	return {
		key,
		directory,
		custom,
		workspaceRoot,
		workspace: workspaceRoot === null ? "unknown" : existsSync(workspaceRoot) ? "present" : "missing",
		bytes,
		modifiedAt,
		lastIndexedAt,
		lastSeenAt,
		livePid: pidOf(lock, isAlive),
		deleting,
	};
}

function isDirectory(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Every workspace index on this machine, newest first: the state root's children, then every
 * directory the registry names that is not already one of them. */
export function listProjectStores(isAlive: HolderAlive, host: PlatformEnv = currentHost()): ProjectStore[] {
	const root = stateRoot(host);
	let entries: string[] = [];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.endsWith(REMOVING_SUFFIX))
			.map((entry) => entry.name);
	} catch {
		// No state root yet; the registry may still name directories elsewhere.
	}

	const stores: ProjectStore[] = [];
	// Deduplicated on the real path, since the state root may be reached through a link.
	const seen = new Set<string>();
	for (const key of entries) {
		const directory = path.join(root, key);
		seen.add(canonicalRoot(directory));
		stores.push(describeStore(key, directory, false, isAlive));
	}
	for (const project of readRegistry(host)) {
		if (project.stateDir === undefined || !isDirectory(project.stateDir)) continue;
		const real = canonicalRoot(project.stateDir);
		if (seen.has(real)) continue;
		seen.add(real);
		stores.push(describeStore(project.key, project.stateDir, true, isAlive));
	}

	return stores.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
}

/** The listing, with every store whose recorded workspace is on disk stamped as seen `now`. A
 * stamp never moves backwards, so a clock behind what is held changes nothing. */
export function stampProjectStores(
	isAlive: HolderAlive,
	now: number,
	host: PlatformEnv = currentHost(),
): ProjectStore[] {
	return listProjectStores(isAlive, host).map((store) => {
		if (store.deleting || store.workspace !== "present") return store;
		const lastSeenAt = stampIndex(store.directory, isAlive, now);
		return lastSeenAt === null ? store : { ...store, lastSeenAt };
	});
}

/** Whether a store may go unasked: its recorded workspace is missing, nothing serves it, and it
 * was last seen past the horizon. One that never recorded a root, or that nothing dates, stays. */
function prunable(store: ProjectStore, now: number): boolean {
	return (
		!store.deleting &&
		store.workspace === "missing" &&
		store.livePid === null &&
		store.lastSeenAt !== null &&
		now - store.lastSeenAt > PRUNE_AFTER_MS
	);
}

/** Every grave under the state root: a default store's directory moved aside by a delete, still
 * there because nothing has removed it yet. */
function graveDirectories(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.endsWith(REMOVING_SUFFIX))
			.map((entry) => path.join(root, entry.name));
	} catch {
		return [];
	}
}

/** Every grave whose delete died before finishing it, removed whole through the one removal rule;
 * a grave whose holder still lives is left for it to finish. */
function sweepGraves(isAlive: HolderAlive, host: PlatformEnv): PrunedStore[] {
	const results: PrunedStore[] = [];
	for (const grave of graveDirectories(stateRoot(host))) {
		const lock = readLock(storePaths(grave).lockFile);
		if (lock !== null && isAlive(lock)) continue;
		const store = describeStore(path.basename(grave), grave, false, isAlive);
		try {
			removeDefaultDirectory(grave);
			results.push({ store, outcome: { deleted: true, key: store.key, directory: grave, bytes: store.bytes } });
		} catch (error) {
			results.push({ store, outcome: { deleted: false, reason: reasonOf(error) } });
		}
	}
	return results;
}

/** Every grave a dead delete abandoned, plus every prunable store taken down the delete road, with
 * what it answered for each. */
export function pruneProjectStores(
	isAlive: HolderAlive,
	now: number,
	host: PlatformEnv = currentHost(),
): PrunedStore[] {
	const graves = sweepGraves(isAlive, host);
	const pruned: PrunedStore[] = listProjectStores(isAlive, host)
		.filter((store) => prunable(store, now))
		.map((store) => {
			try {
				return { store, outcome: deleteProjectStore(store, isAlive, now, host) };
			} catch (error) {
				return { store, outcome: { deleted: false, reason: reasonOf(error) } };
			}
		});
	return [...graves, ...pruned];
}

/** The store a reference names: a default store by its key, any store by its directory, both as
 * the listing spelled them. Never a path built from the reference. */
export function findProjectStore(reference: string, stores: ProjectStore[]): ProjectStore | null {
	return (
		stores.find((store) => !store.custom && store.key === reference) ??
		stores.find((store) => store.directory === reference) ??
		null
	);
}

/** What the daemon writes into a custom store directory beside its lock, and nothing else: a
 * custom directory may hold the owner's own files beside these. */
function storeFiles(directory: string): string[] {
	const paths = storePaths(directory);
	return [
		paths.index,
		`${paths.index}-wal`,
		`${paths.index}-shm`,
		`${paths.index}-journal`,
		paths.logFile,
		`${paths.logFile}.old`,
		paths.diagnosticsFile,
		`${paths.diagnosticsFile}.tmp`,
		paths.reportsDir,
	];
}

/**
 * What a delete removes from a store directory: everything, for a default one; the enumerated
 * list, for a custom one. `keepLockFile`, when given, is spared from a default removal.
 */
function removeStoreContents(directory: string, defaultStore: boolean, keepLockFile?: string): void {
	if (!defaultStore) {
		for (const file of storeFiles(directory)) rmSync(file, { recursive: true, force: true });
		return;
	}
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const full = path.join(directory, entry);
		if (full !== keepLockFile) rmSync(full, { recursive: true, force: true });
	}
}

/** Empties then removes a default directory or its grave, lock included, tolerant of another
 * sweep having already finished the same job first. */
function removeDefaultDirectory(directory: string): void {
	removeStoreContents(directory, true);
	try {
		rmdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** A default directory is lexicon's alone, so it goes whole: moved aside under the lock, which
 * frees its name for a fresh store before a byte is removed, then removed where nothing lists it.
 * The reason it stays, or null. */
function removeDefault(directory: string, token: string): string | null {
	const grave = `${directory}.${process.pid}${REMOVING_SUFFIX}`;
	try {
		renameSync(directory, grave);
	} catch (error) {
		releaseLock(storePaths(directory).lockFile, token);
		return `${directory} could not be moved aside: ${reasonOf(error)}`;
	}
	releaseLock(storePaths(grave).lockFile, token);
	try {
		removeDefaultDirectory(grave);
	} catch (error) {
		return `${directory} was moved to ${grave} but not removed: ${reasonOf(error)}`;
	}
	return null;
}

/** A custom directory keeps the owner's files, so lexicon's go one by one under the lock, and the
 * directory only once that emptied it. The reason the index stays, or null. */
function removeCustom(directory: string, token: string): string | null {
	const lockFile = storePaths(directory).lockFile;
	try {
		removeStoreContents(directory, false);
	} catch (error) {
		releaseLock(lockFile, token);
		return `${directory} could not be emptied: ${reasonOf(error)}`;
	}
	releaseLock(lockFile, token);
	try {
		rmdirSync(directory);
	} catch {
		// The owner's files, or a daemon that claimed the freed name.
	}
	return null;
}

/** Finishes a delete the claim inherited, so the daemon that stole its lock opens an empty store. */
export function finishAbandonedDelete(directory: string, defaultStore: boolean): void {
	removeStoreContents(directory, defaultStore, defaultStore ? storePaths(directory).lockFile : undefined);
}

/**
 * Claimed as a daemon claims, and removed only while held: a daemon starting meanwhile loses the
 * claim or refuses this delete, never opens a store being removed. Takes a store as the listing
 * showed it, so the directory removed is one the listing named, never one built from input.
 */
export function deleteProjectStore(
	store: Pick<ProjectStore, "directory">,
	isAlive: HolderAlive,
	now: number,
	host: PlatformEnv = currentHost(),
): DeleteOutcome {
	const current = listProjectStores(isAlive, host).find((candidate) => candidate.directory === store.directory);
	if (current === undefined) return { deleted: false, reason: `no store at ${store.directory}` };
	const label = current.custom ? current.directory : current.key;

	// A directory swapped for a link since it was admitted would have every removal land where the
	// link points; the listing followed it to read, deletion does not.
	try {
		if (lstatSync(current.directory).isSymbolicLink()) {
			return { deleted: false, reason: `${current.directory} is a symbolic link now; nothing removed` };
		}
	} catch {
		return { deleted: false, reason: `${current.directory} vanished before it could be removed` };
	}

	const lockFile = storePaths(current.directory).lockFile;
	const lock: DaemonLock = {
		port: NO_PORT,
		token: mintToken(),
		...holderIdentity(),
		protocolVersion: PROTOCOL_VERSION,
		// The directory, not the workspace: a client backs off rather than retiring the holder.
		workspaceRoot: current.directory,
		startedAt: now,
		role: "delete",
	};
	const claim = claimLock(lockFile, lock, isAlive);
	if (!claim.claimed) {
		return {
			deleted: false,
			reason:
				claim.holder.role === "delete"
					? `pid ${claim.holder.pid} is already deleting ${label}`
					: `pid ${claim.holder.pid} is serving ${label} right now; shut it down first, then delete`,
		};
	}

	const remains = current.custom
		? removeCustom(current.directory, lock.token)
		: removeDefault(current.directory, lock.token);
	if (remains !== null) return { deleted: false, reason: remains };
	// A key names the default store's registration, a directory a custom one's.
	forgetProject(label, host);
	return { deleted: true, key: current.key, directory: current.directory, bytes: current.bytes };
}

/** The key a workspace path maps to, so a caller can name a store from a path. */
export function storeKeyFor(workspaceRoot: string): string {
	return workspaceKey(workspaceRoot);
}
