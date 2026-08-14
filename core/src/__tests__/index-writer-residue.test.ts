import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds WorkspaceIndexer as the only writer of the index.
 *
 * Two writers race and either order looks plausible. The rule is the WRITE, not the module.
 */
const PACKAGES = ["core", "adapters", "protocol", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one owner. */
const OWNER = "indexer.ts";

/** Defining the methods is not calling them. */
const STORE = "store.ts";

/** This file, which names the forbidden calls in its own patterns. */
const RULE = "index-writer-residue.test.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

/** The two calls that change what the index holds for a file. */
const WRITES = [/\breplaceFile\s*\(/, /\bforgetFile\s*\(/];

////////////////////////////////
//  Functions & Helpers

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}

	for (const entry of entries) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue;
			found.push(...sourceFiles(full));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(full);
	}
	return found;
}

/** Comments only. Prose describing the rule is not breaking it. */
function codeOnly(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

////////////////////////////////
//  Tests

describe("one module writes the index", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(sourceFiles);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	// Tests are OUT of scope: a fixture seeding the store races nothing. The class is two write
	// paths in a running system.
	it("has nobody in production but the indexer replacing or forgetting a file's facts", () => {
		const offenders: string[] = [];
		const exempt = new Set([OWNER, STORE, RULE]);

		for (const file of PACKAGES.flatMap(sourceFiles)) {
			if (exempt.has(basename(file)) || file.includes("__tests__")) continue;
			const code = codeOnly(readFileSync(file, "utf8"));
			for (const pattern of WRITES) {
				if (pattern.test(code)) offenders.push(`${basename(file)}: ${pattern.source}`);
			}
		}

		expect(
			offenders,
			"changing what the index holds belongs to WorkspaceIndexer in core/src/indexer.ts. Ask it to index or forget a module; do not reach past it to the store.",
		).toEqual([]);
	});
});
