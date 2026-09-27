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

/** Holds ImportResolver to its port, so the language-specific half stays out of it. */
const MODULE = join(import.meta.dirname, "..", "imports.ts");

const FORBIDDEN = [
	importing("./supervisor.js", "providers are reached through the port, not a supervisor"),
	importing("./resultCache.js", "whoever supplies the port owns the caching"),
	importing("./fileScope.js", "surface globs are a workspace decision, not an import one"),
	importing("node:fs", "resolution reads the index and the port, never the disk"),
	importing("./service.js", "the resolver is upstream of the service, never the reverse"),
	readingStore(["replaceFile", "forgetFile"], "resolving must not mutate the index"),
];

const parsed = () => parseSource(MODULE, readFileSync(MODULE, "utf8")).source;

////////////////////////////////
//  Tests

describe("the import resolver reaches its store and one port", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = parsed();
		expect(exportsNamed(source, "ImportResolver")).toBe(true);
		expect(exportsNamed(source, "ResolveSpecifier")).toBe(true);
	});

	it("reaches no supervisor, no cache, no scope, no disk and no write", () => {
		expect(reachesIn(parsed(), FORBIDDEN), "language-specific resolution belongs behind ResolveSpecifier").toEqual(
			[],
		);
	});

	// Two dependencies and no more. A third would have to be added here first.
	it("takes the store and the port, and nothing else", () => {
		expect(constructorParameters(parsed(), "ImportResolver")).toEqual([
			"private readonly store: IndexStore",
			"private readonly resolve: ResolveSpecifier",
		]);
	});
});
