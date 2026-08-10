import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces the single-owner rule for both id grammars.
 *
 * Bug class killed: a second module that builds or picks apart an id by string surgery. The moment
 * two places know the shape, they can disagree, and the failure is an id that resolves to nothing
 * while looking exactly like an answer. `symbolId.ts` and `factId.ts` own their grammar; everyone
 * else goes through the composer and the parser.
 *
 * The workspace roots are checked rather than protocol alone, because a provider minting an id by
 * template literal is the likeliest place for this to happen.
 */
const ROOTS = ["protocol", "core", "adapters", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The two files allowed to know the shape. Anything else naming a scheme is the smell. */
const OWNERS = ["symbolId.ts", "factId.ts"];

const SKIP_DIRS = new Set(["__tests__", "dist", "node_modules", ".tsbuild", "tmp"]);

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
		if (entry.endsWith(".ts") && !OWNERS.includes(entry)) found.push(full);
	}
	return found;
}

/** Comments only. A quoted scheme inside a comment is prose about the grammar, not a use of it. */
function codeOnly(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

////////////////////////////////
//  Tests

describe("nothing but the owner spells an id scheme", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		expect(sourceFiles(ROOTS[0] as string).length).toBeGreaterThan(0);
	});

	// A scheme word followed by a space inside a quote is an id being built or matched by hand.
	// The trailing space is what separates it from `SYMBOL_SCHEME` and from the package name.
	it("has no hand-built symbol or fact id anywhere outside its grammar file", () => {
		const offenders: string[] = [];
		const pattern = /["'`](lexicon|lexfact) /;

		for (const root of ROOTS) {
			for (const file of sourceFiles(root)) {
				const match = pattern.exec(codeOnly(readFileSync(file, "utf8")));
				if (match) offenders.push(`${file}: ${match[0]}`);
			}
		}

		expect(
			offenders,
			"an id must be built with composeSymbolId or composeFactId and read with its parser, never spelled by hand. See protocol/src/factId.ts.",
		).toEqual([]);
	});
});
