import { describe, expect, it } from "bun:test";
import type { Declaration } from "@nyaa-lexicon/protocol";
import { patternDigests } from "../patternDigest";

////////////////////////////////
//  Helpers

const TEXT = [
	"// leading",
	"function add(a, b) {",
	"  return a + b; // sum",
	"}",
	"",
	"function sub(a, b) {",
	"  return a - b;",
	"}",
].join("\n");

const range = (startLine: number, endLine: number, endChar: number) => ({
	start: { line: startLine, character: 0 },
	end: { line: endLine, character: endChar },
});

const ADD: Declaration = {
	symbolId: "lexicon ts a.ts add().",
	name: "add",
	kind: "function",
	visibility: "public",
	range: range(1, 3, 1),
	selectionRange: range(1, 1, 12),
};

const TRAILING = { range: { start: { line: 2, character: 16 }, end: { line: 2, character: 22 } }, text: "// sum" };

////////////////////////////////
//  Tests

describe("the pattern digest", () => {
	it("ignores whitespace and the comments the provider reported, and names its coverage", () => {
		const [dense] = patternDigests([ADD], [TRAILING], TEXT);
		// A different comment on its own line, and the closer two lines down.
		const spaced = TEXT.replace("return a + b; // sum", "return   a + b;\n\n  // total");
		const [loose] = patternDigests(
			[{ ...ADD, range: range(1, 5, 1) }],
			[{ range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } }, text: "// total" }],
			spaced,
		);

		expect(dense?.patternCoverage).toBe("commentsStripped");
		expect(loose?.patternDigest).toBe(dense?.patternDigest as string);
	});

	it("keeps comments in the digest, and says so, when the provider reported none", () => {
		const [kept] = patternDigests([ADD], undefined, TEXT);
		const [stripped] = patternDigests([ADD], [TRAILING], TEXT);

		expect(kept?.patternCoverage).toBe("commentsKept");
		expect(kept?.patternDigest).not.toBe(stripped?.patternDigest as string);
	});

	it("takes nothing from outside the declaration when comments straddle both of its edges", () => {
		const straddling = [
			{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 8 } }, text: "" },
			{ range: { start: { line: 3, character: 0 }, end: { line: 5, character: 0 } }, text: "" },
		];
		const [digest] = patternDigests([ADD], straddling, TEXT);
		// What is left of the declaration once both straddling spans are cut at its own edges.
		const inside = { start: { line: 1, character: 8 }, end: { line: 3, character: 0 } };
		const [expected] = patternDigests([{ ...ADD, range: inside }], [], TEXT);

		expect(digest?.patternDigest).toBe(expected?.patternDigest as string);
	});

	it("strips a comment that encloses a shorter one before the declaration, however they are ordered", () => {
		// The outer span reaches into the declaration; the inner one, later by start, ends before it.
		const outer = { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 8 } }, text: "" };
		const inner = { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } }, text: "" };
		const [nested] = patternDigests([ADD], [outer, inner], TEXT);
		const [alone] = patternDigests([ADD], [outer], TEXT);

		expect(nested?.patternDigest).toBe(alone?.patternDigest as string);
	});

	it("separates two declarations by name over identical text, and repeats itself for the same one", () => {
		const twin: Declaration = { ...ADD, symbolId: "lexicon ts a.ts sub().", name: "sub" };
		const [add, sub] = patternDigests([ADD, twin], [], TEXT);

		expect(add?.patternDigest).not.toBe(sub?.patternDigest as string);
		expect(patternDigests([ADD], [], TEXT)[0]?.patternDigest).toBe(add?.patternDigest as string);
	});
});
