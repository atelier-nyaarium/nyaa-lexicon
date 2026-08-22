import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly, sourceFiles } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";

////////////////////////////////
//  Interfaces & Types

/**
 * Enforces the CLAUDE.md review rule: core must never branch on a language name.
 *
 * Bug class killed: capability variation leaking from returned values into control
 * flow. Every provider implements every method, and a missing capability answers
 * Unknown with a reason, so a language check in core means the contract is missing
 * a field. The fix is that field, never the branch.
 *
 * This exists at scaffold time on purpose: a residue test written after the first
 * violation has to argue with existing code.
 */
const CORE_SRC = join(import.meta.dirname, "..");

/**
 * `formats/` too, because it is the one other place the rule can be bent.
 *
 * A format reader is shared by several providers and takes the language as DATA. A comparison there
 * turns one reading into per-language readings, which is the second interpretation the package was
 * created to prevent.
 */
const FORMATS_SRC = join(CORE_SRC, "..", "..", "formats", "src");

const SWEPT = [CORE_SRC, FORMATS_SRC];

const SKIP = ["__tests__", "dist", "node_modules"];

/** Names a provider may be called. A comparison against any of these is the smell. */
const LANGUAGE_NAMES = [
	"typescript",
	"javascript",
	"python",
	"csharp",
	"c#",
	"gdscript",
	"godot",
	"rust",
	"golang",
	"java",
];

////////////////////////////////
//  Tests

describe("core does not branch on language", () => {
	it("finds source files in every swept directory, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
	});

	it("has no quoted language name anywhere in core or formats", () => {
		const offenders: string[] = [];

		for (const file of SWEPT.flatMap((dir) => sourceFiles(dir, SKIP))) {
			const code = codeOnly(readFileSync(file, "utf8")).toLowerCase();
			for (const name of LANGUAGE_NAMES) {
				// The NAME, not the comparison. Requiring an adjacent `===` or `case` let a branch through
				// under any other spelling: a name held in a constant, a `startsWith`, an object key. There
				// is no legitimate quoted language name here, so the string itself is the violation.
				const escaped = name.replace(/[#+.*]/g, "\\$&");
				const pattern = new RegExp(`["'\`]${escaped}["'\`]`);
				if (pattern.test(code)) offenders.push(`${file}: ${name}`);
			}
		}

		expect(
			offenders,
			"core/ and formats/ must not branch on a language name. The fix is a new field on the provider contract, never the branch. See CLAUDE.md > Mission.",
		).toEqual([]);
	});
});
