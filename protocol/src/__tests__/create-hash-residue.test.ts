import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "../residue";

/**
 * One content hash, `hashContent` in this package. A second sha256 over file text in core or the
 * client would file facts under one hash and compare a consumer's read against another, and the
 * two never meet until a stale answer does. Hashes of other things keep their own owner.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SWEPT = ["core/src", "client/src"].map((dir) => join(ROOT, dir));

/** Not content hashes: a refactor image's bytes, a workspace's key, a bundle's identity. */
const OWNERS = new Set(["core/src/transactions.ts", "client/src/paths.ts", "client/src/discover.ts"]);

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
