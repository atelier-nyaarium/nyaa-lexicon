import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "../residue";

/** Content hashing lives here. */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SWEPT = ["core/src", "client/src"].map((dir) => join(ROOT, dir));

/** Other hash owners. */
const OWNERS = new Set(["client/src/paths.ts", "client/src/discover.ts"]);

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

////////////////////////////////
//  Tests

describe("no second content hash", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP_DIRS).length, dir).toBeGreaterThan(0);
	});

	it("hashes text through the protocol's hashContent alone", () => {
		const offenders: string[] = [];
		for (const dir of SWEPT) {
			for (const file of sourceFiles(dir, SKIP_DIRS)) {
				const name = relative(ROOT, file);
				if (OWNERS.has(name)) continue;
				const source = readSwept(file);
				if (source !== null && /\bcreateHash\s*\(/.test(codeOnly(source))) offenders.push(name);
			}
		}

		expect(
			offenders,
			"import hashContent from @nyaa-lexicon/protocol; a hash of something other than text names its file in OWNERS",
		).toEqual([]);
	});
});
