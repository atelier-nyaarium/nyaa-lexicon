import { describe, expect, it } from "vitest";
import { coordinatesOf } from "../coordinates.js";
import { applyEdits, planEdits } from "../edits.js";

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

// The analysis five modules used to do for themselves. They had already drifted: one silently
// dropped a conflicting edit, another called an overlap a ParseError and refused the whole request.
describe("planning a set of edits", () => {
	const plan = (text: string, edits: ReturnType<typeof edit>[]) => planEdits(coordinatesOf(text), edits);

	it("keeps applicable edits in position order however they were collected", () => {
		const result = plan("add(add);\n", [edit(0, 4, 7, "sum"), edit(0, 0, 3, "sum")]);
		expect(result.conflicts).toEqual([]);
		expect(result.edits.map((e) => e.range.start.character)).toEqual([0, 4]);
	});

	it("folds an identical edit collected twice, which is not a conflict", () => {
		const result = plan("add();\n", [edit(0, 0, 3, "sum"), edit(0, 0, 3, "sum")]);
		expect(result.edits).toHaveLength(1);
		expect(result.conflicts).toEqual([]);
	});

	// The drift that mattered: TypeScript rename used to overwrite the first edit and say nothing,
	// so a rename could quietly rewrite one of two disagreeing edits and report success.
	it("reports two different texts for one span rather than picking one", () => {
		const result = plan("add();\n", [edit(0, 0, 3, "sum"), edit(0, 0, 3, "total")]);
		expect(result.conflicts.map((c) => c.conflict)).toEqual(["duplicate"]);
		expect(result.edits).toHaveLength(1);
	});

	it("reports an edit whose range does not address the text", () => {
		const result = plan("add();\n", [edit(9, 0, 3, "sum")]);
		expect(result.conflicts.map((c) => c.conflict)).toEqual(["unaddressable"]);
		expect(result.edits).toEqual([]);
	});

	it("keeps the earlier of two overlapping edits and reports the later", () => {
		const result = plan("abcdef\n", [edit(0, 0, 4, "X"), edit(0, 2, 6, "Y")]);
		expect(result.edits.map((e) => e.newText)).toEqual(["X"]);
		expect(result.conflicts.map((c) => c.conflict)).toEqual(["overlapping"]);
	});

	// Two edits that merely touch do not overlap. Off by one here silently drops a valid edit.
	it("treats abutting edits as applicable together", () => {
		const result = plan("abcdef\n", [edit(0, 0, 3, "X"), edit(0, 3, 6, "Y")]);
		expect(result.edits).toHaveLength(2);
		expect(result.conflicts).toEqual([]);
	});

	// Joining is what lets a move add two imports at one point. It is REPORTED rather than hidden,
	// because applyEdits refuses what a provider accepts and that difference has to be visible.
	it("joins different insertions at one point, in the order given, and says it did", () => {
		const result = plan("b();\n", [edit(0, 0, 0, "A\n"), edit(0, 0, 0, "B\n")]);
		expect(result.edits.map((e) => e.newText)).toEqual(["A\nB\n"]);
		expect(result.joined.map((j) => j.offset)).toEqual([0]);
		expect(result.conflicts).toEqual([]);
	});

	it("gives a joined point an edit a caller can point at", () => {
		const result = plan("b();\n", [edit(0, 0, 0, "A"), edit(0, 0, 0, "B")]);
		expect(result.joined[0]?.edit.range.start).toEqual({ line: 0, character: 0 });
	});
});
