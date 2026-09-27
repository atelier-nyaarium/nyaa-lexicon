import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { callsTo, parsedFiles } from "@nyaa-lexicon/protocol/ast";

/**
 * Holds WorkspaceIndexer as the only writer of the index.
 *
 * Two writers race and either order looks plausible. The rule is the WRITE, not the module.
 */
const PACKAGES = ["client", "core", "adapters", "protocol", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one owner. */
const OWNER = "indexer.ts";

/** Defining the methods is not calling them. */
const STORE = "store.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

/** The two calls that change what the index holds for a file. */
const WRITES = ["replaceFile", "forgetFile"];

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

////////////////////////////////
//  Tests

describe("one module writes the index", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	// Tests are OUT of scope: a fixture seeding the store races nothing. The class is two write
	// paths in a running system.
	it("has nobody in production but the indexer replacing or forgetting a file's facts", () => {
		const offenders: string[] = [];
		const exempt = new Set([OWNER, STORE]);

		for (const { file, source } of PACKAGES.flatMap((dir) => parsedFiles(dir, SKIP_DIRS))) {
			if (exempt.has(basename(file)) || file.includes("__tests__")) continue;
			for (const write of WRITES) {
				if (callsTo(source, write).length > 0) offenders.push(`${basename(file)}: ${write}`);
			}
		}

		expect(
			offenders,
			"changing what the index holds belongs to WorkspaceIndexer in core/src/indexer.ts. Ask it to index or forget a module; do not reach past it to the store.",
		).toEqual([]);
	});
});
