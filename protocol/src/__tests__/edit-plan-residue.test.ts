import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "../residue";

/**
 * Holds edits.ts as the only module deciding what a SET of edits means.
 *
 * Five copies had drifted. The rule is DELEGATION, not naming, so the sweep finds the overlap scan.
 */
const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) =>
	join(import.meta.dirname, "..", "..", "..", dir),
);

/** The one owner. */
const OWNER = "edits.ts";

/** Excluded by name, since a pattern bent to dodge itself is a weaker pattern. */
const RULE = "edit-plan-residue.test.ts";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

/** A running end offset compared against the next start. Every copy carried one. */
const OVERLAP_SWEEP = [
	/\b(?:previousEnd|lastEnd|priorEnd)\b/,
	/\bpreviousOffsets\s*\.\s*(?:start|end)\b/,
	/\.start\s*<\s*(?:previous|last|prior)\w*\b/,
];

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

////////////////////////////////
//  Tests

describe("one module owns what a set of edits means", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	it("has nobody but the owner sweeping an edit list for overlap", () => {
		const offenders: string[] = [];

		for (const file of PACKAGES.flatMap(swept)) {
			if (basename(file) === OWNER || basename(file) === RULE) continue;
			const source = readSwept(file);
			if (source === null) continue;
			const code = codeOnly(source);
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
