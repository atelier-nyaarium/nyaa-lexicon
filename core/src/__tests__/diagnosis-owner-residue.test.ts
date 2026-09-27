import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { parsedFiles, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

/** Both absence sentences belong to subjectRefused; "No symbol named X" is a name-lookup miss, not this. */
const PACKAGES = ["core", "adapters"].map((dir) => join(import.meta.dirname, "..", "..", "..", dir));

const OWNER = join(import.meta.dirname, "..", "refusals.ts");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

const SPELLINGS = ["is not in the index", "No symbol with ID"];

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

/** Composes a sentence: one string or template piece holds a spelling. */
const composes = (root: ts.Node): boolean =>
	stringsIn(root).some(({ text }) => SPELLINGS.some((spelling) => text.includes(spelling)));

const probe = (code: string) => composes(parseSource("probe.ts", code).source);

////////////////////////////////
//  Tests

describe("one place diagnoses an id that names nothing", () => {
	it("finds source files and the owner, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all).toContain(OWNER);
	});

	it("fires on the spellings it forbids", () => {
		expect(probe("const r = { refused: `${after} is not in the index` };")).toBe(true);
		expect(probe("const r = `No symbol with ID \\`${resolved.symbolId}\\` is indexed.`;")).toBe(true);
		expect(probe("const r = `No symbol named \\`${args.name}\\` is indexed.`;")).toBe(false);
		expect(probe("// No symbol with ID\nconst r = 1;")).toBe(false);
	});

	it("composes the sentence nowhere in production but the owner", () => {
		const offenders = PACKAGES.flatMap((dir) => parsedFiles(dir, SKIP_DIRS))
			.filter(({ file, source }) => file !== OWNER && !file.includes("__tests__") && composes(source))
			.map(({ file }) => file);
		expect(offenders, "an id that names nothing is diagnosed by subjectRefused in core/src/refusals.ts").toEqual(
			[],
		);
	});
});
