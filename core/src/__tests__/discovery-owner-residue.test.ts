import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { memberCalls, parsedFiles } from "@nyaa-lexicon/protocol/ast";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds RelationDiscovery as the only writer of discovery's export snapshot, queue, suggestions and
 * gaps.
 *
 * Bug class killed: a changed export that never reaches the queue. The snapshot records a shape as
 * seen, so a second writer that records shapes apart from queueing them loses those exports for
 * good; two rounds of patches to separate seed, notice and backfill paths each left one.
 */
const CORE_SRC = join(import.meta.dirname, "..");

const OWNER = "relationDiscovery.ts";

/** The row writes only the owner may call. */
const WRITES = [
	"recordExports",
	"markSeeded",
	"forgetModule",
	"dequeue",
	"replaceDiscovery",
	"addGap",
	"closeGap",
] as const;

const SKIP = ["__tests__", "dist", "node_modules"];

////////////////////////////////
//  Tests

describe("only RelationDiscovery writes discovery's snapshot and queue", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE_SRC, SKIP).length).toBeGreaterThan(0);
	});

	it("sees the owner call every write, so the rule is checking real names", () => {
		const owner = parsedFiles(CORE_SRC, SKIP).find(({ file }) => basename(file) === OWNER);
		if (owner === undefined) throw new Error(`${OWNER} not found`);
		const called = new Set(memberCalls(owner.source, WRITES).map(({ name }) => name));

		expect([...called].sort()).toEqual([...WRITES].sort());
	});

	it("has no discovery write anywhere else in core", () => {
		const offenders = parsedFiles(CORE_SRC, SKIP)
			.filter(({ file }) => basename(file) !== OWNER)
			.flatMap(({ file, source }) => memberCalls(source, WRITES).map(({ name }) => `${file}: ${name}`));

		expect(
			offenders,
			"discovery's snapshot and queue belong to RelationDiscovery. Route through start, observe or settle.",
		).toEqual([]);
	});
});
