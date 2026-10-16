import { describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { parsedFiles, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";

/**
 * Store purge owns WAL truncation, page rewriting, and its marker.
 * Rebuilds replace the database file.
 */
const CORE = new URL("..", import.meta.url).pathname;

const OWNER = "storePurge.ts";

const REBUILDER = "store.ts";

type Source = ReturnType<typeof parseSource>["source"];

const naming = (word: string) => (source: Source) => stringsIn(source).some(({ text }) => text.includes(word));

const rewriting = (source: Source) => stringsIn(source).some(({ text }) => /\bVACUUM\b/i.test(text));

const dropping = (source: Source) => stringsIn(source).some(({ text }) => /\bDROP\s+(?:TABLE|VIEW)\b/i.test(text));

const NAMES: Array<[string, (source: Source) => boolean]> = [
	["wal_checkpoint", naming("wal_checkpoint")],
	["the pending flag key", naming("securePurgePending")],
	["the scrub marker key", naming("scrubbedMajor")],
	["an in-place VACUUM", rewriting],
];

describe("one owner of what a delete leaves behind", () => {
	const swept = parsedFiles(CORE, ["__tests__"]);

	it("sweeps core and finds the owner naming each, so a passing run is never vacuous", () => {
		expect(swept.length).toBeGreaterThan(50);
		for (const [, names] of NAMES)
			expect(swept.filter(({ file, source }) => basename(file) === OWNER && names(source))).toHaveLength(1);
	});

	it("recognizes a planted checkpoint, key and rewrite, quoted or templated", () => {
		const planted = [
			'db.exec("PRAGMA wal_checkpoint(TRUNCATE)");',
			"db.exec(`PRAGMA wal_checkpoint(${mode})`);",
			'const KEY = "securePurgePending";',
			"db.prepare(`DELETE FROM meta WHERE key = 'securePurgePending'`).run();",
			'const MARK = "scrubbedMajor";',
			'db.exec("VACUUM");',
			"db.exec(`vacuum ${schema}`);",
			"db.exec(`VACUUM INTO '${staging}'`);",
		];
		for (const text of planted) {
			const source = parseSource("planted.ts", text).source;
			expect(
				NAMES.some(([, names]) => names(source)),
				text,
			).toBe(true);
		}
	});

	it("names none of them anywhere else", () => {
		const offenders = swept
			.filter(({ file }) => basename(file) !== OWNER)
			.flatMap(({ file, source }) =>
				NAMES.filter(([, names]) => names(source)).map(([what]) => `${basename(file)}: ${what}`),
			);

		expect(offenders, "arm, settle, clear and scrub through StorePurge in core/src/storePurge.ts").toEqual([]);
	});
});

describe("a rebuild never drops in place", () => {
	const swept = parsedFiles(CORE, ["__tests__"]);

	it("finds the store, so a passing run is never vacuous", () => {
		expect(swept.filter(({ file }) => basename(file) === REBUILDER)).toHaveLength(1);
	});

	it("recognizes a planted drop, quoted or templated", () => {
		for (const text of [
			'db.exec("DROP TABLE files");',
			'db.exec(`DROP TABLE IF EXISTS "${table}"`);',
			"db.exec(`drop view ${name}`);",
		])
			expect(dropping(parseSource("planted.ts", text).source), text).toBe(true);
	});

	it("names no drop in the store, which writes a new file instead", () => {
		const offenders = swept.filter(({ file, source }) => basename(file) === REBUILDER && dropping(source));

		expect(offenders.map(({ file }) => basename(file))).toEqual([]);
	});
});
