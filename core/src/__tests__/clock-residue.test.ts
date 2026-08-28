import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";

/** Holds clock.ts as the only source of time for the routed modules, so one fake controls them all. */
const SRC = join(import.meta.dirname, "..");

/** The one owner. */
const OWNER = "clock.ts";

/** Modules that take time only from the clock. Add a module here when routing it. */
const ROUTED = ["diagnostics.ts", "drift.ts", "lifetime.ts", "liveIndex.ts", "watcher.ts"];

/** Reaching for the wall or the host timers directly. */
const RAW = [
	/\bDate\.now\(/,
	/\bperformance\.now\(/,
	/\bprocess\.hrtime\b/,
	/\bsetTimeout\(/,
	/\bclearTimeout\(/,
	/\bsetInterval\(/,
	/\bclearInterval\(/,
];

////////////////////////////////
//  Tests

describe("one clock for the routed modules", () => {
	it("keeps the owner on the raw primitives, so a passing sweep is never vacuous", () => {
		const owner = codeOnly(readFileSync(join(SRC, OWNER), "utf8"));
		expect(RAW.filter((pattern) => pattern.test(owner)).length).toBeGreaterThan(2);
	});

	it("has no routed module reaching past the clock", () => {
		const offenders: string[] = [];
		for (const name of ROUTED) {
			const code = codeOnly(readFileSync(join(SRC, name), "utf8"));
			for (const pattern of RAW) {
				if (pattern.test(code)) offenders.push(`${name}: ${pattern.source}`);
			}
		}

		expect(
			offenders,
			"time for these modules comes from the Clock in core/src/clock.ts, injected or systemClock",
		).toEqual([]);
	});
});
