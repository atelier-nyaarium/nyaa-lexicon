import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds RefactorPlanner to planning.
 *
 * The property this buys is worth more than tidiness: a plan is always safe to ask for. A caller
 * can show one to a human, or throw it away, and nothing has happened. That stops being true the
 * moment one planning path writes a file or reindexes one, and it stops being true SILENTLY, since
 * a plan that also acted looks exactly like a plan that did not.
 *
 * Providers are reachable only through ProviderProbe. That is what keeps planning a replacement
 * from leaving a provider holding text nobody wrote: the probe restores it in a finally, where the
 * planner used to do it by hand once per exit path and would eventually miss one.
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
