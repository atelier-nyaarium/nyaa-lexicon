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

const READERS = [
	["textFactReads.ts", "TextFactReadModel"],
	["graphReads.ts", "GraphReadModel"],
] as const;
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

const source = (name: string) => readFileSync(join(import.meta.dirname, "..", name), "utf8");

describe("index query readers", () => {
	it("finds both reader modules and their classes", () => {
		for (const [file, model] of READERS) {
			const text = source(file);
			expect(text.length).toBeGreaterThan(1_000);
			expect(exportsNamed(parseSource(join(import.meta.dirname, "..", file), text).source, model)).toBe(true);
		}
	});

	it("hold only the store and reach read paths", () => {
		for (const [file, model] of READERS) {
			const text = source(file);
			const module = parseSource(join(import.meta.dirname, "..", file), text).source;
			expect(constructorParameters(module, model)).toEqual(["private readonly store: IndexStore"]);
			expect(reachesIn(module, FORBIDDEN)).toEqual([]);
		}
	});
});
