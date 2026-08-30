import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly } from "@nyaa-lexicon/protocol";

/** Holds clock.ts as the only source of time in core, so one fake controls a whole daemon. */
const SRC = join(import.meta.dirname, "..");

/** The one owner. */
const OWNER = "clock.ts";

/** Reaching for the wall or the host timers directly. */
const RAW = [
	/\bDate\.now\b/,
	/\bDate\s*\[/,
	/\bnew Date\(\)/,
	/\bperformance\.now\(/,
	/\bprocess\.hrtime\b/,
	/\bsetTimeout\(/,
	/\bclearTimeout\(/,
	/\bsetInterval\(/,
	/\bclearInterval\(/,
	/\bsetImmediate\(/,
	/\bBun\.sleep\(/,
	/\bBun\.nanoseconds\(/,
	/node:timers/,
];

/** Every production module of core: the top-level sources, tests and the owner aside. */
function swept(): string[] {
	return readdirSync(SRC, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== OWNER)
		.map((entry) => entry.name)
		.sort();
}

////////////////////////////////
//  Tests

describe("one clock for core", () => {
	it("keeps the owner on the raw primitives, so a passing sweep is never vacuous", () => {
		const owner = codeOnly(readFileSync(join(SRC, OWNER), "utf8"));
		expect(RAW.filter((pattern) => pattern.test(owner)).length).toBeGreaterThan(2);
	});

	it("has no module reaching past the clock", () => {
		const modules = swept();
		expect(modules.length).toBeGreaterThan(20);
		expect(modules).toContain("knowledge.ts");
		expect(modules).toContain("daemonCli.ts");

		const offenders: string[] = [];
		for (const name of modules) {
			const code = codeOnly(readFileSync(join(SRC, name), "utf8"));
			for (const pattern of RAW) {
				if (pattern.test(code)) offenders.push(`${name}: ${pattern.source}`);
			}
		}

		expect(offenders, "time in core comes from the Clock in core/src/clock.ts, injected or systemClock").toEqual(
			[],
		);
	});
});
