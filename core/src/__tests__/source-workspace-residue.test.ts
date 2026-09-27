import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	constructorParameters,
	exportsNamed,
	importing,
	parseSource,
	reachesIn,
	readingStore,
	usesName,
} from "@nyaa-lexicon/protocol/ast";

/**
 * Holds SourceWorkspace to the disk side.
 *
 * Repairing provider state looks like source reading and is not; admitting it adds a supervisor.
 */
const MODULE = join(import.meta.dirname, "..", "sourceWorkspace.ts");

const FORBIDDEN = [
	importing("./supervisor.js", "reading the workspace must not be able to ask a provider"),
	importing("./service.js", "the source workspace is upstream of the service"),
	readingStore(["replaceFile", "forgetFile"], "the indexer owns what the index holds"),
	importing("node:fs", "reads go through the injected reader, writes through sourceWriter"),
];

const parsed = () => parseSource(MODULE, readFileSync(MODULE, "utf8")).source;

////////////////////////////////
//  Tests

describe("the source workspace is the disk side and only that", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = parsed();
		expect(exportsNamed(source, "SourceWorkspace")).toBe(true);
		expect(usesName(source, "symbolSource")).toBe(true);
	});

	it("reaches no provider, no index write and no direct filesystem", () => {
		expect(
			reachesIn(parsed(), FORBIDDEN),
			"the source workspace reads text and writes text; it does not parse it",
		).toEqual([]);
	});

	it("takes a store, a reader and a root, and nothing else", () => {
		expect(constructorParameters(parsed(), "SourceWorkspace")).toEqual([
			"private readonly store: IndexStore",
			"private readonly readSource: SourceReader",
			"private readonly workspaceRoot: string",
		]);
	});
});
