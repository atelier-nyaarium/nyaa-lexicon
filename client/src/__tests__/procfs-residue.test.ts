import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds procfs.ts as the only reader of /proc.
 *
 * Bug class killed: a second reader with its own opinion of what "no procfs" means. One module
 * answers null off Linux; a second that throws, or answers zero, turns every macOS host into a
 * machine where nothing is alive or nothing uses memory.
 */
const CLIENT_SRC = join(import.meta.dirname, "..");
const CORE_SRC = join(CLIENT_SRC, "..", "..", "core", "src");
const ADAPTERS_SRC = join(CLIENT_SRC, "..", "..", "adapters");

const SWEPT = [CLIENT_SRC, CORE_SRC, ADAPTERS_SRC];

const OWNER = "procfs.ts";

/** The narrowest unambiguous token: a path under the mount, never the word on its own. */
const TOKEN = "/proc/";

const SKIP = ["__tests__", "dist", "node_modules"];

////////////////////////////////
//  Tests

describe("only procfs.ts reads /proc", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
	});

	it("sees the owner itself, so the rule is checking a real token", () => {
		const owner = sourceFiles(CLIENT_SRC, SKIP).find((file) => basename(file) === OWNER);
		expect(owner, "procfs.ts should exist").toBeDefined();
		expect(codeOnly(readFileSync(owner as string, "utf8"))).toContain(TOKEN);
	});

	it("has no /proc path anywhere else in the client, core or the adapters", () => {
		const offenders = SWEPT.flatMap((dir) => sourceFiles(dir, SKIP))
			.filter((file) => basename(file) !== OWNER)
			.filter((file) => {
				const source = readSwept(file);
				return source !== null && codeOnly(source).includes(TOKEN);
			});

		expect(
			offenders,
			"procfs belongs to procfs.ts. Ask it for identity or memory rather than reading the mount.",
		).toEqual([]);
	});
});
