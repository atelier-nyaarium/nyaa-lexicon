import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SOURCES = path.join(import.meta.dir, "..");

/** Any insert into the notes table, however its conflict clause is written. */
const NOTE_INSERT = /INSERT[^;]*?INTO\s+symbol_notes\b/i;

describe("the notes table's insert", () => {
	it("is written in noteRows.ts alone, so its column list has one owner", () => {
		const writers = readdirSync(SOURCES)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => NOTE_INSERT.test(readFileSync(path.join(SOURCES, name), "utf8")));
		expect(writers).toEqual(["noteRows.ts"]);
	});
});
