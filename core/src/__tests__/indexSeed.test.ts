import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storePaths } from "@nyaa-lexicon/client";
import { seedIndex } from "../indexSeed";

////////////////////////////////
//  Helpers

let dir: string;

/** An index file holding one row that says which file it is. */
function index(name: string, says: string): string {
	const file = path.join(dir, name);
	const db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
	db.prepare("INSERT INTO meta VALUES ('says', ?)").run(says);
	db.close();
	return file;
}

function says(file: string): string {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (db.prepare("SELECT value FROM meta WHERE key = 'says'").get() as { value: string }).value;
	} finally {
		db.close();
	}
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-seed-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("seeding this schema's index", () => {
	it("copies the newest older index forward once, never a newer one, and leaves the older file as it was", () => {
		const legacy = index("index.sqlite", "legacy");
		const older = index("index-25.sqlite", "older");
		index("index-99.sqlite", "newer");
		const olderBytes = readFileSync(older);

		const first = seedIndex(dir);
		const second = seedIndex(dir);

		expect({
			first,
			second,
			seeded: says(storePaths(dir).index),
			olderKept: readFileSync(older).equals(olderBytes),
			legacy: says(legacy),
		}).toEqual({ first: older, second: null, seeded: "older", olderKept: true, legacy: "legacy" });
	});

	it("skips an unreadable older index, and a failed copy leaves no target for the next start", () => {
		index("index-24.sqlite", "oldest");
		writeFileSync(path.join(dir, "index-25.sqlite"), "not a database".repeat(100));
		chmodSync(dir, 0o555);
		const failed = (() => {
			try {
				seedIndex(dir);
				return "returned";
			} catch {
				return "threw";
			} finally {
				chmodSync(dir, 0o755);
			}
		})();
		const kept = existsSync(storePaths(dir).index);
		const retried = seedIndex(dir);

		expect({ failed, kept, retried, seeded: says(storePaths(dir).index) }).toEqual({
			failed: "threw",
			kept: false,
			retried: path.join(dir, "index-24.sqlite"),
			seeded: "oldest",
		});
	});

	it("does nothing in a directory with no older index", () => {
		index("index-99.sqlite", "newer");

		expect(seedIndex(dir)).toBeNull();
	});
});
