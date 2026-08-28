import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Holds RefactorPlanner to planning.
 *
 * A plan must be safe to ask for, and one that also acted looks exactly like one that did not.
 */
const MODULE = join(import.meta.dirname, "..", "refactorPlanner.ts");

const FORBIDDEN = [
	{ pattern: /\bfrom "\.\/supervisor\.js"/, why: "providers are reached through ProviderProbe" },
	{ pattern: /\bfrom "\.\/sourceWriter\.js"/, why: "planning does not write source" },
	{ pattern: /\bwriteAll\s*\(/, why: "planning does not write source" },
	{ pattern: /\bwriteModule\s*\(/, why: "planning does not write source" },
	{ pattern: /\bindexFile\s*\(/, why: "planning does not reindex" },
	{ pattern: /\bstore\.(?:replaceFile|forgetFile)/, why: "the indexer owns what the index holds" },
	{ pattern: /\bfrom "\.\/indexer\.js"/, why: "planning must not be able to start a scan" },
	{ pattern: /\bfrom "\.\/service\.js"/, why: "the planner is upstream of the service" },
];

////////////////////////////////
//  Tests

describe("the refactor planner plans and does not act", () => {
	it("finds the module, so a passing run is never vacuous", () => {
		const source = readFileSync(MODULE, "utf8");
		expect(source).toContain("export class RefactorPlanner");
		expect(source).toContain("planReplacement");
		expect(source.length).toBeGreaterThan(20_000);
	});

	it("writes nothing, reindexes nothing, and holds no supervisor", () => {
		const source = readFileSync(MODULE, "utf8");
		const offenders = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
			({ pattern, why }) => `${pattern.source}: ${why}`,
		);

		expect(offenders, "asking for a plan must never be the thing that changes the workspace").toEqual([]);
	});

	// renameSymbol is the one method that carries a rename out, and it is deliberately NOT here.
	it("leaves carrying a rename out to the caller", () => {
		const source = readFileSync(MODULE, "utf8");
		expect(source).not.toMatch(/\brenameSymbol\s*\(/);
	});
});
