import { describe, expect, it } from "bun:test";
import { applyEdits, coordinatesOf, type Range, type TextEdit } from "@nyaa-lexicon/protocol";
import { type LayoutSlot, layoutModule } from "../arrangeLayout";

////////////////////////////////
//  Fixtures

/** Lines `first` through `last`, as a declaration's range spans them. */
function span(text: string, first: number, last: number): Range {
	const end = coordinatesOf(text).lineText(last)?.length ?? 0;
	return { start: { line: first, character: 0 }, end: { line: last, character: end } };
}

/** The module after the layout's edits, insertions at one point joined in landing order as a provider joins them. */
function arranged(text: string, removals: Record<string, Range>, slots: LayoutSlot[]): string {
	const layout = layoutModule(text, new Map(Object.entries(removals)), slots);
	const edits: TextEdit[] = [...layout.removals.values()].map((range) => ({ range, newText: "" }));
	const joined = new Map<string, TextEdit>();
	for (const symbolId of layout.order) {
		const insertion = layout.insertions.get(symbolId);
		if (insertion === undefined) continue;
		const key = `${insertion.position.line}:${insertion.position.character}`;
		const before = joined.get(key)?.newText ?? "";
		joined.set(key, {
			range: { start: insertion.position, end: insertion.position },
			newText: `${before}${insertion.text}`,
		});
	}
	const applied = applyEdits(text, [...edits, ...joined.values()]);
	if ("problem" in applied) throw new Error(applied.problem);
	return applied.text;
}

function member(symbolId: string): { symbolId: string; text: string } {
	return { symbolId, text: symbolId };
}

////////////////////////////////
//  Tests

describe("removals", () => {
	it("take adjacent declarations as one span with one blank separator", () => {
		const adjacent = "a\n\nZ1\nZ2\n\nb\n";
		const parted = "a\n\nZ1\n\nZ2\n\nb\n";
		expect({
			adjacent: arranged(adjacent, { Z1: span(adjacent, 2, 2), Z2: span(adjacent, 3, 3) }, []),
			parted: arranged(parted, { Z1: span(parted, 2, 2), Z2: span(parted, 4, 4) }, []),
		}).toEqual({ adjacent: "a\n\nb\n", parted: "a\n\nb\n" });
	});

	it("keep the separator between what stays, and leave no blank at either end", () => {
		const blankAbove = "a\n\nZ\nb\n";
		const blankBelow = "a\nZ\n\nb\n";
		const last = "a\n\nZ\n";
		const first = "Z\n\na\n";
		expect({
			blankAbove: arranged(blankAbove, { Z: span(blankAbove, 2, 2) }, []),
			blankBelow: arranged(blankBelow, { Z: span(blankBelow, 1, 1) }, []),
			last: arranged(last, { Z: span(last, 2, 2) }, []),
			first: arranged(first, { Z: span(first, 0, 0) }, []),
		}).toEqual({ blankAbove: "a\n\nb\n", blankBelow: "a\n\nb\n", last: "a\n", first: "a\n" });
	});

	it("take every blank line beside them when the other side keeps its own", () => {
		const middle = "a\n\n\nZ\n\n\nb\n";
		const last = "a\n\n\nZ\n";
		expect({
			middle: arranged(middle, { Z: span(middle, 3, 3) }, []),
			last: arranged(last, { Z: span(last, 3, 3) }, []),
		}).toEqual({ middle: "a\n\n\nb\n", last: "a\n" });
	});

	it("leave no blank line at the end when the last declaration had one below it", () => {
		const text = "a\n\nZ\n\n";
		expect(arranged(text, { Z: span(text, 2, 2) }, [])).toBe("a\n");
	});

	it("leave a declaration sharing its line to its own range", () => {
		const text = "a; Z;\n";
		const own = { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } };
		expect(arranged(text, { Z: own }, [])).toBe("a; \n");
	});
});

describe("insertions", () => {
	it("frame a group at one point with blank lines, in landing order", () => {
		const text = "a\n\nb\n";
		expect(arranged(text, {}, [{ landing: { line: 1 }, members: [member("P"), member("Q")] }])).toBe(
			"a\n\nP\n\nQ\n\nb\n",
		);
	});

	it("join slots at one point in slot order", () => {
		const text = "a\nb\n";
		const slots = [
			{ landing: { line: 1 }, members: [member("P")] },
			{ landing: { line: 1 }, members: [member("Q")] },
		];
		expect(arranged(text, {}, slots)).toBe("a\n\nP\n\nQ\n\nb\n");
	});

	it("land at the end of an empty, an ended and an unended module", () => {
		expect({
			empty: arranged("", {}, [{ landing: "end", members: [member("P"), member("Q")] }]),
			ended: arranged("a\n", {}, [{ landing: "end", members: [member("P")] }]),
			unended: arranged("a", {}, [{ landing: "end", members: [member("P")] }]),
		}).toEqual({ empty: "P\n\nQ\n", ended: "a\n\nP\n", unended: "a\n\nP\n" });
	});

	it("land just past a removed span where the span starts", () => {
		const text = "a\n\nZ\n\nb\n";
		expect(arranged(text, { Z: span(text, 2, 2) }, [{ landing: { line: 4 }, members: [member("P")] }])).toBe(
			"a\n\nP\n\nb\n",
		);
	});

	it("land groups on both sides of a removed span as one group", () => {
		const text = "a\nZ\nb\n";
		const slots = [
			{ landing: { line: 1 }, members: [member("P")] },
			{ landing: { line: 2 }, members: [member("Q")] },
		];
		expect(arranged(text, { Z: span(text, 1, 1) }, slots)).toBe("a\n\nP\n\nQ\n\nb\n");
	});

	it("reorder a declaration to the end", () => {
		const text = "z\n\na\n\nb\n";
		expect(arranged(text, { z: span(text, 0, 0) }, [{ landing: "end", members: [member("z")] }])).toBe(
			"a\n\nb\n\nz\n",
		);
	});

	it("write the module's own line endings", () => {
		const text = "a\r\n\r\nb\r\n";
		expect(arranged(text, {}, [{ landing: { line: 1 }, members: [{ symbolId: "P", text: "P\nQ" }] }])).toBe(
			"a\r\n\r\nP\r\nQ\r\n\r\nb\r\n",
		);
	});
});
