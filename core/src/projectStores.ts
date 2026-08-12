// What indexes exist on this machine, and removing the ones nobody wants.
//
// Every other module here answers about ONE workspace; this one is about the state root itself,
// which is the only view from which "delete this project" is answerable.
//
// Reads never open a store, because opening one REBUILDS an index whose schema has moved on, so
// inspecting would rewrite the thing being inspected.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DaemonLockSchema } from "./lockFile.js";
import { currentHost, type PlatformEnv, stateRoot, workspaceKey } from "./paths.js";

////////////////////////////////
//  Interfaces & Types

/** Three values, because an index predating the recorded path has nothing to check, and calling
 * that `missing` tells a user their live project is gone. */
export type WorkspaceState = "present" | "missing" | "unknown";

export interface ProjectStore {
	/** Directory name under the state root, and the confirmation token a delete requires. */
	key: string;
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

export type DeleteOutcome = { deleted: true; key: string; bytes: number } | { deleted: false; reason: string };

////////////////////////////////
//  Functions & Helpers

/** The pid of the daemon serving this directory, or null when the lock is absent, junk, or dead. */
function pidOf(dir: string, isAlive: (pid: number) => boolean): number | null {
	let raw: string;
	try {
		raw = readFileSync(path.join(dir, "daemon.json"), "utf8");
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
	return isAlive(lock.data.pid) ? lock.data.pid : null;
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

/** Every workspace index on this machine, newest first. */
export function listProjectStores(
	isAlive: (pid: number) => boolean,
	host: PlatformEnv = currentHost(),
): ProjectStore[] {
	const root = stateRoot(host);
	let entries: string[];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}

	const stores = entries.map((key): ProjectStore => {
		const dir = path.join(root, key);
		const indexFile = path.join(dir, "index.sqlite");
		const { workspaceRoot, lastIndexedAt } = indexMetadata(indexFile);
		const { bytes, modifiedAt } = sizeOf(indexFile);
		return {
			key,
			workspaceRoot,
			workspace: workspaceRoot === null ? "unknown" : existsSync(workspaceRoot) ? "present" : "missing",
			bytes,
			modifiedAt,
			lastIndexedAt,
			livePid: pidOf(dir, isAlive),
		};
	});

	return stores.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
}

/** Irreversible, so a live daemon is refused (deleting under its own writer corrupts it mid-write)
 * and the key must match exactly. */
export function deleteProjectStore(
	key: string,
	isAlive: (pid: number) => boolean,
	host: PlatformEnv = currentHost(),
): DeleteOutcome {
	// The key names a directory, so a separator or a traversal segment in it would leave the state
	// root entirely. Refused rather than sanitized: a caller passing one is confused about what a
	// key is, and quietly deleting some repaired path is worse than saying no.
	if (key.length === 0 || key.includes("/") || key.includes("\\") || key.includes("..")) {
		return { deleted: false, reason: `${JSON.stringify(key)} is not a store key` };
	}

	const store = listProjectStores(isAlive, host).find((candidate) => candidate.key === key);
	if (store === undefined) return { deleted: false, reason: `no store named ${key}` };
	if (store.livePid !== null) {
		return {
			deleted: false,
			reason: `pid ${store.livePid} is serving ${key} right now; shut it down first, then delete`,
		};
	}

	rmSync(path.join(stateRoot(host), key), { recursive: true, force: true });
	return { deleted: true, key, bytes: store.bytes };
}

/** The key a workspace path maps to, so a caller can name a store from a path. */
export function storeKeyFor(workspaceRoot: string): string {
	return workspaceKey(workspaceRoot);
}
