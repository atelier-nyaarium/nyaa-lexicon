import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/** Identity changes by rebinding an address in one owner: no second module names the subjects
 * table, and no helper moves knowledge rows between keys. */
const PACKAGES = ["client", "core", "adapters", "protocol", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

const OWNER = join(import.meta.dirname, "..", "subjects.ts");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

const TABLE = /\bknowledge_subjects\b/;

const ROW_MOVE = /\bmigrateKnowledge\b/;

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

////////////////////////////////
//  Tests

describe("one module owns knowledge identity", () => {
	it("finds source files and the owner, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all).toContain(OWNER);
	});

	it("fires on the spellings it forbids", () => {
		expect(TABLE.test('db.prepare("SELECT 1 FROM knowledge_subjects WHERE subjectId = ?")')).toBe(true);
		expect(TABLE.test("knowledge_subjects_from")).toBe(false);
		expect(ROW_MOVE.test("service.migrateKnowledge(entries)")).toBe(true);
	});

	it("names the subjects table nowhere in production but the owner", () => {
		const offenders: string[] = [];
		for (const file of PACKAGES.flatMap(swept)) {
			if (file === OWNER || file.includes("__tests__")) continue;
			const source = readSwept(file);
			if (source === null) continue;
			if (TABLE.test(codeOnly(source))) offenders.push(file);
		}
		expect(offenders, "the subjects table belongs to core/src/subjects.ts; read it through its views").toEqual([]);
	});

	it("has no row move left anywhere in production", () => {
		const offenders: string[] = [];
		for (const file of PACKAGES.flatMap(swept)) {
			if (file.includes("__tests__")) continue;
			const source = readSwept(file);
			if (source === null) continue;
			if (ROW_MOVE.test(codeOnly(source))) offenders.push(file);
		}
		expect(offenders, "knowledge rows never change key; rebind the subject's address instead").toEqual([]);
	});
});
