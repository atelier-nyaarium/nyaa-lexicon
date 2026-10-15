import { hashOf } from "./caseSupport.js";
import type { ProviderSession } from "./providerSession.js";
import type { CaseResult, ProbeBatchCase, ProbeBatchFixture } from "./types.js";

/**
 * A batch probe reads its proposed texts as one view and leaves the provider holding what it held.
 *
 * An unsupported answer skips: the provider has not claimed the probe.
 */
async function runProbeBatchCase(
	session: ProviderSession,
	testCase: ProbeBatchCase,
	fixture: ProbeBatchFixture,
	checkProbeBatch: typeof import("./check.js").checkProbeBatch,
): Promise<CaseResult> {
	const held = () =>
		Promise.all(
			fixture.answer.map((module) => {
				const text = fixture.files[module] ?? "";
				return session.call("parseFile", { module, contentHash: hashOf(text), text });
			}),
		);
	const before = await held();
	const files = Object.entries(fixture.probe).map(([module, text]) => ({ module, contentHash: hashOf(text), text }));
	const answer = await session.call("probeBatch", { files, answer: fixture.answer });
	if (answer.status === "unsupported") {
		return { caseId: testCase.id, tier: "protocol", outcome: "skipped", problems: ["probeBatch is unsupported"] };
	}
	const problems = checkProbeBatch(fixture, answer, hashOf);
	if (JSON.stringify(await held()) !== JSON.stringify(before))
		problems.push("the probe changed what the provider holds");
	return { caseId: testCase.id, tier: "protocol", outcome: problems.length === 0 ? "passed" : "failed", problems };
}

export { runProbeBatchCase };
