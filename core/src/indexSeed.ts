// Copies notes and journal rows from the newest older index.

import { existsSync } from "node:fs";
import { indexFiles, storePaths } from "@nyaa-lexicon/client";
import { SCHEMA_VERSION } from "@nyaa-lexicon/protocol";
import { type Clock, systemClock } from "./clock.js";
import { Database } from "./database.js";
import { type Carried, carriedFrom, createStoreFile } from "./store.js";
import type { ScrubOptions } from "./storePurge.js";

////////////////////////////////
//  Interfaces & Types

/** Seed inputs and operations. */
export interface SeedOptions {
	clock?: Clock;
	/** The major recorded in the index. */
	compatibility?: string | null;
	/** How the index file is installed. */
	scrub?: ScrubOptions;
}

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

/** Earlier index knowledge, or null when unreadable. */
function carriedOf(file: string): Carried | null {
	let db: Database | null = null;
	try {
		db = Database.open(file, { readOnly: true });
		return carriedFrom(db);
	} catch (error) {
		if (unreadable(error)) return null;
		throw new Error(
			`${file} could not be read forward: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	} finally {
		db?.close();
	}
}

/**
 * Seeds this schema from the newest readable older index. Returns its path or null; failures leave
 * no target. The daemon lock prevents concurrent writes.
 */
export function seedIndex(directory: string, options: SeedOptions = {}): string | null {
	const target = storePaths(directory).index;
	if (existsSync(target)) return null;
	for (const source of indexFiles(directory).filter((each) => each.schema < SCHEMA_VERSION)) {
		const carried = carriedOf(source.file);
		if (carried === null) continue;
		createStoreFile(target, carried, {
			clock: options.clock ?? systemClock,
			compatibility: options.compatibility,
			scrub: options.scrub,
		});
		return source.file;
	}
	return null;
}
