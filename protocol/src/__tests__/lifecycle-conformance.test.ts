import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadLifecycleCases } from "../conformance/lifecycleCorpus";
import { runSuite } from "../conformance/runner";
import { codeOnly, readSwept, sourceFiles } from "../residue";

const PROVIDERS = join(import.meta.dirname, "..", "..", "..", "providers");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "__tests__"]);

/** Stateful providers discovered by store use. */
function statefulProviders(): string[] {
	return readdirSync(PROVIDERS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((provider) =>
			sourceFiles(join(PROVIDERS, provider, "src"), SKIP_DIRS).some((file) =>
				/\b(async)?[mM]oduleStore</.test(codeOnly(readSwept(file) ?? "")),
			),
		)
		.sort();
}

describe("every stateful provider holds what the index holds, over its real wire", () => {
	const cases = loadLifecycleCases();
	const ids = new Set(cases.map((testCase) => testCase.id));

	it("finds the stateful providers, so a passing run is never vacuous", () => {
		expect(statefulProviders().length).toBeGreaterThanOrEqual(9);
	});

	for (const provider of statefulProviders()) {
		// Reject providers skipped for missing fixtures.
		it(provider, async () => {
			const report = await runSuite({
				// Check mode deep-freezes plain data and repeats synchronous reads.
				command: [
					"env",
					"LEXICON_STORE_CHECKS=1",
					process.execPath,
					join(PROVIDERS, provider, "src", "main.ts"),
				],
				cases: [],
				lifecycleCases: cases,
			});
			const lifecycle = report.results.filter((result) => ids.has(result.caseId));
			expect(
				lifecycle
					.filter((result) => result.outcome !== "passed")
					.map((result) => `${result.caseId} ${result.outcome}: ${result.problems.join("; ")}`),
			).toEqual([]);
			expect(lifecycle.length).toBe(ids.size);
			const unseen = lifecycle.find((result) => result.caseId === "probes-and-refusals-are-unseen");
			expect(unseen?.variants?.length).toBe(16);
		}, 240_000);
	}
});
