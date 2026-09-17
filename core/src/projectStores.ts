// What indexes exist on this machine, and removing the ones nobody wants.
//
// Every other module here answers about ONE workspace; this one is about the state root itself,
// which is the only view from which "delete this project" is answerable.
//
// Reads never open a store, because opening one REBUILDS an index whose schema has moved on, so
// inspecting would rewrite the thing being inspected.

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
import { readRegistry } from "./projectRegistry.js";

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

/** The pid of the daemon serving this directory, or null when the lock is absent, junk, or dead. */
function pidOf(dir: string, isAlive: HolderAlive): number | null {
	const lock = readLock(storePaths(dir).lockFile);
	return lock !== null && isAlive(lock) ? lock.pid : null;
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

/** What the store holds afterwards, or null when it could not be written: a daemon mid-write, or
 * a store too old to carry the key. The listing then shows what it read. */
function stampIndex(indexFile: string, now: number): number | null {
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
	const indexFile = storePaths(directory).index;
	const { workspaceRoot, lastIndexedAt, lastSeenAt } = indexMetadata(indexFile);
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
		livePid: pidOf(directory, isAlive),
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
		if (store.workspace !== "present") return store;
		const lastSeenAt = stampIndex(storePaths(store.directory).index, now);
		return lastSeenAt === null ? store : { ...store, lastSeenAt };
	});
}

/** Whether a store may go unasked: its recorded workspace is missing, nothing serves it, and it
 * was last seen past the horizon. One that never recorded a root, or that nothing dates, stays. */
function prunable(store: ProjectStore, now: number): boolean {
	return (
		store.workspace === "missing" &&
		store.livePid === null &&
		store.lastSeenAt !== null &&
		now - store.lastSeenAt > PRUNE_AFTER_MS
	);
}

/** Every prunable store taken down the delete road, with what it answered for each. */
export function pruneProjectStores(
	isAlive: HolderAlive,
	now: number,
	host: PlatformEnv = currentHost(),
): PrunedStore[] {
	return listProjectStores(isAlive, host)
		.filter((store) => prunable(store, now))
		.map((store) => {
			try {
				return { store, outcome: deleteProjectStore(store, isAlive, now, host) };
			} catch (error) {
				return { store, outcome: { deleted: false, reason: reasonOf(error) } };
			}
		});
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

/** What the daemon writes into a store directory beside its lock, and nothing else: a custom
 * directory may hold the owner's own files beside these. */
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
		rmSync(grave, { recursive: true, force: true });
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
		for (const file of storeFiles(directory)) rmSync(file, { recursive: true, force: true });
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
	};
	const claim = claimLock(lockFile, lock, isAlive);
	if (!claim.claimed) {
		return {
			deleted: false,
			reason: `pid ${claim.holder.pid} is serving ${label} right now; shut it down first, then delete`,
		};
	}

	const remains = current.custom
		? removeCustom(current.directory, lock.token)
		: removeDefault(current.directory, lock.token);
	if (remains !== null) return { deleted: false, reason: remains };
	return { deleted: true, key: current.key, directory: current.directory, bytes: current.bytes };
}

/** The key a workspace path maps to, so a caller can name a store from a path. */
export function storeKeyFor(workspaceRoot: string): string {
	return workspaceKey(workspaceRoot);
}
