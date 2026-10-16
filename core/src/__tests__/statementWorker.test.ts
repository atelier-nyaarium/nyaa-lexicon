import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../database";
import { runInWorker } from "../statementWorker";

////////////////////////////////
//  Helpers

const SQLITE_BUSY = 5;
const SQLITE_NOTADB = 26;

let dir: string;
let file: string;

/** Reads rows on a separate connection. */
function rows(): number[] {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (db.prepare("SELECT n FROM t ORDER BY n").all() as Array<{ n: number }>).map((row) => row.n);
	} finally {
		db.close();
	}
}

const codeOf = (error: unknown) => ((error as { errcode?: number }).errcode ?? 0) & 0xff;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "lexicon-statement-worker-"));
	file = path.join(dir, "index.sqlite");
	const db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)");
	db.close();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a statement run in a worker", () => {
	it("runs on a connection of its own and settles once the work is done", async () => {
		const before = rows();
		await runInWorker({ file, sql: "INSERT INTO t VALUES (2)" });

		expect({ before, after: rows() }).toEqual({ before: [1], after: [1, 2] });
	});

	it("rejects with SQLite's own code, where a good file settles", async () => {
		const damaged = path.join(dir, "damaged.sqlite");
		writeFileSync(damaged, "not a database".repeat(100));
		const failed = await runInWorker({ file: damaged, sql: "VACUUM" }).catch((error: unknown) => error);

		expect({ failed: codeOf(failed), good: await runInWorker({ file, sql: "VACUUM" }) }).toEqual({
			failed: SQLITE_NOTADB,
			good: undefined,
		});
	});

	describe("while it waits on a lock another connection holds", () => {
		const insert = "INSERT INTO t VALUES (2)";

		it("leaves this thread running, and finishes once the lock is released", async () => {
			const holder = new DatabaseSync(file);
			holder.exec("BEGIN IMMEDIATE");
			let ticked = false;
			setTimeout(() => {
				ticked = true;
			}, 10);
			let settled = false;
			const running = runInWorker({ file, sql: insert }).then(() => {
				settled = true;
			});

			await sleep(100);
			const meanwhile = { ticked, settled };
			holder.exec("COMMIT");
			holder.close();
			await running;

			expect({ meanwhile, after: rows() }).toEqual({
				meanwhile: { ticked: true, settled: false },
				after: [1, 2],
			});
		});

		it("holds the thread when run inline, so the timer cannot fire (the control)", () => {
			const holder = new DatabaseSync(file);
			holder.exec("BEGIN IMMEDIATE");
			let ticked = false;
			setTimeout(() => {
				ticked = true;
			}, 10);
			const inline = Database.open(file, undefined, 150);
			let refused = 0;
			try {
				inline.exec(insert);
			} catch (error) {
				refused = codeOf(error);
			} finally {
				inline.close();
				holder.exec("ROLLBACK");
				holder.close();
			}

			expect({ ticked, refused }).toEqual({ ticked: false, refused: SQLITE_BUSY });
		});
	});
});
