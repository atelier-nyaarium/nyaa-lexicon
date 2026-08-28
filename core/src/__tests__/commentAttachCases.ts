import { expect } from "bun:test";
import { coordinatesOf, type Declaration } from "@nyaa-lexicon/protocol";
import type { attachComments } from "../commentAttach";

////////////////////////////////
//  Interfaces & Types

type Attach = typeof attachComments;

/** One fixture with its expectations, run against whichever implementation is handed in. */
export interface AttachCase {
	name: string;
	run: (attach: Attach) => void;
}

////////////////////////////////
//  Helpers

/** Every comment in the text, found by marker. The fixtures here hold no strings, so this is safe. */
export function commentsIn(text: string) {
	const found: Array<{
		range: { start: { line: number; character: number }; end: { line: number; character: number } };
		text: string;
	}> = [];
	const coordinates = coordinatesOf(text);
	for (let line = 0; line < coordinates.lineCount(); line++) {
		const content = coordinates.lineText(line) ?? "";
		const at = content.indexOf("//");
		if (at === -1) continue;
		found.push({
			range: { start: { line, character: at }, end: { line, character: content.length } },
			text: content.slice(at),
		});
	}
	return found;
}

/** A declaration whose range starts at the code, which is the majority convention. */
export function decl(name: string, startLine: number, endLine: number, nameChar = 9): Declaration {
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

export const anchorName = (symbolId: string | null) => (symbolId === null ? null : symbolId.split(" ").at(-1));

////////////////////////////////
//  Cases

export const CASES: AttachCase[] = [
	{
		name: "attaches a comment directly above a declaration",
		run: (attach) => {
			const text = "// what work does\nfunction work() {\n}\n";
			const [found] = attach([decl("work", 1, 2)], commentsIn(text), text);
			expect(found?.form).toBe("leading");
			expect(found?.placement).toBe("above");
			expect(anchorName(found?.anchorId ?? null)).toBe("work");
		},
	},
	{
		// The other range convention: some providers already cover the doc, so start points coincide.
		name: "attaches when the declaration's own range already covers the comment",
		run: (attach) => {
			const text = "// what work does\nfunction work() {\n}\n";
			const covering = decl("work", 1, 2);
			covering.range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
			const [found] = attach([covering], commentsIn(text), text);
			expect(found?.form).toBe("leading");
			expect(anchorName(found?.anchorId ?? null)).toBe("work");
		},
	},
	{
		name: "reads a run of line comments as one fact",
		run: (attach) => {
			const text = "// refuses rather than\n// clamping the value\nfunction work() {\n}\n";
			const attached = attach([decl("work", 2, 3)], commentsIn(text), text);
			expect(attached).toHaveLength(1);
			expect(attached[0]?.normalized).toBe("refuses rather than clamping the value");
			expect(attached[0]?.form).toBe("leading");
		},
	},
	{
		// Two merged fine while three broke into a pair and a straggler. Anything past two matters.
		name: "joins a run of more than two lines into one fact",
		run: (attach) => {
			const text = "// one\n// two\n// three\n// four\nfunction work() {\n}\n";
			const attached = attach([decl("work", 4, 5)], commentsIn(text), text);
			expect(attached).toHaveLength(1);
			expect(attached[0]?.normalized).toBe("one two three four");
			expect(attached[0]?.range.end.line).toBe(3);
		},
	},
	{
		name: "joins a long run without splitting it",
		run: (attach) => {
			const lines = Array.from({ length: 40 }, (_, index) => `// line ${index}`);
			const text = `${lines.join("\n")}\nfunction work() {\n}\n`;
			const attached = attach([decl("work", 40, 41)], commentsIn(text), text);
			expect(attached).toHaveLength(1);
			expect(attached[0]?.normalized.split(" ").filter((word) => word === "line")).toHaveLength(40);
		},
	},
	{
		// A delimited comment is its own fact, so it neither joins a run nor lets one continue past it.
		name: "keeps a block comment out of a line-comment run",
		run: (attach) => {
			const text = "// one\n/* block */\n// three\nfunction work() {\n}\n";
			const spans = [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: "// one" },
				{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } }, text: "/* block */" },
				{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } }, text: "// three" },
			];
			expect(attach([decl("work", 3, 4)], spans, text).map((item) => item.normalized)).toEqual([
				"one",
				"block",
				"three",
			]);
		},
	},
	{
		name: "does not join a run that changes indent",
		run: (attach) => {
			const text = "// outer\n\t// inner\nfunction work() {\n}\n";
			expect(attach([decl("work", 2, 3)], commentsIn(text), text)).toHaveLength(2);
		},
	},
	{
		name: "calls a comment after the code on its line trailing",
		run: (attach) => {
			const text = "function work() { } // returns nothing\n";
			const [found] = attach([decl("work", 0, 0)], commentsIn(text), text);
			expect(found?.form).toBe("trailing");
			expect(found?.placement).toBe("after");
			expect(anchorName(found?.anchorId ?? null)).toBe("work");
		},
	},
	{
		// Q3, settled: a comment with blank lines both sides names neither neighbour.
		name: "refuses to guess when a blank line separates it from the declaration below",
		run: (attach) => {
			const text = "// floating\n\nfunction work() {\n}\n";
			const [found] = attach([decl("work", 2, 3)], commentsIn(text), text);
			expect(found?.form).toBe("standalone");
			expect(found?.anchorId).toBeNull();
		},
	},
	{
		// An annotation line belongs to the declaration it precedes; it is not a wall.
		name: "attaches across an annotation line between the comment and the declaration",
		run: (attach) => {
			const text = "// what work does\n@decorated\nfunction work() {\n}\n";
			const [found] = attach([decl("work", 2, 3)], commentsIn(text), text);
			expect(found?.form).toBe("leading");
			expect(anchorName(found?.anchorId ?? null)).toBe("work");
		},
	},
	{
		name: "anchors a comment in a body to the declaration that encloses it",
		run: (attach) => {
			const text = "function work() {\n\t// why this order\n\treturn 1;\n}\n";
			const [found] = attach([decl("work", 0, 3)], commentsIn(text), text);
			expect(found?.form).toBe("standalone");
			expect(found?.placement).toBe("inside");
			expect(anchorName(found?.anchorId ?? null)).toBe("work");
		},
	},
	{
		// The next declaration below is a SIBLING of the body's owner, which the comment cannot reach.
		name: "does not lead out of the body it sits in to the sibling declared below",
		run: (attach) => {
			const text = "function first() {\n\t// ends the body\n}\nfunction second() {\n}\n";
			const [found] = attach([decl("first", 0, 2), decl("second", 3, 4)], commentsIn(text), text);
			expect(found?.form).toBe("standalone");
			expect(anchorName(found?.anchorId ?? null)).toBe("first");
		},
	},
	{
		name: "leaves a file header anchored to nothing",
		run: (attach) => {
			const text = "// Copyright someone\n\n\nfunction work() {\n}\n";
			const [found] = attach([decl("work", 3, 4)], commentsIn(text), text);
			expect(found?.form).toBe("standalone");
			expect(found?.anchorId).toBeNull();
		},
	},
	{
		// Two groups above one declaration: only the nearer one documents it.
		name: "gives a declaration to the nearest group above it, not to every candidate",
		run: (attach) => {
			const text = "// far above\n\n// directly above\nfunction work() {\n}\n";
			const attached = attach([decl("work", 3, 4)], commentsIn(text), text);
			const near = attached.find((item) => item.normalized === "directly above");
			const far = attached.find((item) => item.normalized === "far above");
			expect(near?.form).toBe("leading");
			expect(far?.form).toBe("standalone");
			expect(far?.anchorId).toBeNull();
		},
	},
	{
		name: "anchors a same-line comment to the symbol on its left",
		run: (attach) => {
			const text = "function work() { } // tail\n";
			const [found] = attach([decl("work", 0, 0)], commentsIn(text), text);
			expect(anchorName(found?.anchorId ?? null)).toBe("work");
			expect(found?.placement).toBe("after");
		},
	},
	{
		// Embedded rather than trailing: something follows it on the line, so it is not the tail.
		name: "calls a comment with code after it on its line inline",
		run: (attach) => {
			const text = "function work() { } // tail\n";
			const spans = commentsIn(text).map((item) => ({
				range: { start: item.range.start, end: { line: 0, character: 22 } },
				text: "// tai",
			}));
			const [found] = attach([decl("work", 0, 0)], spans, text);
			expect(found?.form).toBe("inline");
			expect(found?.placement).toBe("after");
		},
	},
	{
		// A comment its anchor sits AFTER cannot be trailing, whichever direction the name suggests.
		name: "calls a comment that precedes its only same-line symbol inline, not trailing",
		run: (attach) => {
			const text = "x; // note\nfunction work() { }\n";
			const [found] = attach([decl("work", 0, 0, 20)], commentsIn(text), text);
			expect(found?.form).toBe("inline");
			expect(found?.placement).toBe("before");
		},
	},
	{
		// A declaration with no name in the source is on no line, so it never takes a same-line comment.
		name: "anchors a same-line comment to nothing when the only symbol there has no name span",
		run: (attach) => {
			const text = "extends Node // the whole script\n";
			const { selectionRange: _span, ...unnamed } = decl("player", 0, 0);
			const script = { ...unnamed, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 32 } } };
			const [found] = attach([script], commentsIn(text), text);
			expect(found?.form).toBe("standalone");
			expect(anchorName(found?.anchorId ?? null)).toBe("player");
		},
	},
	{
		name: "keeps the raw text verbatim while normalizing separately",
		run: (attach) => {
			const text = "//   spaced   out\nfunction work() {\n}\n";
			const [found] = attach([decl("work", 1, 2)], commentsIn(text), text);
			expect(found?.raw).toBe("//   spaced   out");
			expect(found?.normalized).toBe("spaced out");
		},
	},
	{
		name: "reports nothing for a file with no comments",
		run: (attach) => {
			expect(attach([decl("work", 0, 1)], [], "function work() {\n}\n")).toEqual([]);
		},
	},
];
