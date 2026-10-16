import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stagingOf } from "../storePurge";

/** Checks whether a file holds value. */
function holds(target: string, value: string): boolean {
	return existsSync(target) && readFileSync(target).includes(value);
}

/** Locations still holding the value. */
export function where(target: string, value: string): "db" | "wal" | "db+wal" | "gone" {
	const db = holds(target, value);
	const wal = holds(`${target}-wal`, value);
	if (db && wal) return "db+wal";
	return db ? "db" : wal ? "wal" : "gone";
}

/** Searches store files for value residue. */
export function everywhere(target: string, value: string): string[] {
	const staged = stagingOf(target);
	return [target, `${target}-wal`, staged, `${staged}-wal`, `${staged}-journal`].filter((each) => holds(each, value));
}

/** Checkpoints the WAL and clears it. */
export function fold(target: string): void {
	const admin = new DatabaseSync(target);
	try {
		admin.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
	} finally {
		admin.close();
	}
}

/** Creates WAL frames without an owner. */
export function foreignLog(directory: string): Buffer {
	const other = path.join(mkdtempSync(path.join(directory, "foreign-")), "foreign.sqlite");
	const db = new DatabaseSync(other);
	try {
		db.exec(
			"PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE foreign_marker (v TEXT); INSERT INTO foreign_marker VALUES ('x')",
		);
		return readFileSync(`${other}-wal`);
	} finally {
		db.close();
	}
}

/** Reads schema version and tables. */
export function shownBy(target: string): { version: number; tables: string[] } {
	const db = new DatabaseSync(target);
	try {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
			name: string;
		}>;
		return {
			version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
			tables: tables.map((row) => row.name),
		};
	} finally {
		db.close();
	}
}
