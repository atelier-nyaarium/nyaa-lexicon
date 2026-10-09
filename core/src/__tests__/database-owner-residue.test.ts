import { describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { importSpecifiers, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";

/**
 * Holds database.ts as core's one opener of a SQLite file, so every statement goes through its
 * cache of prepared statements.
 *
 * Bug class killed: a hot write compiling its SQL on every call. With a raw handle out of reach,
 * a new call site prepares through the cache because there is nothing else to prepare with.
 */
const CORE = new URL("..", import.meta.url).pathname;

const OWNER = "database.ts";

const DRIVER = "node:sqlite";

const reachesDriver = (source: Parameters<typeof importSpecifiers>[0]) => importSpecifiers(source).includes(DRIVER);

describe("one opener of SQLite in core", () => {
	const swept = parsedFiles(CORE, ["__tests__"]);

	it("sweeps core and finds the owner reaching the driver, so a passing run is never vacuous", () => {
		expect(swept.length).toBeGreaterThan(50);
		expect(swept.filter(({ file, source }) => basename(file) === OWNER && reachesDriver(source))).toHaveLength(1);
	});

	it("recognizes a planted reach, typed or not", () => {
		for (const text of [
			'import { DatabaseSync } from "node:sqlite";',
			'import type { StatementSync } from "node:sqlite";',
		])
			expect(reachesDriver(parseSource("planted.ts", text).source)).toBe(true);
	});

	it("reaches the driver nowhere else", () => {
		const offenders = swept
			.filter(({ file, source }) => basename(file) !== OWNER && reachesDriver(source))
			.map(({ file }) => basename(file));

		expect(offenders, "open and prepare through Database in core/src/database.ts").toEqual([]);
	});
});
