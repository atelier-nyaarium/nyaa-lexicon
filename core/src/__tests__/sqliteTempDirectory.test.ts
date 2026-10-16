import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sqliteTempDirectory } from "../storePurge";

////////////////////////////////
//  Helpers

let root: string;
let preferred: string;
let fallback: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-sqlite-temp-"));
	preferred = path.join(root, "preferred");
	fallback = path.join(root, "fallback");
	mkdirSync(preferred);
	mkdirSync(fallback);
});

afterEach(() => {
	chmodSync(preferred, 0o755);
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the directory SQLite puts a rewrite's temporary file in", () => {
	it("is SQLITE_TMPDIR first, then TMPDIR", () => {
		expect({
			both: sqliteTempDirectory({ SQLITE_TMPDIR: preferred, TMPDIR: fallback }),
			second: sqliteTempDirectory({ TMPDIR: fallback }),
		}).toEqual({ both: preferred, second: fallback });
	});

	it("moves past a candidate that is missing, not a directory or not usable, as SQLite does", () => {
		const aFile = path.join(root, "file");
		writeFileSync(aFile, "");
		chmodSync(preferred, 0o000);
		const env = { TMPDIR: fallback };

		expect({
			missing: sqliteTempDirectory({ ...env, SQLITE_TMPDIR: path.join(root, "absent") }),
			file: sqliteTempDirectory({ ...env, SQLITE_TMPDIR: aFile }),
			unusable: sqliteTempDirectory({ ...env, SQLITE_TMPDIR: preferred }),
		}).toEqual({ missing: fallback, file: fallback, unusable: fallback });
	});

	it.skipIf(process.platform === "win32")("falls to the system's own directories with no variable set", () => {
		expect(["/var/tmp", "/usr/tmp", "/tmp"]).toContain(sqliteTempDirectory({}) ?? "");
	});

	it("is the temp directory on Windows, whatever the variables name", () => {
		expect(sqliteTempDirectory({ SQLITE_TMPDIR: preferred }, "win32")).toBe(tmpdir());
	});
});
