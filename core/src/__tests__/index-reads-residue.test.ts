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
} from "@nyaa-lexicon/protocol/ast";

/** Holds IndexReadModel to a store. A query that could start a provider is not knowably cheap. */
const MODULE = join(import.meta.dirname, "..", "indexReads.ts");

/** Reaching any of these means a read is no longer only a read. */
const FORBIDDEN = [
	importing("node:fs", "a read must not touch the disk"),
	importing("./supervisor.js", "a read must not be able to start or ask a provider"),
	importing("./sourceWriter.js", "a read must not write"),
	importing("./workspaceGate.js", "a read must not take a lock"),
	importing("./fileScope.js", "scope belongs to the indexer, not to a query"),
	importing("./resultCache.js", "caching a query is the caller's decision"),
	importing("./service.js", "the read model is upstream of the service, never the reverse"),
	readingStore(["replaceFile", "forgetFile"], "a read must not mutate the index", ["record", "write"]),
];

const text = () => readFileSync(MODULE, "utf8");

////////////////////////////////
//  Tests

describe("the index read model reaches nothing but its store", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		expect(exportsNamed(parseSource(MODULE, text()).source, "IndexReadModel")).toBe(true);
		expect(text().length).toBeGreaterThan(5_000);
	});

	it("reaches no provider, no disk, no lock, no cache and no write", () => {
		expect(
			reachesIn(parseSource(MODULE, text()).source, FORBIDDEN),
			"a query that can do more than read the index is not a query any more",
		).toEqual([]);
	});

	// The constructor is the enforcement. A second dependency would have to be added there first.
	it("takes one dependency and it is the store", () => {
		expect(constructorParameters(parseSource(MODULE, text()).source, "IndexReadModel")).toEqual([
			"private readonly store: IndexStore",
		]);
	});
});
