import { describe, expect, it } from "bun:test";
import { normalizeCommentText, normalizeDocText, proseHit } from "../proseText.js";

describe("normalizing comment prose", () => {
	it("strips a line marker and its padding", () => {
		expect(normalizeCommentText("// the cart totals")).toBe("the cart totals");
		expect(normalizeCommentText("# the cart totals")).toBe("the cart totals");
		expect(normalizeCommentText("/// the cart totals")).toBe("the cart totals");
	});

	// The whole point of normalizing: a sentence a writer wrapped is one sentence to a reader.
	it("joins a sentence wrapped across several line comments", () => {
		expect(normalizeCommentText("// refuses rather than\n// clamping the value")).toBe(
			"refuses rather than clamping the value",
		);
	});

	it("strips a block comment's delimiters and its continuation gutter", () => {
		expect(normalizeCommentText("/**\n * refuses rather than\n * clamping\n */")).toBe(
			"refuses rather than clamping",
		);
		expect(normalizeCommentText("/* one line */")).toBe("one line");
	});

	it("drops a rule used as decoration", () => {
		expect(normalizeCommentText("// ----------\n// the real prose\n// ----------")).toBe("the real prose");
	});

	it("strips a repeated marker whole rather than leaving one behind", () => {
		expect(normalizeCommentText("//// doThing()")).toBe("doThing()");
		expect(normalizeCommentText("### a hash heading")).toBe("a hash heading");
	});

	it("keeps text whose shape it does not recognize", () => {
		expect(normalizeCommentText("(* an unknown marker *)")).toBe("(* an unknown marker *)");
	});

	// A marker inside prose is prose. Only a LEADING one is punctuation.
	it("strips only the leading marker, never one inside the sentence", () => {
		expect(normalizeCommentText("// see http://example.com/path")).toBe("see http://example.com/path");
		expect(normalizeCommentText("// the # character")).toBe("the # character");
	});

	it("survives a comment that is only its marker", () => {
		expect(normalizeCommentText("//")).toBe("");
		expect(normalizeCommentText("/**/")).toBe("");
	});

	// An unterminated block still normalizes: the provider reports it, so search must reach it.
	it("normalizes a block that was never closed", () => {
		expect(normalizeCommentText("/* opened and\n * never closed")).toBe("opened and never closed");
	});

	it("collapses a carriage return like any other whitespace", () => {
		expect(normalizeCommentText("// first\r\n// second")).toBe("first second");
	});
});

describe("normalizing document prose", () => {
	it("locates case-insensitive matches across wrapped lines", () => {
		expect(proseHit("First line\r\nsecond Match", "SECOND   match")).toEqual({ line: 1, character: 0 });
		expect(proseHit("first\nwrapped phrase", "FIRST WRAPPED")).toEqual({ line: 0, character: 0 });
	});

	it("returns no position when raw text lacks the match", () => {
		expect(proseHit("raw tags", "visible text")).toBeUndefined();
	});

	// A document has no markers to strip, so anything removed here is content.
	it("collapses whitespace and strips nothing else", () => {
		expect(normalizeDocText("weigh the long-run\ncost of a workaround")).toBe(
			"weigh the long-run cost of a workaround",
		);
		expect(normalizeDocText("  padded  ")).toBe("padded");
		expect(normalizeDocText("- **No band-aids.** Weigh it")).toBe("- **No band-aids.** Weigh it");
		expect(normalizeDocText("// not a marker here")).toBe("// not a marker here");
		expect(normalizeDocText("# not a heading marker")).toBe("# not a heading marker");
	});

	it("collapses a carriage return like any other whitespace", () => {
		expect(normalizeDocText("first\r\nsecond")).toBe("first second");
	});
});
