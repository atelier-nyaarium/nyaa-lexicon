import { describe, expect, it } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { code } from "../render.js";

/**
 * Asserted through a CommonMark parser, never against the generated string.
 *
 * A string assertion passes an escaper that produces Markdown nobody can read, which is exactly how
 * a backslash-escaping version survived: it looked right in source and closed its own span.
 */
function spansIn(markdown: string): string[] {
	const found: string[] = [];
	const walk = (node: { type: string; value?: string; children?: unknown[] }): void => {
		if (node.type === "inlineCode") found.push(node.value ?? "");
		for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
	};
	walk(fromMarkdown(markdown) as never);
	return found;
}

describe("code", () => {
	const roundTrips = [
		"plain",
		"src/adapters/mcp/render.ts",
		"ts sym adapters/mcp/src/render.ts code",
		"type Route = `/api/${string}`",
		"src/a`b.ts",
		"``double``",
		"`leading",
		"trailing`",
		" leading space",
		"trailing space ",
		" both ",
		"   ",
		"C:\\Users\\nyaa\\src",
		"/\\d+\\s/",
		"a*b_c[d]e",
		"pipe | inside",
		"<html>",
	];

	for (const value of roundTrips) {
		it(`survives a parser: ${JSON.stringify(value)}`, () => {
			expect(spansIn(code(value))).toEqual([value]);
		});
	}

	it("leaves a backslash alone, since a code span gives it no meaning", () => {
		expect(code("a\\b")).toBe("`a\\b`");
	});

	it("grows the fence past the longest run in the value", () => {
		expect(code("a`b")).toBe("``a`b``");
		expect(code("a``b")).toBe("```a``b```");
	});

	it("renders nothing for an empty value, which CommonMark cannot express as a span", () => {
		expect(code("")).toBe("");
	});

	it("flattens a line ending, because a span turns one into a space anyway", () => {
		expect(spansIn(code("first\nsecond"))).toEqual(["first second"]);
	});

	it("survives a value built to close its own span", () => {
		const attack = "x` and **bold** and `y";
		expect(spansIn(code(attack))).toEqual([attack]);
	});
});
