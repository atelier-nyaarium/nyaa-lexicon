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

/** Records every parse request by method, so a second request or a disk read is visible. */
function supervisorSpy(answer: (text: string) => unknown) {
	const asked: string[] = [];
	const respond = (method: string) => (request: { text: string }) => {
		asked.push(`${method} ${request.text}`);
		const result = answer(request.text);
		if (result instanceof Error) throw result;
		return result as MethodResponse<"parseFile">;
	};
	const supervisor = fakeSupervisor({
		claims: [{ providerId: "fake", language: "fake", extensions: [".ts"] }],
		answers: { parseFile: respond("parseFile"), probeFile: respond("probeFile") },
	});
	return { asked, supervisor };
}

////////////////////////////////
//  Tests

// A candidate is one request: the provider puts back its own view, so no second parse of the disk
// can leave it on text the index refused.
describe("parsing a candidate is one probe", () => {
	it("answers a candidate that parses with one probeFile and nothing else", async () => {
		const { asked, supervisor } = supervisorSpy(() => NO_DIAGNOSTICS);

		const outcome = await liveProbe(supervisor).parseCandidate("a.ts", "candidate");

		expect({ outcome, asked }).toEqual({
			outcome: { parsed: true as const, facts: NO_DIAGNOSTICS },
			asked: ["probeFile candidate"],
		});
	});

	// The TS provider throws on some malformed candidates.
	it("answers error diagnostics and a throwing provider as refusals", async () => {
		const diagnosed = supervisorSpy(() => ({
			...NO_DIAGNOSTICS,
			diagnostics: [{ severity: "error", message: "boom" }],
		}));
		const thrown = supervisorSpy(() => new Error("a descriptor name cannot be empty"));

		expect([
			await liveProbe(diagnosed.supervisor).parseCandidate("a.ts", "candidate"),
			await liveProbe(thrown.supervisor).parseCandidate("a.ts", "candidate"),
		]).toEqual([
			{ parsed: false, reason: "boom" },
			{ parsed: false, reason: "the provider could not parse the candidate: a descriptor name cannot be empty" },
		]);
	});
});
