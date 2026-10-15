import { applyEdits } from "../edits.js";
import type { MethodResponse, ProviderSession } from "./providerSession.js";
import { Stall } from "./providerSession.js";
import type { CaseResult, MoveCase, MoveFixture } from "./types.js";

function checkReadyMove(fixture: MoveFixture, answer: MethodResponse<"moveEdits">): string[] {
	if (answer.status === "refused") {
		return [`moveEdits refused with ${answer.reason}, expected ready`];
	}
	if (answer.blocked.length > 0) {
		return [
			`moveEdits blocked with ${answer.blocked.map((site) => site.reason).join(", ")}, expected no blocked sites`,
		];
	}

	const applied = applyEdits(fixture.request.text, answer.edits);
	if ("problem" in applied) return [`could not apply move edits: ${applied.problem}`];

	const problems: string[] = [];
	if (fixture.expect.kind !== "ready") return ["internal move expectation mismatch"];
	for (const [module, expected] of Object.entries(fixture.expect.files)) {
		const actual = module === fixture.request.module ? applied.text : fixture.files[module];
		if (actual === undefined) {
			problems.push(`expected post-state names ${module}, which is not in the fixture`);
		} else if (actual !== expected) {
			problems.push(
				`post-state for ${module} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
			);
		}
	}
	return problems;
}

function checkBlockedMove(fixture: MoveFixture, answer: MethodResponse<"moveEdits">): string[] {
	if (answer.status === "refused") {
		return [`moveEdits refused with ${answer.reason}, expected blocked sites`];
	}
	if (answer.blocked.length === 0) return ["moveEdits had no blocked sites, expected at least one"];
	if (fixture.expect.kind !== "blocked" || fixture.expect.reasons === undefined) return [];

	const actual = new Set(answer.blocked.map((site) => site.reason));
	return fixture.expect.reasons
		.filter((reason) => !actual.has(reason))
		.map((reason) => `blocked reasons were ${[...actual].join(", ")}, expected ${reason}`);
}

function checkRefusedMove(fixture: MoveFixture, answer: MethodResponse<"moveEdits">): string[] {
	if (fixture.expect.kind !== "refused") return ["internal move expectation mismatch"];
	if (answer.status === "ready") return [`moveEdits answered ready, expected refusal ${fixture.expect.reason}`];
	return answer.reason === fixture.expect.reason
		? []
		: [`moveEdits refused with ${answer.reason}, expected ${fixture.expect.reason}`];
}

async function runMoveCase(session: ProviderSession, testCase: MoveCase, fixture: MoveFixture): Promise<CaseResult> {
	try {
		const answer = await session.call("moveEdits", fixture.request);
		if (answer.status === "refused" && answer.reason === "NotImplemented") {
			return {
				caseId: testCase.id,
				tier: "protocol",
				outcome: "skipped",
				problems: [
					`moveEdits refused with NotImplemented${answer.detail === undefined ? "" : `: ${answer.detail}`}`,
				],
			};
		}

		const problems =
			fixture.expect.kind === "ready"
				? checkReadyMove(fixture, answer)
				: fixture.expect.kind === "blocked"
					? checkBlockedMove(fixture, answer)
					: checkRefusedMove(fixture, answer);
		return {
			caseId: testCase.id,
			tier: "protocol",
			outcome: problems.length === 0 ? "passed" : "failed",
			problems,
		};
	} catch (error) {
		if (error instanceof Stall) throw error;
		return {
			caseId: testCase.id,
			tier: "protocol",
			outcome: "failed",
			problems: [error instanceof Error ? error.message : String(error)],
		};
	}
}

export { runMoveCase };
