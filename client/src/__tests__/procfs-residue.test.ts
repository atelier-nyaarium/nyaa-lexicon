import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { parsedFiles, stringsIn } from "@nyaa-lexicon/protocol/ast";
import type ts from "typescript";

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

/** A path under the mount inside a string, never the word on its own. */
const TOKEN = "/proc/";

const SKIP = ["__tests__", "dist", "node_modules"];

const readsProc = (source: ts.SourceFile): boolean => stringsIn(source).some(({ text }) => text.includes(TOKEN));

////////////////////////////////
//  Tests

describe("only procfs.ts reads /proc", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
	});

	it("sees the owner itself, so the rule is checking a real token", () => {
		const owner = parsedFiles(CLIENT_SRC, SKIP).find(({ file }) => basename(file) === OWNER);
		expect(owner, "procfs.ts should exist").toBeDefined();
		expect(readsProc((owner as { source: ts.SourceFile }).source)).toBe(true);
	});

	it("has no /proc path anywhere else in the client, core or the adapters", () => {
		const offenders = SWEPT.flatMap((dir) => parsedFiles(dir, SKIP))
			.filter(({ file, source }) => basename(file) !== OWNER && readsProc(source))
			.map(({ file }) => file);

		expect(
			offenders,
			"procfs belongs to procfs.ts. Ask it for identity or memory rather than reading the mount.",
		).toEqual([]);
	});
});
