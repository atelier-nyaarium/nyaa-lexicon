import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

/**
 * Core never branches on a language name: a missing capability answers Unknown with a reason, so
 * a language check means the provider contract lacks a field, and the fix is that field.
 */
const CORE_SRC = join(import.meta.dirname, "..");

/** A format reader takes the language as DATA; a comparison there makes one reading several. */
const FORMATS_SRC = join(CORE_SRC, "..", "..", "formats", "src");

/** The client resolves chains over every provider's declarations, so the rule holds there too. */
const CLIENT_SRC = join(CORE_SRC, "..", "..", "client", "src");

const SWEPT = [CORE_SRC, FORMATS_SRC, CLIENT_SRC];

const SKIP = ["__tests__", "dist", "node_modules"];

/** Names a provider may be called. A comparison against any of these is the smell. */
const LANGUAGE_NAMES = [
	"typescript",
	"javascript",
	"python",
	"csharp",
	"c#",
	"c",
	"cpp",
	"c++",
	"gdscript",
	"godot",
	"rust",
	"golang",
	"java",
	"kotlin",
	"markdown",
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
			const source = readSwept(file);
			if (source === null) continue;
			const code = codeOnly(source).toLowerCase();
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
			"core/ and formats/ must not branch on a language name. The fix is a new field on the provider contract, never the branch. See AGENTS.md > Mission.",
		).toEqual([]);
	});
});
