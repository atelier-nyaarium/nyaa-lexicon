import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds procfs.ts as the only reader of /proc.
 *
 * Bug class killed: a second reader with its own opinion of what "no procfs" means. One module
 * answers null off Linux; a second that throws, or answers zero, turns every macOS host into a
 * machine where nothing is alive or nothing uses memory.
 */
const CORE_SRC = join(import.meta.dirname, "..");
const ADAPTERS_SRC = join(CORE_SRC, "..", "..", "adapters");

const OWNER = "procfs.ts";

/** The narrowest unambiguous token: a path under the mount, never the word on its own. */
const TOKEN = "/proc/";

////////////////////////////////
//  Functions & Helpers

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "__tests__" || entry === "dist" || entry === "node_modules") continue;
			found.push(...sourceFiles(full));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(full);
	}
	return found;
}

/** Comments only. The path sits inside a string, which is exactly what this looks for. */
function codeOnly(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

////////////////////////////////
//  Tests

describe("only procfs.ts reads /proc", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE_SRC).length).toBeGreaterThan(0);
		expect(sourceFiles(ADAPTERS_SRC).length).toBeGreaterThan(0);
	});

	it("sees the owner itself, so the rule is checking a real token", () => {
		const owner = sourceFiles(CORE_SRC).find((file) => basename(file) === OWNER);
		expect(owner, "procfs.ts should exist").toBeDefined();
		expect(codeOnly(readFileSync(owner as string, "utf8"))).toContain(TOKEN);
	});

	it("has no /proc path anywhere else in core or the adapters", () => {
		const offenders = [...sourceFiles(CORE_SRC), ...sourceFiles(ADAPTERS_SRC)]
			.filter((file) => basename(file) !== OWNER)
			.filter((file) => codeOnly(readFileSync(file, "utf8")).includes(TOKEN));

		expect(
			offenders,
			"procfs belongs to procfs.ts. Ask it for identity or memory rather than reading the mount.",
		).toEqual([]);
	});
});
