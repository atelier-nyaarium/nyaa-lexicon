// When a store's workspace was last confirmed on disk.
//
// One meta key beside the workspace root, read as the later of the stamp and the newest indexing,
// since indexing a file is seeing the workspace. A write only ever moves it forward.

import type { DatabaseSync } from "node:sqlite";

////////////////////////////////
//  Constants

const SEEN_KEY = "lastSeenAt";

////////////////////////////////
//  Functions & Helpers

/** Null when the table or the key is absent, or the value is not a time. */
export function readSeenStamp(db: DatabaseSync): number | null {
	try {
		const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SEEN_KEY) as { value: string } | undefined;
		if (row === undefined) return null;
		const at = Number(row.value);
		return Number.isFinite(at) ? at : null;
	} catch {
		return null;
	}
}

/** Null when no file has been indexed, or the store predates per-file times. */
export function newestIndexedAt(db: DatabaseSync): number | null {
	try {
		const row = db.prepare("SELECT indexedAt FROM files ORDER BY indexedAt DESC LIMIT 1").get() as
			| { indexedAt: number }
			| undefined;
		return row?.indexedAt ?? null;
	} catch {
		return null;
	}
}

/** The later of the two; null only when neither dates the workspace. */
export function lastSeenOf(stamp: number | null, lastIndexedAt: number | null): number | null {
	if (stamp === null) return lastIndexedAt;
	if (lastIndexedAt === null) return stamp;
	return Math.max(stamp, lastIndexedAt);
}

/**
 * The row becomes the later of `now` and what is held, and is written whenever it does not say
 * so already, so a value seeded from the newest indexing outlives those file rows. Read and write
 * share one immediate transaction, so a second writer cannot slip an earlier time in behind a
 * later one. Answers what is held afterwards.
 */
export function stampSeen(db: DatabaseSync, now: number): number {
	db.exec("BEGIN IMMEDIATE");
	try {
		const stamp = readSeenStamp(db);
		const held = lastSeenOf(stamp, newestIndexedAt(db));
		const value = held === null ? now : Math.max(now, held);
		if (stamp !== value) {
			db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(SEEN_KEY, String(value));
		}
		db.exec("COMMIT");
		return value;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
