import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds every writing dispatch case inside the workspace gate.
 *
 * Bug class killed: a write path nobody routed through the gate. Taking it is opt-in per case, so
 * forgetting produces a race rather than an error, and it was forgotten twice: once for watcher
 * batches and once for rename. A new writing method now fails here instead.
 */
const DISPATCH = join(import.meta.dirname, "..", "dispatch.ts");

/** Service calls that touch disk or replace stored facts. Add a method here when you add one. */
const WRITING_CALLS = ["service.indexFile", "transactions().start", "transactions().track"];

////////////////////////////////
//  Functions & Helpers

/** The dispatch case bodies, split so each call is judged in the arm that makes it. */
function arms(source: string): string[] {
	return source.split(/\n\t\t\tcase /).slice(1);
}

////////////////////////////////
//  Tests

describe("every writing dispatch case takes the workspace gate", () => {
	const source = readFileSync(DISPATCH, "utf8");

	it("finds the dispatch arms to check, so a passing run is never vacuous", () => {
		expect(arms(source).length).toBeGreaterThan(10);
	});

	it("sees the writing calls it names, so the list has not gone stale", () => {
		for (const call of WRITING_CALLS) {
			expect(source, `${call} is no longer in dispatch; update WRITING_CALLS`).toContain(call);
		}
	});

	it("wraps each of them in write(...)", () => {
		const offenders: string[] = [];

		for (const arm of arms(source)) {
			for (const call of WRITING_CALLS) {
				if (!arm.includes(call)) continue;
				// Everything after `write(` in this arm. A writing call must appear there rather than
				// before it, which is what separates a gated arm from one that merely mentions the gate.
				const gated = arm.slice(arm.indexOf("write("));
				if (!arm.includes("write(") || !gated.includes(call)) {
					offenders.push(`${arm.split("\n")[0]?.trim()} calls ${call} outside write(...)`);
				}
			}
		}

		expect(
			offenders,
			"a dispatch case that writes must run inside the workspace gate, or it can interleave with a refactor step.",
		).toEqual([]);
	});
});
