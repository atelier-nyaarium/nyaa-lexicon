import { describe, expect, it } from "vitest";
import { isTooDeep, MAX_NESTING, markupTooDeep, nestedTooDeep } from "../depth.js";

describe("bounding nesting before a parser recurses", () => {
	const json = { line: ["//"], block: ["/*", "*/"] as [string, string] };
	const yaml = { line: ["#"] };

	it("allows the limit and refuses one past it", () => {
		expect(nestedTooDeep("[".repeat(MAX_NESTING), json)).toBe(false);
		expect(nestedTooDeep("[".repeat(MAX_NESTING + 1), json)).toBe(true);
		expect(nestedTooDeep(`{"a": ${"[".repeat(MAX_NESTING)}1${"]".repeat(MAX_NESTING)}}`, json)).toBe(true);
	});

	it("counts neither a bracket inside a string nor one inside a comment", () => {
		const inStrings = `["${"[".repeat(MAX_NESTING * 2)}", '${"{".repeat(MAX_NESTING * 2)}']`;
		expect(nestedTooDeep(inStrings, json)).toBe(false);
		const inComments = `${"// [[[[\n".repeat(MAX_NESTING)}/* ${"{".repeat(MAX_NESTING * 2)} */ [1]`;
		expect(nestedTooDeep(inComments, json)).toBe(false);
		expect(nestedTooDeep(`${"# [[[[\n".repeat(MAX_NESTING)}a: [1]`, yaml)).toBe(false);
	});

	it("reads a single-quoted string the YAML way: doubled quotes escape, backslashes do not", () => {
		const deep = "[".repeat(MAX_NESTING + 1);
		expect(nestedTooDeep(`key: 'it''s [' ${deep}`, yaml)).toBe(true);
		expect(nestedTooDeep(`key: 'it''s ${"[".repeat(MAX_NESTING * 2)}'`, yaml)).toBe(false);
		expect(nestedTooDeep(`key: 'a\\' ${deep}`, yaml)).toBe(true);
	});

	it("survives an escaped quote, an unclosed comment, and stray closers", () => {
		expect(nestedTooDeep(`["a\\"b", ${"[".repeat(MAX_NESTING + 1)}]`, json)).toBe(true);
		expect(nestedTooDeep(`/* ${"[".repeat(MAX_NESTING * 2)}`, json)).toBe(false);
		expect(nestedTooDeep(`${"]".repeat(MAX_NESTING * 2)}${"[".repeat(MAX_NESTING)}`, json)).toBe(false);
	});
});

describe("recognizing a recursion limit", () => {
	it("counts markup tags and skips raw text", () => {
		expect(markupTooDeep("<a>".repeat(MAX_NESTING), MAX_NESTING)).toBe(false);
		expect(markupTooDeep("<a>".repeat(MAX_NESTING + 1), MAX_NESTING)).toBe(true);
		expect(markupTooDeep(`<script>${"<a>".repeat(MAX_NESTING + 1)}</script>`, MAX_NESTING, ["script"])).toBe(false);
	});

	it("accepts the stack exhaustion a deep structure produces", () => {
		function forever(n: number): number {
			return forever(n + 1);
		}
		let caught: unknown;
		try {
			forever(0);
		} catch (failure) {
			caught = failure;
		}
		expect(isTooDeep(caught)).toBe(true);
	});

	it("refuses another RangeError, so a real bug is not reported as depth", () => {
		let caught: unknown;
		try {
			new Array(-1);
		} catch (failure) {
			caught = failure;
		}
		expect(caught).toBeInstanceOf(RangeError);
		expect(isTooDeep(caught)).toBe(false);
	});

	it("refuses anything that is not a RangeError", () => {
		expect(isTooDeep(new TypeError("call stack"))).toBe(false);
		expect(isTooDeep(undefined)).toBe(false);
	});
});
