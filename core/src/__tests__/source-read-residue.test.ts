import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

/**
 * Holds sourceRead.ts as the only module that reads a workspace file for indexing.
 *
 * Bug class killed: the watcher decoded every changed file as UTF-8 with no routing, no binary
 * guard and no size bound, while the indexer routed first and read the same file again its own
 * way. Two read sites meant two policies, and a third would have been a fourth.
 */
const CORE_SRC = join(import.meta.dirname, "..");
const ADAPTERS_SRC = join(import.meta.dirname, "..", "..", "..", "adapters");

/**
 * Readers of lexicon's OWN state or of a manifest, never of a workspace source file for indexing.
 * transactions.ts reads a workspace file as BYTES for a revert image, which decoding would corrupt.
 */
const OWNERS = new Set([
	"sourceRead.ts",
	"daemon.ts",
	"diagnostics.ts",
	"drift.ts",
	"fileScope.ts",
	"fingerprint.ts",
	"manage.ts",
	"projectRegistry.ts",
	"projectStores.ts",
	"transactions.ts",
]);

const SKIP = ["__tests__", "dist", "node_modules"];

/** Every way node reads a file's bytes. `readFile(` alone is the injected text reader, not fs. */
const READING_TOKENS = ["readFileSync(", "readSync(", "createReadStream(", '"node:fs/promises"'];

////////////////////////////////
//  Tests

describe("one module reads workspace files", () => {
	const files = [...sourceFiles(CORE_SRC, SKIP), ...sourceFiles(ADAPTERS_SRC, SKIP)];

	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it("has the owner it names", () => {
		expect(files.map((file) => basename(file))).toContain("sourceRead.ts");
	});

	it("has no second reader outside the owner and the state readers", () => {
		const offenders: string[] = [];
		for (const file of files) {
			if (OWNERS.has(basename(file))) continue;
			const source = readSwept(file);
			if (source === null) continue;
			const code = codeOnly(source);
			for (const token of READING_TOKENS) {
				if (code.includes(token)) offenders.push(`${basename(file)}: ${token}`);
			}
		}

		expect(
			offenders,
			"a workspace file is read through readSource in sourceRead.ts, which owns the size bound and the binary guard.",
		).toEqual([]);
	});
});
