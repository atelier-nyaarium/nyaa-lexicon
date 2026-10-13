import { describe, expect, it } from "bun:test";
import { buildRef, formatRefTarget, parseRefTarget, refSelection, selectionWithin } from "../refTargets";

describe("ref targets", () => {
	it("builds and parses names and line selections", () => {
		const built = buildRef({ module: "src/a b.ts", segments: ["Cart:Part"], lines: { start: 95, end: 89 } });
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.target).toEqual({ module: "src/a b.ts", segments: ["Cart:Part"], lines: { start: 89, end: 95 } });
		expect(parseRefTarget(built.ref)).toEqual({ ok: true, target: built.target });
	});

	it("accepts line and coordinate fragments and normalizes reversed endpoints", () => {
		expect(parseRefTarget("ref://src/a.ts#L95-L89")).toEqual({
			ok: true,
			target: {
				module: "src/a.ts",
				segments: [],
				range: { start: { line: 88, character: 0 }, end: { line: 94, character: 0 } },
			},
		});
		expect(parseRefTarget("ref://src/a.ts#L4,9-L2,2")).toEqual({
			ok: true,
			target: {
				module: "src/a.ts",
				segments: [],
				range: { start: { line: 1, character: 1 }, end: { line: 3, character: 8 } },
			},
		});
		expect(parseRefTarget("ref://src/a.ts#L89,8-L92")).toEqual({
			ok: true,
			target: {
				module: "src/a.ts",
				segments: [],
				range: { start: { line: 88, character: 7 }, end: { line: 91, character: 0 } },
			},
		});
		expect(parseRefTarget("ref://src/a.ts#L89-L92,20")).toEqual({
			ok: true,
			target: {
				module: "src/a.ts",
				segments: [],
				range: { start: { line: 88, character: 0 }, end: { line: 91, character: 19 } },
			},
		});
		expect(parseRefTarget("ref://src/a.ts#89..95")).toEqual({
			ok: true,
			target: { module: "src/a.ts", segments: [], lines: { start: 89, end: 95 } },
		});
		expect(parseRefTarget("ref://src/a.ts#L89-L95")).toEqual({
			ok: true,
			target: {
				module: "src/a.ts",
				segments: [],
				range: { start: { line: 88, character: 0 }, end: { line: 94, character: 0 } },
			},
		});
		expect(parseRefTarget("ref://src/a.ts#L89")).toEqual({
			ok: true,
			target: {
				module: "src/a.ts",
				segments: [],
				range: { start: { line: 88, character: 0 }, end: { line: 88, character: 0 } },
			},
		});
	});

	it("converts checked line selections through CRLF and preserves UTF-16 positions", () => {
		const target = parseRefTarget("ref://src/a.ts#2..3");
		if (!target.ok) throw new Error(target.problem);
		expect(refSelection(target.target, "😀x\r\nabc\r\nlast")).toEqual({
			ok: true,
			range: { start: { line: 1, character: 0 }, end: { line: 2, character: 4 } },
		});
		const caret = parseRefTarget("ref://src/a.ts#L1,3");
		if (!caret.ok) throw new Error(caret.problem);
		expect(refSelection(caret.target, "😀x")).toEqual({
			ok: true,
			range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
		});
	});

	it("rejects malformed, conflicting, overflowing, and out of bounds selections", () => {
		for (const uri of [
			"ref://a#",
			"ref://a#1..x",
			"ref://a#L0,2",
			"ref://a#1-4garbage",
			"ref://a#L9007199254740992,1",
		])
			expect(parseRefTarget(uri).ok, uri).toBe(false);
		expect(buildRef({ module: "../outside", lines: { start: 1, end: 2 } }).ok).toBe(false);
		expect(buildRef({ module: "src/\ud800.ts" }).ok).toBe(false);
		expect(
			buildRef({
				module: "src/a.ts",
				lines: { start: 1, end: 2 },
				range: { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
			}).ok,
		).toBe(false);
		const target = parseRefTarget("ref://src/a.ts#L4,1");
		if (!target.ok) throw new Error(target.problem);
		expect(refSelection(target.target, "abc").ok).toBe(false);
	});

	it("formats canonical coordinates and checks declaration bounds", () => {
		const target = {
			module: "src/a.ts",
			segments: ["A"],
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } },
		};
		expect(formatRefTarget(target)).toBe("ref://src/a.ts:A#L1,1-L2,4");
		expect(selectionWithin(target, { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } })).toBe(
			true,
		);
		expect(selectionWithin(target, { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } })).toBe(
			false,
		);
		expect(
			selectionWithin(
				{ module: "src/a.ts", segments: ["A"] },
				{ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
			),
		).toBe(true);
		expect(
			selectionWithin(
				{ module: "src/a.ts", segments: ["A"], lines: { start: 1, end: 1 } },
				{ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
			),
		).toBe(true);
	});
});
