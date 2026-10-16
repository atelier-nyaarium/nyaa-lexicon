import { describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { constructionsOf, importSpecifiers, parsedFiles, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";

/** database.ts owns SQLite opens, statement caching, and deletion zeroing. */
const CORE = new URL("..", import.meta.url).pathname;

const OWNER = "database.ts";

const DRIVER = "node:sqlite";

type Source = Parameters<typeof importSpecifiers>[0];

const reachesDriver = (source: Source) => importSpecifiers(source).includes(DRIVER);

const opensConnection = (source: Source) => constructionsOf(source, "DatabaseSync").length > 0;

const setsZeroing = (source: Source) => stringsIn(source).some(({ text }) => text.includes("secure_delete"));

describe("one opener of SQLite in core", () => {
	const swept = parsedFiles(CORE, ["__tests__"]);

	it("sweeps core and finds the owner doing all three, so a passing run is never vacuous", () => {
		expect(swept.length).toBeGreaterThan(50);
		for (const reaches of [reachesDriver, opensConnection, setsZeroing])
			expect(swept.filter(({ file, source }) => basename(file) === OWNER && reaches(source))).toHaveLength(1);
	});

	it("recognizes a planted reach, typed or not", () => {
		for (const text of [
			'import { DatabaseSync } from "node:sqlite";',
			'import type { StatementSync } from "node:sqlite";',
		])
			expect(reachesDriver(parseSource("planted.ts", text).source)).toBe(true);
	});

	it("recognizes a planted connection and a planted pragma, quoted or templated", () => {
		expect(opensConnection(parseSource("planted.ts", "const db = new DatabaseSync(file);").source)).toBe(true);
		for (const text of ['db.exec("PRAGMA secure_delete = OFF");', "db.exec(`PRAGMA secure_delete = ${mode}`);"])
			expect(setsZeroing(parseSource("planted.ts", text).source)).toBe(true);
	});

	it("reaches the driver nowhere else", () => {
		const offenders = swept
			.filter(({ file, source }) => basename(file) !== OWNER && reachesDriver(source))
			.map(({ file }) => basename(file));

		expect(offenders, "open and prepare through Database in core/src/database.ts").toEqual([]);
	});

	it("opens a connection and sets zeroing nowhere else", () => {
		const offenders = swept
			.filter(({ file, source }) => basename(file) !== OWNER && (opensConnection(source) || setsZeroing(source)))
			.map(({ file }) => basename(file));

		expect(offenders, "Database.open is the one place a connection opens and zeroes").toEqual([]);
	});
});
