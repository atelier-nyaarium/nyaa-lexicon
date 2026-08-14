import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds coordinates.ts as the only module that maps an offset to a position.
 *
 * Bug class killed: twenty private converters that disagreed about what is out of bounds. One of
 * them minted a negative character, and the shared applier CLAMPED it rather than refusing, so a
 * caller's arithmetic bug became a correct-looking edit somewhere else in the file.
 *
 * The rule is DELEGATION, not naming. A helper called `rangeForText` that routes through the owner
 * is fine and there are a dozen of them; the same name doing its own line arithmetic is not. So the
 * test looks for the arithmetic, and requires any file doing it to be the owner.
 */
const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one owner. */
const OWNER = "coordinates.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

/**
 * Deriving a line or a character from raw text. Every copy this replaced started with one of these,
 * because there is no other way to build the line index by hand.
 */
const ARITHMETIC = [/\.lastIndexOf\("\\n"\)/, /\.split\("\\n"\)\.length/, /=== "\\n"\)\s*\w*\.?push\(/];

////////////////////////////////
//  Functions & Helpers

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}

	for (const entry of entries) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue;
			found.push(...sourceFiles(full));
			continue;
		}
		if (entry.endsWith(".ts")) found.push(full);
	}
	return found;
}

/** Comments only. Prose describing the rule is not breaking it. */
function codeOnly(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

////////////////////////////////
//  Tests

describe("one module owns text coordinates", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(sourceFiles);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	// Tests are included deliberately: a fixture helper doing its own arithmetic is how three of
	// these survived the first migration, inside this very package.
	it("has nobody but the owner deriving a line or character from raw text", () => {
		const offenders: string[] = [];

		for (const file of PACKAGES.flatMap(sourceFiles)) {
			if (basename(file) === OWNER) continue;
			const code = codeOnly(readFileSync(file, "utf8"));
			for (const pattern of ARITHMETIC) {
				if (pattern.test(code)) offenders.push(`${basename(file)}: ${pattern.source}`);
			}
		}

		expect(
			offenders,
			"line and character arithmetic belongs to coordinatesOf in protocol/src/coordinates.ts. A named helper may wrap it, but must not reimplement it.",
		).toEqual([]);
	});
});
