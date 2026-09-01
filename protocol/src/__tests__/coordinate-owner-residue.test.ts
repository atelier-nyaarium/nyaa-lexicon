import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, lineOf, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

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

const swept = (dir: string) => sourceFiles(dir, SKIP_DIRS);

////////////////////////////////
//  Functions & Helpers

/** A newline, however it is written: `"\n"`, `'\n'`, or a regex matching one. */
function isNewline(node: ts.Node | undefined): boolean {
	if (node === undefined) return false;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === "\n";
	if (ts.isRegularExpressionLiteral(node)) return /^\/\\n\/[a-z]*$/.test(node.text);
	return false;
}

/**
 * Deriving a LINE or a CHARACTER from raw text, rather than merely splitting text into lines.
 *
 * Splitting for display is everywhere and legitimate; what is not is asking how MANY newlines came
 * before a point, or where the last one was. Those two questions are the coordinate, and the shape
 * of the answer is what is recognized here rather than the names a copy happened to use.
 */
function arithmetic(parsed: ParsedSource): Array<{ node: ts.Node; why: string }> {
	const found: Array<{ node: ts.Node; why: string }> = [];
	for (const call of callsIn(parsed.source)) {
		const callee = calleeOf(call);
		if (callee === undefined || !isNewline(call.arguments[0])) continue;
		// Where the line containing an offset begins: a character coordinate, never a display concern.
		if (callee.name === "lastIndexOf") found.push({ node: call, why: "lastIndexOf a newline" });
		// How many lines precede a point. The count is the line number; the split alone is not.
		if (
			(callee.name === "split" || callee.name === "match" || callee.name === "matchAll") &&
			ts.isPropertyAccessExpression(call.parent) &&
			call.parent.name.text === "length"
		) {
			found.push({ node: call, why: `counting newlines with ${callee.name}` });
		}
	}
	// NOT flagged, and this is the rule's known limit: `character === "\n"`. A hand-written lexer
	// advancing its own line counter is tokenizing, which docs/parsing.md rule 6 requires of it, and
	// every parser here does it. A one-off counter loop wears the same shape, so it walks past;
	// nothing here distinguishes the two, and a rule that cannot be stated is worse than a stated gap.
	return found;
}

////////////////////////////////
//  Tests

describe("one module owns text coordinates", () => {
	it("finds source files to check, so a passing run is never vacuous", () => {
		const all = PACKAGES.flatMap(swept);
		expect(all.length).toBeGreaterThan(50);
		expect(all.map((file) => basename(file))).toContain(OWNER);
	});

	// Tests are included deliberately: a fixture helper doing its own arithmetic is how three of
	// these survived the first migration, inside this very package.
	it("has nobody but the owner deriving a line or character from raw text", () => {
		const offenders: string[] = [];

		for (const file of PACKAGES.flatMap(swept)) {
			if (basename(file) === OWNER) continue;
			const text = readSwept(file);
			if (text === null) continue;
			const parsed = parseSource(file, text);
			for (const { node, why } of arithmetic(parsed)) {
				offenders.push(`${basename(file)}:${lineOf(parsed, node)} ${why}`);
			}
		}

		expect(
			offenders,
			"line and character arithmetic belongs to coordinatesOf in protocol/src/coordinates.ts. A named helper may wrap it, but must not reimplement it.",
		).toEqual([]);
	});
});
