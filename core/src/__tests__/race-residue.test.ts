import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { calleeOf, callsIn, lineOf, parseSource } from "@nyaa-lexicon/protocol/ast";

/**
 * Holds deadline.ts as the only module in core that races promises.
 *
 * Bug class killed: a request raced against a provider's lifetime promise left one reaction on it
 * per request, retained until the provider died, which a daemon's providers never do. The owner
 * mints the second arm of every race itself, so nothing raced can outlive the call.
 */
const CORE_SRC = join(import.meta.dirname, "..");

const OWNER = "deadline.ts";

const RACES = new Set(["race", "any"]);

const SKIP = ["__tests__", "dist", "node_modules"];

/** Matched by callee rather than by spelling, so spacing and aliasing do not slip past. */
function racesIn(file: string, text: string): string[] {
	const parsed = parseSource(file, text);
	const found: string[] = [];
	for (const call of callsIn(parsed.source)) {
		const callee = calleeOf(call);
		if (callee?.receiver === "Promise" && RACES.has(callee.name)) {
			found.push(`${basename(file)}:${lineOf(parsed, call)} Promise.${callee.name}`);
		}
	}
	return found;
}

////////////////////////////////
//  Tests

describe("one module races promises", () => {
	it("finds source files and the owner, so a passing run is never vacuous", () => {
		const files = sourceFiles(CORE_SRC, SKIP);
		expect(files.length).toBeGreaterThan(10);
		expect(files.map((file) => basename(file))).toContain(OWNER);
	});

	it("sees the owner's races, so the rule is checking real calls", () => {
		const owner = sourceFiles(CORE_SRC, SKIP).find((file) => basename(file) === OWNER) as string;
		expect(racesIn(owner, readSwept(owner) as string).length).toBeGreaterThan(0);
	});

	it("fires on the spellings it forbids", () => {
		expect(racesIn("planted.ts", "await Promise.race([work, closed]);")).toHaveLength(1);
		expect(racesIn("planted.ts", "const first = Promise.any(answers);")).toHaveLength(1);
		expect(racesIn("planted.ts", "await Promise.all([a, b]);")).toHaveLength(0);
	});

	it("races nowhere in production but the owner", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(CORE_SRC, SKIP)) {
			if (basename(file) === OWNER) continue;
			const text = readSwept(file);
			if (text === null) continue;
			offenders.push(...racesIn(file, text));
		}
		expect(
			offenders,
			"a race is a deadline from deadline.ts, which mints the second arm itself; a promise that outlives the call retains every loser",
		).toEqual([]);
	});
});
