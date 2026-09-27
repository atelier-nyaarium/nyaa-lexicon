import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { parsedFiles, stringsIn } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

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

		for (const { file, source } of SWEPT.flatMap((dir) => parsedFiles(dir, SKIP))) {
			// Match the quoted name itself: adjacent `===` or `case` checks miss constants, `startsWith` calls or object keys.
			// No quoted language name is legitimate here.
			const quoted = new Set(
				stringsIn(source)
					.filter(({ node }) => ts.isStringLiteralLike(node))
					.map(({ text }) => text.toLowerCase()),
			);
			for (const name of LANGUAGE_NAMES) if (quoted.has(name)) offenders.push(`${file}: ${name}`);
		}

		expect(
			offenders,
			"core/ and formats/ must not branch on a language name. The fix is a new field on the provider contract, never the branch. See AGENTS.md > Mission.",
		).toEqual([]);
	});
});
