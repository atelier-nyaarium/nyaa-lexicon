import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Holds edits.ts as the only module that decides what a SET of edits means.
 *
 * Bug class killed: five private copies of the same analysis, in the four provider modules that
 * rewrite text and in the applier. They had already drifted. TypeScript rename silently overwrote
 * one of two disagreeing edits for the same span and reported success; GDScript rename refused the
 * whole request on an overlap and called it a ParseError, which it is not.
 *
 * The rule is DELEGATION, not naming. A `validateEdits` that routes through planEdits is fine and
 * there are five of them; the same name doing its own overlap sweep is not. So the test looks for
 * the sweep, and requires any file doing it to be the owner.
 */
const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one owner. */
const OWNER = "edits.ts";

/**
 * This file, which names the forbidden idioms in its own patterns. Excluded by name rather than by
 * making the patterns dodge themselves, since a rule bent to avoid matching itself is a weaker rule.
 */
const RULE = "edit-plan-residue.test.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

/**
 * Sweeping a sorted edit list for overlap. Every copy this replaced carried a running end offset
 * and compared the next start against it, because there is no other way to do it in one pass.
 */
const OVERLAP_SWEEP = [
	/\b(?:previousEnd|lastEnd|priorEnd)\b/,
	/\bpreviousOffsets\s*\.\s*(?:start|end)\b/,
	/\.start\s*<\s*(?:previous|last|prior)\w*\b/,
];

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

describe("one module owns what a set of edits means", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(sourceFiles);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	it("has nobody but the owner sweeping an edit list for overlap", () => {
		const offenders: string[] = [];

		for (const file of PACKAGES.flatMap(sourceFiles)) {
			if (basename(file) === OWNER || basename(file) === RULE) continue;
			const code = codeOnly(readFileSync(file, "utf8"));
			for (const pattern of OVERLAP_SWEEP) {
				if (pattern.test(code)) offenders.push(`${basename(file)}: ${pattern.source}`);
			}
		}

		expect(
			offenders,
			"deciding which edits can travel together belongs to planEdits in protocol/src/edits.ts. A provider maps its findings into its own vocabulary; it does not redo the analysis.",
		).toEqual([]);
	});
});
