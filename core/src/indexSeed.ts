// A store's first open under a new schema copies the newest older index forward, so knowledge
// carries over while the older file stays as the install that wrote it left it.

import { existsSync, renameSync, rmSync } from "node:fs";
import { indexFiles, storePaths } from "@nyaa-lexicon/client";
import { SCHEMA_VERSION } from "@nyaa-lexicon/protocol";
import { Database } from "./database.js";

////////////////////////////////
//  Constants

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

////////////////////////////////
//  Functions & Helpers

/** SQLite's answer for a file that is not, or is no longer, a database. */
function unreadable(error: unknown): boolean {
	const code = (error as { errcode?: unknown } | null)?.errcode;
	return typeof code === "number" && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code & 0xff);
}

function copyInto(source: string, staging: string): void {
	const db = Database.open(source, { readOnly: true });
	try {
		db.exec(`VACUUM INTO '${staging.replaceAll("'", "''")}'`);
	} finally {
		db.close();
	}
}

/**
 * Copies the newest readable older-schema index into this schema's file, once; the open that
 * follows migrates the copy. Answers the file copied, or null when there was nothing to copy.
 * Throws on any other failure, leaving no target, so the next start retries. Runs under the
 * daemon's lock, so no other daemon writes either file meanwhile.
 */
export function seedIndex(directory: string): string | null {
	const target = storePaths(directory).index;
	if (existsSync(target)) return null;
	// Staged, so a crash mid-copy never leaves a partial file under the real name.
	const staging = `${target}.seeding`;
	try {
		for (const source of indexFiles(directory).filter((each) => each.schema < SCHEMA_VERSION)) {
			rmSync(staging, { force: true });
			try {
				copyInto(source.file, staging);
			} catch (error) {
				if (unreadable(error)) continue;
				throw error;
			}
			renameSync(staging, target);
			return source.file;
		}
		return null;
	} finally {
		rmSync(staging, { force: true });
	}
}
