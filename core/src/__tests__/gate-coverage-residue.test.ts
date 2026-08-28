import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds every writing dispatch handler inside the workspace gate.
 *
 * Bug class killed: a write path nobody routed through the gate. Taking it is opt-in per handler,
 * so forgetting produces a race rather than an error, and it was forgotten twice: once for watcher
 * batches and once for rename. A new writing method now fails here instead.
 */
const DISPATCH = join(import.meta.dirname, "..", "dispatch.ts");

/** Service calls that touch disk or replace stored facts. Add a method here when you add one. */
const WRITING_CALLS = ["service.indexFile", "transactions().start", "transactions().track"];

/** Calls that put files back, each of which leaves the index describing the version it replaced. */
const RESTORING_CALLS = ["transactions().undo", "transactions().revert"];

/** Closes the handler map, so nothing after it is read as a handler. */
const MAP_END = "\t} satisfies {";

////////////////////////////////
//  Functions & Helpers

/** The handler bodies, split at each two-tab property so a call is judged in the handler making it. */
function handlers(source: string): string[] {
	const end = source.indexOf(MAP_END);
	if (end === -1) throw new Error(`dispatch.ts no longer closes its handler map with ${MAP_END.trim()}`);
	return source
		.slice(0, end)
		.split(/\n(?=\t\t[A-Za-z]+: )/)
		.slice(1);
}

////////////////////////////////
//  Tests

describe("every writing dispatch handler takes the workspace gate", () => {
	const source = readFileSync(DISPATCH, "utf8");

	it("finds the handlers to check, so a passing run is never vacuous", () => {
		expect(handlers(source).length).toBeGreaterThan(10);
	});

	it("sees the writing calls it names, so the list has not gone stale", () => {
		for (const call of WRITING_CALLS) {
			expect(source, `${call} is no longer in dispatch; update WRITING_CALLS`).toContain(call);
		}
	});

	it("wraps each of them in write(...)", () => {
		const offenders: string[] = [];

		for (const handler of handlers(source)) {
			for (const call of WRITING_CALLS) {
				if (!handler.includes(call)) continue;
				// Everything after `write(` in this handler. A writing call must appear there rather
				// than before it, which is what separates a gated handler from one that merely mentions
				// the gate.
				const gated = handler.slice(handler.indexOf("write("));
				if (!handler.includes("write(") || !gated.includes(call)) {
					offenders.push(`${handler.split("\n")[0]?.trim()} calls ${call} outside write(...)`);
				}
			}
		}

		expect(
			offenders,
			"a dispatch handler that writes must run inside the workspace gate, or it can interleave with a refactor step.",
		).toEqual([]);
	});

	// Restoring puts back text the index does not describe, so a restore that skips the reindex
	// leaves the store answering about a version that is no longer on disk. Forgotten twice.
	it("reindexes whatever it restores", () => {
		const offenders: string[] = [];

		for (const handler of handlers(source)) {
			const restores = RESTORING_CALLS.filter((call) => handler.includes(call));
			if (restores.length === 0) continue;
			if (!handler.includes("service.indexFile"))
				offenders.push(`${handler.split("\n")[0]?.trim()} restores without reindexing`);
		}

		expect(offenders, "a dispatch handler that restores files must reindex them.").toEqual([]);
	});
});
