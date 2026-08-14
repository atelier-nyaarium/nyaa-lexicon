import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds the knowledge layer to reading, so recording what you concluded stays cheap.
 *
 * The reason is behavioural rather than aesthetic. An agent is meant to record an answer as a
 * matter of course, and it will stop doing that the moment the call can block on a provider or a
 * lock. Keeping the ledger to its store and the import resolver is what makes "write down what you
 * worked out" a cheap habit rather than a decision.
 *
 * It also keeps the honest-incompleteness property checkable: staleness is defined here, once, by
 * whether cited facts still resolve. A second definition somewhere with its own provider access
 * could disagree about whether an answer is current, which is the one lie this project exists to
 * stop telling.
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
