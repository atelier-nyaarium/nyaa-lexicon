import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/** Read uses via `uses*`. */
const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

const ROOTS = [join(REPOSITORY, "core", "src"), join(REPOSITORY, "adapters")];

const RAW = /\.references(?:To|In|From)\s*\(/g;

const MENTION_READERS: Record<string, number> = {
	// Rewrites every spelling.
	"core/src/refactorPlanner.ts": 9,
	// Mention is citable evidence.
	"core/src/knowledge.ts": 1,
};

////////////////////////////////
//  Tests

describe("uses are read through the store's use surfaces", () => {
	it("fires on the spellings it forbids", () => {
		expect("this.store.referencesTo(symbolId).filter(isUse)".match(RAW)).toHaveLength(1);
		expect("store.referencesIn (module)".match(RAW)).toHaveLength(1);
		expect("store\n\t.referencesFrom(id)".match(RAW)).toHaveLength(1);
		expect("this.store.usesTo(symbolId)".match(RAW)).toBeNull();
		expect("referencesTo(symbolId: string): StoredReference[] {".match(RAW)).toBeNull();
	});

	it("reads raw rows only where mentions are the point", () => {
		const files = ROOTS.flatMap((root) => sourceFiles(root, ["__tests__", "node_modules", ".tsbuild"]));
		expect(files.length).toBeGreaterThan(50);

		const readers: Record<string, number> = {};
		for (const file of files) {
			const source = readSwept(file);
			if (source === null) continue;
			const count = codeOnly(source).match(RAW)?.length ?? 0;
			if (count > 0) readers[relative(REPOSITORY, file)] = count;
		}
		expect(readers).toEqual(MENTION_READERS);
	});
});
