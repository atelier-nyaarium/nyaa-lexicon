import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	calling,
	exportsNamed,
	importing,
	naming,
	parseSource,
	reachesIn,
	readingStore,
	usesName,
} from "@nyaa-lexicon/protocol/ast";

/**
 * Holds RefactorPlanner to planning.
 *
 * A plan must be safe to ask for, and one that also acted looks exactly like one that did not.
 */
const MODULE = join(import.meta.dirname, "..", "refactorPlanner.ts");

const FORBIDDEN = [
	importing("./supervisor.js", "providers are reached through ProviderProbe"),
	importing("./sourceWriter.js", "planning does not write source"),
	naming(
		["readSource", "sourceReader", "textOf", "fromText"],
		"a module a plan writes is read through SourceWorkspace.writable",
	),
	calling("writeAll", "planning does not write source"),
	calling("writeModule", "planning does not write source"),
	calling("indexFile", "planning does not reindex"),
	readingStore(["replaceFile", "forgetFile"], "the indexer owns what the index holds"),
	importing("./indexer.js", "planning must not be able to start a scan"),
	importing("./service.js", "the planner is upstream of the service"),
	// `renameSymbol` belongs to the caller; the planner neither declares nor calls it.
	naming(["renameSymbol"], "leaves carrying a rename out to the caller"),
];

const parsed = () => parseSource(MODULE, readFileSync(MODULE, "utf8")).source;

////////////////////////////////
//  Tests

describe("the refactor planner plans and does not act", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = parsed();
		expect(exportsNamed(source, "RefactorPlanner")).toBe(true);
		expect(usesName(source, "planReplacement")).toBe(true);
		expect(source.text.length).toBeGreaterThan(20_000);
	});

	it("writes nothing, reindexes nothing, holds no supervisor and carries out no rename", () => {
		expect(
			reachesIn(parsed(), FORBIDDEN),
			"asking for a plan must never be the thing that changes the workspace",
		).toEqual([]);
	});
});
