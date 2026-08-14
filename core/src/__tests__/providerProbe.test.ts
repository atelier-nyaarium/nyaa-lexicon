import { describe, expect, it, vi } from "vitest";
import { liveProbe } from "../providerProbe";
import type { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

const NO_DIAGNOSTICS = { declarations: [], references: [], imports: [], literals: [], diagnostics: [] };

/** Records every parseFile in order, so a restore is visible as a second call with the disk text. */
function supervisorSpy(answer: (text: string) => unknown) {
	const asked: string[] = [];
	const ask = vi.fn(async (_module: string, _method: string, params: { text: string }) => {
		asked.push(params.text);
		const result = answer(params.text);
		if (result instanceof Error) throw result;
		return result;
	});
	return { asked, supervisor: { ask } as unknown as ProviderSupervisor };
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

		expect(outcome).toEqual({ parsed: true, facts: NO_DIAGNOSTICS });
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

	// The path no hand-written restore ever covered.
	it("restores when the provider throws", async () => {
		const { asked, supervisor } = supervisorSpy((text) =>
			text === "candidate" ? new Error("provider died") : NO_DIAGNOSTICS,
		);
		const probe = liveProbe(supervisor, () => "on disk");

		await expect(probe.parseCandidate("a.ts", "candidate")).rejects.toThrow("provider died");
		expect(asked).toEqual(["candidate", "on disk"]);
	});

	it("skips the restore when the file is gone, rather than parsing nothing", async () => {
		const { asked, supervisor } = supervisorSpy(() => NO_DIAGNOSTICS);
		const probe = liveProbe(supervisor, () => null);

		await probe.parseCandidate("a.ts", "candidate");

		expect(asked).toEqual(["candidate"]);
	});

	// A failed repair must not replace the caller's answer with an error about the repair.
	it("still answers when the restore itself fails", async () => {
		const { supervisor } = supervisorSpy((text) =>
			text === "on disk" ? new Error("restore failed") : NO_DIAGNOSTICS,
		);
		const probe = liveProbe(supervisor, () => "on disk");

		await expect(probe.parseCandidate("a.ts", "candidate")).resolves.toEqual({
			parsed: true,
			facts: NO_DIAGNOSTICS,
		});
	});
});
