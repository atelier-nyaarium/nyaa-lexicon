import type { ProviderTiers } from "./providerSession.js";
import { type CaseOutcome, type CaseResult, type SuiteReport, TierSchema } from "./types.js";

function counts(results: CaseResult[]): Pick<SuiteReport, "passed" | "failed" | "skipped" | "stalled"> {
	const of = (outcome: CaseOutcome) => results.filter((r) => r.outcome === outcome).length;
	return { passed: of("passed"), failed: of("failed"), skipped: of("skipped"), stalled: of("stalled") };
}

/** Never answered; nothing known. */
function unreached(result: CaseResult): SuiteReport {
	const tiers = Object.fromEntries(TierSchema.options.map((tier) => [tier, false])) as ProviderTiers;
	return { providerId: "unknown", language: "unknown", tiers, results: [result], ...counts([result]) };
}

const MARKS: Record<CaseOutcome, string> = { passed: "PASS", failed: "FAIL", skipped: "SKIP", stalled: "STALL" };

/** One line per case, plus a tail naming what was skipped and why. */
export function formatReport(report: SuiteReport): string {
	const lines = [`${report.providerId} (${report.language})`];
	for (const result of report.results) {
		lines.push(`  ${MARKS[result.outcome]}  ${result.tier}/${result.caseId}`);
		for (const problem of result.problems) lines.push(`          ${problem}`);
	}
	lines.push(`${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
	if (report.stalled > 0) {
		lines.push(
			`${report.stalled} stalled: a timeout or a dead process, which is the machine or the run, not an answer`,
		);
	}
	return lines.join("\n");
}

export { counts, unreached };
