import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { mentionsWord, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";

/** Identity changes by rebinding an address in one owner: no second module names the subjects
 * table, and no helper moves knowledge rows between keys. */
const PACKAGES = ["client", "core", "adapters", "protocol", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

const OWNER = join(import.meta.dirname, "..", "subjects.ts");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

const TABLE = "knowledge_subjects";

const ROW_MOVE = "migrateKnowledge";

const production = () =>
	PACKAGES.flatMap((dir) => parsedFiles(dir, SKIP_DIRS)).filter(({ file }) => !file.includes("__tests__"));

const probe = (code: string, word: string) => mentionsWord(parseSource("probe.ts", code).source, word);

////////////////////////////////
//  Tests

describe("one module owns knowledge identity", () => {
	it("finds source files and the owner, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap((dir) => sourceFiles(dir, SKIP_DIRS));
		expect(all.length).toBeGreaterThan(50);
		expect(all).toContain(OWNER);
	});

	it("fires on the spellings it forbids", () => {
		expect(probe('db.prepare("SELECT 1 FROM knowledge_subjects WHERE subjectId = ?")', TABLE)).toBe(true);
		expect(probe('db.prepare("SELECT 1 FROM knowledge_subjects_from")', TABLE)).toBe(false);
		expect(probe("// knowledge_subjects\nconst a = 1;", TABLE)).toBe(false);
		expect(probe("service.migrateKnowledge(entries)", ROW_MOVE)).toBe(true);
	});

	it("names the subjects table nowhere in production but the owner", () => {
		const offenders = production()
			.filter(({ file, source }) => file !== OWNER && mentionsWord(source, TABLE))
			.map(({ file }) => file);
		expect(offenders, "the subjects table belongs to core/src/subjects.ts; read it through its views").toEqual([]);
	});

	it("has no row move left anywhere in production", () => {
		const offenders = production()
			.filter(({ source }) => mentionsWord(source, ROW_MOVE))
			.map(({ file }) => file);
		expect(offenders, "knowledge rows never change key; rebind the subject's address instead").toEqual([]);
	});
});
