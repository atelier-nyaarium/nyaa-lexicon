import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Strip comments only. String literals MUST survive: a language branch IS a
 * comparison against a quoted language name, so stripping strings would delete
 * exactly what this test looks for. Requiring the quotes in the pattern below is
 * what keeps prose ("the TypeScript provider") from matching.
 */
function codeOnly(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

////////////////////////////////
//  Tests

describe("core does not branch on language", () => {
	it("finds source files in every swept directory, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir).length, dir).toBeGreaterThan(0);
	});

	it("has no language-name comparison anywhere in core or formats", () => {
		const offenders: string[] = [];

		for (const file of SWEPT.flatMap(sourceFiles)) {
			const code = codeOnly(readFileSync(file, "utf8")).toLowerCase();
			for (const name of LANGUAGE_NAMES) {
				// A comparison, a switch case, or a keyed lookup against a QUOTED language name.
				const escaped = name.replace(/[#+.*]/g, "\\$&");
				const pattern = new RegExp(`(===?|!==?|case\\s+|\\[\\s*)\\s*["'\`]${escaped}["'\`]`);
				if (pattern.test(code)) offenders.push(`${file}: ${name}`);
			}
		}

		expect(
			offenders,
			"core/ and formats/ must not branch on a language name. The fix is a new field on the provider contract, never the branch. See CLAUDE.md > Mission.",
		).toEqual([]);
	});
});
