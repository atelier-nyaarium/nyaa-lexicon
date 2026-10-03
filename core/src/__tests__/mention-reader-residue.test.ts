import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { memberCalls, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

/** Read uses via `uses*`. */
const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

const ROOTS = [join(REPOSITORY, "core", "src"), join(REPOSITORY, "adapters")];

const RAW = ["referencesTo", "referencesIn", "referencesFrom"];

const MENTION_READERS: Record<string, number> = {
	// Rewrites every spelling.
	"core/src/refactorPlanner.ts": 9,
	// Rewrites every spelling a route proves, and refuses on unbound ones it reaches, a wildcard would capture, or a shared import reads.
	"core/src/renameRoutes.ts": 4,
	// Compares every use of each answered module before and after the candidate.
	"core/src/renameValidation.ts": 2,
	// Re-points every importer and qualified use.
	"core/src/arrangePlanner.ts": 2,
	// Mention is citable evidence.
	"core/src/knowledge.ts": 1,
	// Stamps the row's own module.
	"core/src/readContext.ts": 2,
	// Painting and the cursor see every reference span, imports and exports included.
	"core/src/paintFacts.ts": 2,
};

const rawReads = (root: ts.Node): number => memberCalls(root, RAW).length;

const probe = (code: string): number => rawReads(parseSource("probe.ts", code).source);

////////////////////////////////
//  Tests

describe("uses are read through the store's use surfaces", () => {
	it("fires on the spellings it forbids", () => {
		expect(probe("this.store.referencesTo(symbolId).filter(isUse)")).toBe(1);
		expect(probe("store.referencesIn (module)")).toBe(1);
		expect(probe("store\n\t.referencesFrom(id)")).toBe(1);
		expect(probe("this.store.usesTo(symbolId)")).toBe(0);
		expect(probe("class S { referencesTo(symbolId: string): StoredReference[] { return []; } }")).toBe(0);
	});

	it("reads raw rows only where mentions are the point", () => {
		const files = ROOTS.flatMap((root) => parsedFiles(root, ["__tests__", "node_modules", ".tsbuild"]));
		expect(files.length).toBeGreaterThan(50);

		const readers: Record<string, number> = {};
		for (const { file, source } of files) {
			const count = rawReads(source);
			if (count > 0) readers[relative(REPOSITORY, file)] = count;
		}
		expect(readers).toEqual(MENTION_READERS);
	});
});
