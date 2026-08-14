import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds the knowledge layer to reading.
 *
 * Recording stops being a habit once it can block. Staleness is defined here, once.
 */
const MODULE = join(import.meta.dirname, "..", "knowledge.ts");

const FORBIDDEN = [
	{ pattern: /\bfrom "node:fs"/, why: "the ledger reads the index, never the disk" },
	{ pattern: /\bfrom "\.\/supervisor\.js"/, why: "recording an answer must not wait on a provider" },
	{ pattern: /\bfrom "\.\/sourceWriter\.js"/, why: "the ledger must not write source" },
	{ pattern: /\bfrom "\.\/workspaceGate\.js"/, why: "recording an answer must not take a lock" },
	{ pattern: /\bfrom "\.\/service\.js"/, why: "the ledger is upstream of the service, never the reverse" },
];

////////////////////////////////
//  Tests

describe("the knowledge ledger reads, and does not reach past its store", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = readFileSync(MODULE, "utf8");
		expect(source).toContain("export class KnowledgeLedger");
		expect(source.length).toBeGreaterThan(10_000);
	});

	it("reaches no provider, no disk, no lock and no source write", () => {
		const source = readFileSync(MODULE, "utf8");
		const offenders = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
			({ pattern, why }) => `${pattern.source}: ${why}`,
		);

		expect(offenders, "the knowledge layer answers from the index and the import resolver").toEqual([]);
	});

	// One definition of stale, and it lives here. A second would let two callers disagree about
	// whether recorded prose is still standing on the code it described.
	it("is the only module that decides whether an answer has gone stale", () => {
		const source = readFileSync(MODULE, "utf8");
		expect(source).toContain("staleAnswerCount");

		const service = readFileSync(join(import.meta.dirname, "..", "service.ts"), "utf8");
		const code = service.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
		expect(code).not.toMatch(/resolveFacts\([^)]*\)\.missing/);
	});
});
