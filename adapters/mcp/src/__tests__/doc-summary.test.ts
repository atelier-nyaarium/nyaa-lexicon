import { describe, expect, it } from "bun:test";
import type { DescribeResult } from "@nyaa-lexicon/core";
import { renderDescribe } from "../render.js";

////////////////////////////////
//  Helpers

function described(docComment: string): DescribeResult {
	return {
		symbol: {
			symbolId: "lexicon ts src/a.ts work",
			name: "work",
			kind: "function",
			module: "src/a.ts",
			visibility: "public",
			exported: true,
			docComment,
		},
		members: [],
		referenceCount: 0,
		graph: { symbolId: "lexicon ts src/a.ts work", fanIn: 0, fanOut: 0 },
		hierarchy: {
			symbolId: "lexicon ts src/a.ts work",
			supertypes: [],
			subtypes: [],
			ancestors: [],
			unboundSupertypes: [],
		},
		tier: "bound",
	} as DescribeResult;
}

const documentation = (rendered: string) => rendered.split("## Documentation")[1]?.split("##")[0]?.trim() ?? "";

////////////////////////////////
//  Tests

// Documentation is normalized to a single line, so there is no line break left to cut at. Without
// a sentence cut, describe prints an entire multi-paragraph comment to a caller paying per token.
describe("documentation in describe stays a summary", () => {
	it("prints a short doc whole", () => {
		expect(documentation(renderDescribe(described("Does the thing.")))).toBe("Does the thing.");
	});

	it("cuts a multi-sentence doc after its first sentence and says it continued", () => {
		const rendered = renderDescribe(
			described("Refuses rather than clamping. The rest is detail nobody asked for."),
		);

		expect(documentation(rendered)).toBe("Refuses rather than clamping. ...");
	});

	it("adds no ellipsis to a one-sentence doc that ends in a period", () => {
		expect(documentation(renderDescribe(described("Refuses rather than clamping.")))).toBe(
			"Refuses rather than clamping.",
		);
	});

	it("cuts a long unpunctuated doc at a word boundary and says it continued", () => {
		const long = `${"word ".repeat(120).trim()}`;
		const shown = documentation(renderDescribe(described(long)));

		expect(shown.length).toBeLessThan(230);
		expect(shown.endsWith(" ...")).toBe(true);
		expect(long.startsWith(shown.slice(0, -4))).toBe(true);
	});
});
