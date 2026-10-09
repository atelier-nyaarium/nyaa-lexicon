import { describe, expect, it } from "bun:test";
import { Database } from "../database";

describe("a database's prepared statements", () => {
	it("compile once per SQL text and give way to newer ones past the cap", () => {
		const db = Database.open(":memory:");
		const first = db.prepare("SELECT 1 AS one");
		const again = db.prepare("SELECT 1 AS one");
		for (let at = 0; at < 1_000; at++) db.prepare(`SELECT ${at} AS other`);
		const recompiled = db.prepare("SELECT 1 AS one");

		expect({ cached: again === first, dropped: recompiled !== first, runs: recompiled.get() }).toEqual({
			cached: true,
			dropped: true,
			runs: { one: 1 },
		});
		db.close();
	});

	it("survive the same SQL run inside their own iteration, and are kept again once it ends", () => {
		const db = Database.open(":memory:");
		db.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2), (3)");
		const sql = "SELECT a FROM t ORDER BY a";
		const seen: number[] = [];
		for (const row of db.prepare(sql).iterate() as Iterable<{ a: number }>) {
			seen.push(row.a);
			db.prepare(sql).all();
		}
		const broken: number[] = [];
		for (const row of db.prepare(sql).iterate() as Iterable<{ a: number }>) {
			broken.push(row.a);
			break;
		}

		const kept = db.prepare(sql);

		expect({ seen, broken, kept: db.prepare(sql) === kept }).toEqual({
			seen: [1, 2, 3],
			broken: [1],
			kept: true,
		});
		db.close();
	});
});
