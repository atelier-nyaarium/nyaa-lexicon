import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codeOnly, sourceFiles } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";

/**
 * Holds sourceWriter.ts as the only module that writes a source file in the workspace.
 *
 * Bug class killed: three modules hand-rolled the same write-then-rename and each spelled the temp
 * suffix itself, while recovery swept for exactly that literal. Nothing failed if one drifted, so
 * the crash guarantee rested on three authors happening to agree. One owner makes them agree by
 * construction.
 */
const CORE_SRC = join(import.meta.dirname, "..");

/** Writing a file to the workspace, and the temp name recovery looks for. */
const WRITING_CALLS = ["writeFileSync", "renameSync"];

const TEMPORARY_SUFFIX = "lexicon-tmp";

/** The one writer. daemon.ts, projectRegistry.ts and diagnostics.ts (the memory collection) write
 * lexicon's OWN state, never source. */
const OWNERS = new Set(["sourceWriter.ts", "daemon.ts", "projectRegistry.ts", "diagnostics.ts"]);

const SKIP = ["__tests__", "dist", "node_modules"];

////////////////////////////////
//  Tests

describe("one module writes source files", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(CORE_SRC, SKIP).length).toBeGreaterThan(10);
	});

	it("has the owner it names", () => {
		expect(sourceFiles(CORE_SRC, SKIP).map((file) => basename(file))).toContain("sourceWriter.ts");
	});

	it("has no second file writer outside the owner", () => {
		const offenders: string[] = [];

		for (const file of sourceFiles(CORE_SRC, SKIP)) {
			if (OWNERS.has(basename(file))) continue;
			const code = codeOnly(readFileSync(file, "utf8"));
			for (const call of WRITING_CALLS) {
				if (code.includes(`${call}(`)) offenders.push(`${basename(file)}: ${call}`);
			}
		}

		expect(
			offenders,
			"a source file is written through writeSourceFile in sourceWriter.ts, which owns the temp-file dance recovery depends on.",
		).toEqual([]);
	});

	// The suffix is a shared secret between the writer and the sweeper. Two spellings means a
	// half-written file that recovery walks straight past.
	it("spells the temporary suffix in one place", () => {
		const offenders = sourceFiles(CORE_SRC, SKIP)
			.filter((file) => basename(file) !== "sourceWriter.ts")
			.filter((file) => codeOnly(readFileSync(file, "utf8")).includes(TEMPORARY_SUFFIX))
			.map((file) => basename(file));

		expect(offenders, "the temp suffix belongs to sourceWriter.ts; ask it rather than retyping it.").toEqual([]);
	});
});
