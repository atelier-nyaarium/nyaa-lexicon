import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly } from "@nyaa-lexicon/protocol";

/** Holds daemonLock.ts as the only claim and the only read of a store's lock in core. */
const SRC = join(import.meta.dirname, "..");

const OWNER = "daemonLock.ts";

/** The link that claims, and the parse that reads. */
const RAW = [/\blinkSync\(/, /\bDaemonLockSchema\.safeParse\(/];

function swept(): string[] {
	return readdirSync(SRC, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== OWNER)
		.map((entry) => entry.name)
		.sort();
}

////////////////////////////////
//  Tests

describe("one lock claim for core", () => {
	it("keeps the owner on the raw primitives, so a passing sweep is never vacuous", () => {
		const owner = codeOnly(readFileSync(join(SRC, OWNER), "utf8"));
		expect(RAW.every((pattern) => pattern.test(owner))).toBe(true);
	});

	it("has no module claiming or reading a lock on its own", () => {
		const modules = swept();
		expect(modules).toContain("daemon.ts");
		expect(modules).toContain("projectStores.ts");

		const offenders: string[] = [];
		for (const name of modules) {
			const code = codeOnly(readFileSync(join(SRC, name), "utf8"));
			for (const pattern of RAW) {
				if (pattern.test(code)) offenders.push(`${name}: ${pattern.source}`);
			}
		}

		expect(offenders, "a store's lock is claimed and read through core/src/daemonLock.ts").toEqual([]);
	});
});
