import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	calleeOf,
	exportsNamed,
	importing,
	memberReads,
	parseSource,
	reachesIn,
	usesName,
} from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * Holds the knowledge layer to reading.
 *
 * Recording stops being a habit once it can block. Staleness is defined here, once.
 */
const MODULE = join(import.meta.dirname, "..", "knowledge.ts");

const SERVICE = join(import.meta.dirname, "..", "service.ts");

const FORBIDDEN = [
	importing("node:fs", "the ledger reads the index, never the disk"),
	importing("./supervisor.js", "recording an answer must not wait on a provider"),
	importing("./sourceWriter.js", "the ledger must not write source"),
	importing("./workspaceGate.js", "recording an answer must not take a lock"),
	importing("./service.js", "the ledger is upstream of the service, never the reverse"),
];

const parsed = (file: string) => parseSource(file, readFileSync(file, "utf8")).source;

////////////////////////////////
//  Tests

describe("the knowledge ledger reads, and does not reach past its store", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		expect(exportsNamed(parsed(MODULE), "KnowledgeLedger")).toBe(true);
		expect(readFileSync(MODULE, "utf8").length).toBeGreaterThan(10_000);
	});

	it("reaches no provider, no disk, no lock and no source write", () => {
		expect(
			reachesIn(parsed(MODULE), FORBIDDEN),
			"the knowledge layer answers from the index and the import resolver",
		).toEqual([]);
	});

	// One definition of stale, and it lives here. A second would let two callers disagree about
	// whether recorded prose is still standing on the code it described.
	it("is the only module that decides whether an answer has gone stale", () => {
		expect(usesName(parsed(MODULE), "staleAnswerCount")).toBe(true);

		// `resolveFacts(...).missing`, read off the call's own answer.
		const judged = memberReads(parsed(SERVICE)).filter(
			({ node, name }) =>
				name === "missing" &&
				ts.isCallExpression(node.expression) &&
				calleeOf(node.expression)?.name === "resolveFacts",
		);
		expect(judged).toEqual([]);
	});
});
