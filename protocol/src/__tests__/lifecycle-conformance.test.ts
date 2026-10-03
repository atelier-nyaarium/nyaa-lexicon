import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { instantiates, parsedFiles } from "../astResidue";
import { loadLifecycleCases, loadProbeBatchCases } from "../conformance/lifecycleCorpus";
import { runSuite } from "../conformance/runner";

const PROVIDERS = join(import.meta.dirname, "..", "..", "..", "providers");

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "__tests__"]);

const STORES = new Set(["moduleStore", "ModuleStore", "asyncModuleStore", "AsyncModuleStore"]);

/** Stateful providers discovered by store use. */
function statefulProviders(): string[] {
	return readdirSync(PROVIDERS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((provider) =>
			parsedFiles(join(PROVIDERS, provider, "src"), SKIP_DIRS).some(({ source }) => instantiates(source, STORES)),
		)
		.sort();
}

describe("every stateful provider holds what the index holds, over its real wire", () => {
	const cases = loadLifecycleCases();
	const ids = new Set(cases.map((testCase) => testCase.id));
	const probes = loadProbeBatchCases();
	const probeIds = new Set(probes.map((testCase) => testCase.id));

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
				probeBatchCases: probes,
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
			// A probe the provider has not claimed skips; one it answers must pass.
			const probed = report.results.filter((result) => probeIds.has(result.caseId));
			expect(
				probed
					.filter((result) => result.outcome === "failed" || result.outcome === "stalled")
					.map((result) => `${result.caseId} ${result.outcome}: ${result.problems.join("; ")}`),
			).toEqual([]);
			expect(probed.length).toBe(probeIds.size);
		}, 240_000);
	}
});
