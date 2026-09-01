import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";
import { calleeOf, callsIn, lineOf, parseSource, reachedCalls } from "@nyaa-lexicon/protocol/ast";

/**
 * Holds sourceWriter.ts as the only module that writes a source file in the workspace.
 *
 * Bug class killed: three modules hand-rolled the same write-then-rename and each spelled the temp
 * suffix itself, while recovery swept for exactly that literal. Nothing failed if one drifted, so
 * the crash guarantee rested on three authors happening to agree. One owner makes them agree by
 * construction.
 */
const CORE_SRC = join(import.meta.dirname, "..");

const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);

/**
 * Every way node puts bytes on disk or moves them there.
 *
 * Matched by BINDING rather than by spelling: an alias is caught, and a same-named method on some
 * other object is not, since nothing imported it.
 */
const WRITERS = new Set([
	"writeFile",
	"writeFileSync",
	"write",
	"writeSync",
	"appendFile",
	"appendFileSync",
	"rename",
	"renameSync",
	"copyFile",
	"copyFileSync",
	"createWriteStream",
	"truncate",
	"truncateSync",
]);

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
			const text = readSwept(file);
			if (text === null) continue;
			const parsed = parseSource(file, text);
			for (const { call, name } of reachedCalls(parsed.source, FS_MODULES, WRITERS)) {
				offenders.push(`${basename(file)}:${lineOf(parsed, call)} ${name}`);
			}
			// Bun's writer arrives on a global rather than through an import.
			for (const call of callsIn(parsed.source)) {
				const callee = calleeOf(call);
				if (callee?.receiver === "Bun" && callee.name === "write") {
					offenders.push(`${basename(file)}:${lineOf(parsed, call)} Bun.write`);
				}
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
			.filter((file) => {
				const source = readSwept(file);
				return source !== null && codeOnly(source).includes(TEMPORARY_SUFFIX);
			})
			.map((file) => basename(file));

		expect(offenders, "the temp suffix belongs to sourceWriter.ts; ask it rather than retyping it.").toEqual([]);
	});
});
