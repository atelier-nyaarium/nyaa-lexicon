import { describe, expect, it } from "vitest";
import { applyEdits } from "../edits.js";

////////////////////////////////
//  Helpers

function edit(line: number, from: number, to: number, newText: string) {
	return { range: { start: { line, character: from }, end: { line, character: to } }, newText };
}

////////////////////////////////
//  Tests

describe("applying edits to one file", () => {
	it("replaces a span", () => {
		expect(applyEdits("const add = 1;\n", [edit(0, 6, 9, "sum")])).toEqual({ text: "const sum = 1;\n" });
	});

	// Applying in reading order corrupts everything after the first replacement of a different
	// width, since that one shifts every later coordinate.
	it("applies several edits without letting earlier ones shift later ones", () => {
		const text = "add(add, add);\n";
		const result = applyEdits(text, [edit(0, 0, 3, "sum"), edit(0, 4, 7, "total"), edit(0, 9, 12, "x")]);

		expect(result).toEqual({ text: "sum(total, x);\n" });
	});

	it("gives the same answer whatever order the provider returned them in", () => {
		const text = "add(add, add);\n";
		const forwards = [edit(0, 0, 3, "sum"), edit(0, 4, 7, "total"), edit(0, 9, 12, "x")];

		expect(applyEdits(text, [...forwards].reverse())).toEqual(applyEdits(text, forwards));
	});

	it("spans lines", () => {
		const result = applyEdits("a\nbb\nccc\n", [edit(1, 0, 2, "X"), edit(2, 1, 3, "Y")]);
		expect(result).toEqual({ text: "a\nX\ncY\n" });
	});

	// Two edits claiming the same characters is a provider bug. Picking a winner would turn a
	// detectable fault into a silently wrong file.
	it("refuses overlapping edits rather than choosing between them", () => {
		const result = applyEdits("const add = 1;\n", [edit(0, 6, 9, "sum"), edit(0, 8, 11, "x")]);
		expect(result).toEqual({ problem: "two edits overlap, so the result would depend on order" });
	});

	it("refuses an edit past the end of the file", () => {
		expect(applyEdits("a\n", [edit(9, 0, 1, "x")])).toMatchObject({
			problem: expect.stringContaining("does not address text"),
		});
	});

	// It used to CLAMP these. A character past the line silently moved the edit to the end of the
	// file, and a negative one to the end of its line, so a caller's arithmetic bug became a
	// correct-looking edit somewhere else entirely.
	it("refuses a character past the end of its line rather than moving the edit", () => {
		expect(applyEdits("ab\ncd\n", [edit(0, 99, 99, "X")])).toMatchObject({
			problem: expect.stringContaining("does not address text"),
		});
	});

	it("refuses a negative character rather than moving the edit", () => {
		expect(applyEdits("ab\n", [edit(0, -1, -1, "N")])).toMatchObject({
			problem: expect.stringContaining("does not address text"),
		});
	});

	// The order-independence promised above was not true for these: Array.sort is stable, so two
	// insertions at one point came out in whatever order the caller collected them.
	it("refuses two different insertions at one point, whose order would decide the file", () => {
		const both = [edit(0, 0, 0, "A"), edit(0, 0, 0, "B")];

		expect(applyEdits("x\n", both)).toMatchObject({ problem: expect.stringContaining("share one point") });
		expect(applyEdits("x\n", [...both].reverse())).toMatchObject({
			problem: expect.stringContaining("share one point"),
		});
	});

	it("accepts the same insertion twice, since the answer cannot depend on their order", () => {
		expect(applyEdits("x\n", [edit(0, 0, 0, "A"), edit(0, 0, 0, "A")])).toEqual({ text: "Ax\n" });
	});

	// An insertion is a zero-width edit, which is how move adds an import without touching the
	// line it sits above.
	it("inserts at a zero-width range", () => {
		expect(applyEdits("b();\n", [edit(0, 0, 0, 'import { b } from "./b";\n')])).toEqual({
			text: 'import { b } from "./b";\nb();\n',
		});
	});
});
