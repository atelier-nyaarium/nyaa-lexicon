import { describe, expect, it } from "bun:test";
import type { MethodResponse } from "../providerPort";
import { liveProbe } from "../providerProbe";
import { fakeSupervisor } from "./fakeProvider";

////////////////////////////////
//  Helpers

const NO_DIAGNOSTICS = {
	module: "a.ts",
	contentHash: "empty",
	declarations: [],
	references: [],
	imports: [],
	literals: [],
	diagnostics: [],
};

/** Records every parseFile in order, so a restore is visible as a second call with the disk text. */
function supervisorSpy(answer: (text: string) => unknown) {
	const asked: string[] = [];
	const supervisor = fakeSupervisor({
		claims: [{ providerId: "fake", language: "fake", extensions: [".ts"] }],
		answers: {
			parseFile: (request) => {
				asked.push(request.text);
				const result = answer(request.text);
				if (result instanceof Error) throw result;
				return result as MethodResponse<"parseFile">;
			},
		},
	});
	return { asked, supervisor };
}

////////////////////////////////
//  Tests

// The bug class: the old shape restored the provider on each exit path of the planner by hand, so
// the next early return someone added left it serving text that was never written.
describe("parsing a candidate always leaves the provider on the disk text", () => {
	it("restores after a candidate that parses", async () => {
		const { asked, supervisor } = supervisorSpy(() => NO_DIAGNOSTICS);
		const probe = liveProbe(supervisor, () => "on disk");

		const outcome = await probe.parseCandidate("a.ts", "candidate");

		expect(outcome).toEqual({ parsed: true as const, facts: NO_DIAGNOSTICS });
		expect(asked).toEqual(["candidate", "on disk"]);
	});

	it("restores after a candidate that does not parse", async () => {
		const { asked, supervisor } = supervisorSpy((text) =>
			text === "candidate"
				? { ...NO_DIAGNOSTICS, diagnostics: [{ severity: "error", message: "boom" }] }
				: NO_DIAGNOSTICS,
		);
		const probe = liveProbe(supervisor, () => "on disk");

		const outcome = await probe.parseCandidate("a.ts", "candidate");

		expect(outcome).toEqual({ parsed: false, reason: "boom" });
		expect(asked).toEqual(["candidate", "on disk"]);
	});

	// Found live: the TS provider THROWS on some malformed candidates instead of reporting
	// diagnostics, and the raw transport error leaked to every planner. A throw answers as a
	// refusal, and the restore still runs.
	it("answers a throwing provider as a refusal, restored", async () => {
		const { asked, supervisor } = supervisorSpy((text) =>
			text === "candidate" ? new Error("a descriptor name cannot be empty") : NO_DIAGNOSTICS,
		);
		const probe = liveProbe(supervisor, () => "on disk");

		await expect(probe.parseCandidate("a.ts", "candidate")).resolves.toEqual({
			parsed: false,
			reason: "the provider could not parse the candidate: a descriptor name cannot be empty",
		});
		expect(asked).toEqual(["candidate", "on disk"]);
	});

	// Skipping here left the provider serving the candidate as the view of a module that does not
	// exist, poisoning later binds against it.
	it("restores an absent file to empty, never leaves the candidate standing", async () => {
		const { asked, supervisor } = supervisorSpy(() => NO_DIAGNOSTICS);
		const probe = liveProbe(supervisor, () => null);

		await probe.parseCandidate("a.ts", "candidate");

		expect(asked).toEqual(["candidate", ""]);
	});

	// A failed repair must not replace the caller's answer with an error about the repair.
	it("still answers when the restore itself fails", async () => {
		const { supervisor } = supervisorSpy((text) =>
			text === "on disk" ? new Error("restore failed") : NO_DIAGNOSTICS,
		);
		const probe = liveProbe(supervisor, () => "on disk");

		await expect(probe.parseCandidate("a.ts", "candidate")).resolves.toEqual({
			parsed: true as const,
			facts: NO_DIAGNOSTICS,
		});
	});
});
