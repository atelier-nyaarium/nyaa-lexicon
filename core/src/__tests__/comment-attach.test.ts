import { coordinatesOf, type Declaration } from "@nyaa-lexicon/protocol";
import { describe, expect, it } from "vitest";
import { attachComments } from "../commentAttach.js";

////////////////////////////////
//  Helpers

/** Every comment in the text, found by marker. The fixtures here hold no strings, so this is safe. */
function commentsIn(text: string) {
	const coordinates = coordinatesOf(text);
	const found: Array<{ range: ReturnType<typeof coordinates.rangeAt>; text: string }> = [];
	const lines = text.split("\n");
	for (const [line, content] of lines.entries()) {
		const at = content.indexOf("//");
		if (at === -1) continue;
		found.push({
			range: { start: { line, character: at }, end: { line, character: content.length } },
			text: content.slice(at),
		});
	}
	return found as Array<{
		range: { start: { line: number; character: number }; end: { line: number; character: number } };
		text: string;
	}>;
}

/** A declaration whose range starts at the code, which is the majority convention. */
function decl(name: string, startLine: number, endLine: number, nameChar = 9): Declaration {
	return {
		symbolId: `lexicon test src/a.ts ${name}`,
		name,
		kind: "function",
		visibility: "public",
		range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 1 } },
		selectionRange: {
			start: { line: startLine, character: nameChar },
			end: { line: startLine, character: nameChar + name.length },
		},
	} as Declaration;
}

const anchorName = (symbolId: string | null) => (symbolId === null ? null : symbolId.split(" ").at(-1));

////////////////////////////////
//  Tests

describe("attaching comments to what they document", () => {
	it("attaches a comment directly above a declaration", () => {
		const text = "// what work does\nfunction work() {\n}\n";
		const [found] = attachComments([decl("work", 1, 2)], commentsIn(text), text);

		expect(found?.form).toBe("leading");
		expect(found?.placement).toBe("above");
		expect(anchorName(found?.anchorId ?? null)).toBe("work");
	});

	// The other range convention: some providers already cover the doc, so start points coincide.
	it("attaches when the declaration's own range already covers the comment", () => {
		const text = "// what work does\nfunction work() {\n}\n";
		const covering = decl("work", 1, 2);
		covering.range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
		const [found] = attachComments([covering], commentsIn(text), text);

		expect(found?.form).toBe("leading");
		expect(anchorName(found?.anchorId ?? null)).toBe("work");
	});

	it("reads a run of line comments as one fact", () => {
		const text = "// refuses rather than\n// clamping the value\nfunction work() {\n}\n";
		const attached = attachComments([decl("work", 2, 3)], commentsIn(text), text);

		expect(attached).toHaveLength(1);
		expect(attached[0]?.normalized).toBe("refuses rather than clamping the value");
		expect(attached[0]?.form).toBe("leading");
	});

	it("does not join a run that changes indent", () => {
		const text = "// outer\n\t// inner\nfunction work() {\n}\n";
		expect(attachComments([decl("work", 2, 3)], commentsIn(text), text)).toHaveLength(2);
	});

	it("calls a comment after the code on its line trailing", () => {
		const text = "function work() { } // returns nothing\n";
		const [found] = attachComments([decl("work", 0, 0)], commentsIn(text), text);

		expect(found?.form).toBe("trailing");
		expect(found?.placement).toBe("after");
		expect(anchorName(found?.anchorId ?? null)).toBe("work");
	});

	// Q3, settled: a comment with blank lines both sides names neither neighbour.
	it("refuses to guess when a blank line separates it from the declaration below", () => {
		const text = "// floating\n\nfunction work() {\n}\n";
		const [found] = attachComments([decl("work", 2, 3)], commentsIn(text), text);

		expect(found?.form).toBe("standalone");
		expect(found?.anchorId).toBeNull();
	});

	it("anchors a comment in a body to the declaration that encloses it", () => {
		const text = "function work() {\n\t// why this order\n\treturn 1;\n}\n";
		const [found] = attachComments([decl("work", 0, 3)], commentsIn(text), text);

		expect(found?.form).toBe("standalone");
		expect(found?.placement).toBe("inside");
		expect(anchorName(found?.anchorId ?? null)).toBe("work");
	});

	it("leaves a file header anchored to nothing", () => {
		const text = "// Copyright someone\n\n\nfunction work() {\n}\n";
		const [found] = attachComments([decl("work", 3, 4)], commentsIn(text), text);

		expect(found?.form).toBe("standalone");
		expect(found?.anchorId).toBeNull();
	});

	// Two groups above one declaration: only the nearer one documents it.
	it("gives a declaration to the nearest group above it, not to every candidate", () => {
		const text = "// far above\n\n// directly above\nfunction work() {\n}\n";
		const attached = attachComments([decl("work", 3, 4)], commentsIn(text), text);

		const near = attached.find((item) => item.normalized === "directly above");
		const far = attached.find((item) => item.normalized === "far above");
		expect(near?.form).toBe("leading");
		expect(far?.form).toBe("standalone");
		expect(far?.anchorId).toBeNull();
	});

	it("anchors an inline comment to the symbol on its left", () => {
		const text = "function work() { } // tail\n";
		const wide = decl("work", 0, 0);
		const [found] = attachComments([wide], commentsIn(text), text);

		expect(anchorName(found?.anchorId ?? null)).toBe("work");
		expect(found?.placement).toBe("after");
	});

	it("keeps the raw text verbatim while normalizing separately", () => {
		const text = "//   spaced   out\nfunction work() {\n}\n";
		const [found] = attachComments([decl("work", 1, 2)], commentsIn(text), text);

		expect(found?.raw).toBe("//   spaced   out");
		expect(found?.normalized).toBe("spaced out");
	});

	it("reports nothing for a file with no comments", () => {
		expect(attachComments([decl("work", 0, 1)], [], "function work() {\n}\n")).toEqual([]);
	});
});
