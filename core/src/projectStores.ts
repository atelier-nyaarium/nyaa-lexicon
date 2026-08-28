// What indexes exist on this machine, and removing the ones nobody wants.
//
// Every other module here answers about ONE workspace; this one is about the state root itself,
// which is the only view from which "delete this project" is answerable.
//
// Reads never open a store, because opening one REBUILDS an index whose schema has moved on, so
// inspecting would rewrite the thing being inspected.

import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
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
import { DaemonLockSchema } from "@nyaa-lexicon/protocol";
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
	/** The pid serving it right now, or null. A live daemon blocks deletion. */
	livePid: number | null;
}

export type DeleteOutcome =
	| { deleted: true; key: string; directory: string; bytes: number }
	| { deleted: false; reason: string };

////////////////////////////////
//  Functions & Helpers

/** Who may hold a store's lock: pid plus the identity that tells reuse from residence. */
export type HolderAlive = (holder: { pid: number; pidStart?: string | undefined }) => boolean;

/** The pid of the daemon serving this directory, or null when the lock is absent, junk, or dead. */
function pidOf(dir: string, isAlive: HolderAlive): number | null {
	let raw: string;
	try {
		raw = readFileSync(storePaths(dir).lockFile, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const lock = DaemonLockSchema.safeParse(parsed);
	if (!lock.success) return null;
	return isAlive(lock.data) ? lock.data.pid : null;
}

/** The workspace an index was built from. Null when it is too old to carry the key, never a guess. */
function indexMetadata(indexFile: string): { workspaceRoot: string | null; lastIndexedAt: number | null } {
	if (!existsSync(indexFile)) return { workspaceRoot: null, lastIndexedAt: null };
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
		let lastIndexedAt: number | null = null;
		try {
			const row = db.prepare("SELECT indexedAt FROM files ORDER BY indexedAt DESC LIMIT 1").get() as
				| { indexedAt: number }
				| undefined;
			lastIndexedAt = row?.indexedAt ?? null;
		} catch {
			// Older stores may not have per-file timestamps yet.
		}
		return { workspaceRoot, lastIndexedAt };
	} catch {
		return { workspaceRoot: null, lastIndexedAt: null };
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
	const { workspaceRoot, lastIndexedAt } = indexMetadata(indexFile);
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
			.filter((entry) => entry.isDirectory())
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

/** The store a reference names: a default store by its key, any store by its directory, both as
 * the listing spelled them. Never a path built from the reference. */
export function findProjectStore(reference: string, stores: ProjectStore[]): ProjectStore | null {
	return (
		stores.find((store) => !store.custom && store.key === reference) ??
		stores.find((store) => store.directory === reference) ??
		null
	);
}

/** What the daemon writes into a store directory, and nothing else: a custom directory may hold
 * the owner's own files beside these. */
function storeFiles(directory: string): string[] {
	const paths = storePaths(directory);
	return [
		paths.lockFile,
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
 * Irreversible, so the store is re-read at the moment of deletion and a live daemon is refused
 * (deleting under its own writer corrupts it mid-write). Takes a store as the listing showed it,
 * so the directory removed is one the listing named, never one built from input.
 */
export function deleteProjectStore(
	store: Pick<ProjectStore, "directory">,
	isAlive: HolderAlive,
	host: PlatformEnv = currentHost(),
): DeleteOutcome {
	const current = listProjectStores(isAlive, host).find((candidate) => candidate.directory === store.directory);
	if (current === undefined) return { deleted: false, reason: `no store at ${store.directory}` };
	const label = current.custom ? current.directory : current.key;
	if (current.livePid !== null) {
		return {
			deleted: false,
			reason: `pid ${current.livePid} is serving ${label} right now; shut it down first, then delete`,
		};
	}

	// A directory swapped for a link since it was admitted would have every removal land where the
	// link points; the listing followed it to read, deletion does not.
	try {
		if (lstatSync(current.directory).isSymbolicLink()) {
			return { deleted: false, reason: `${current.directory} is a symbolic link now; nothing removed` };
		}
	} catch {
		return { deleted: false, reason: `${current.directory} vanished before it could be removed` };
	}

	for (const file of storeFiles(current.directory)) rmSync(file, { recursive: true, force: true });
	if (current.custom) {
		// The owner chose this directory; whatever else it holds stays, and so then does it.
		try {
			rmdirSync(current.directory);
		} catch {
			// Not empty.
		}
	} else {
		// A default directory is lexicon's alone, rotated logs and claim leftovers included.
		rmSync(current.directory, { recursive: true, force: true });
	}
	return { deleted: true, key: current.key, directory: current.directory, bytes: current.bytes };
}

/** The key a workspace path maps to, so a caller can name a store from a path. */
export function storeKeyFor(workspaceRoot: string): string {
	return workspaceKey(workspaceRoot);
}
