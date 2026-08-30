import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/** Both absence sentences belong to subjectRefused; "No symbol named X" is a name-lookup miss, not this. */
const PACKAGES = ["core", "adapters"].map((dir) => join(import.meta.dirname, "..", "..", "..", dir));

const OWNER = join(import.meta.dirname, "..", "refusals.ts");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

const SPELLINGS = [/is not in the index/, /No symbol with ID/];

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

////////////////////////////////
//  Tests

describe("one place diagnoses an id that names nothing", () => {
	it("finds source files and the owner, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all).toContain(OWNER);
	});

	it("fires on the spellings it forbids", () => {
		expect(SPELLINGS[0]?.test("return { refused: `${after} is not in the index` };")).toBe(true);
		expect(SPELLINGS[1]?.test("`No symbol with ID \\`${resolved.symbolId}\\` is indexed.`")).toBe(true);
		expect(SPELLINGS[0]?.test("`No symbol named \\`${args.name}\\` is indexed.`")).toBe(false);
	});

	it("composes the sentence nowhere in production but the owner", () => {
		const offenders: string[] = [];
		for (const file of PACKAGES.flatMap(swept)) {
			if (file === OWNER || file.includes("__tests__")) continue;
			const source = readSwept(file);
			if (source === null) continue;
			const code = codeOnly(source);
			if (SPELLINGS.some((spelling) => spelling.test(code))) offenders.push(file);
		}
		expect(offenders, "an id that names nothing is diagnosed by subjectRefused in core/src/refusals.ts").toEqual(
			[],
		);
	});
});
