import { describe, expect, it } from "bun:test";
import type { CommentsResult, LiteralsResult } from "@nyaa-lexicon/core";
import { renderComments, renderLiterals } from "../render.js";

// A stopped scan owes its caller a sentence, and the place it was easiest to drop is the place it
// matters most: an empty result. "Nothing matched" and "nothing matched in the part I read" are
// different answers, and only one of them is an absence.
describe("a scan that stopped early says so", () => {
	const noComments = (scanIncomplete: boolean): CommentsResult => ({
		query: { regex: "/x/" },
		comments: [],
		total: 0,
		truncated: false,
		count: scanIncomplete ? { kind: "atLeast", count: 0, reason: "scanCapped" } : { kind: "exact", count: 0 },
		...(scanIncomplete ? { scanIncomplete: true } : {}),
	});

	const noLiterals = (scanIncomplete: boolean): LiteralsResult => ({
		query: { regex: "/x/" },
		literals: [],
		total: 0,
		truncated: false,
		count: scanIncomplete ? { kind: "atLeast", count: 0, reason: "scanCapped" } : { kind: "exact", count: 0 },
		...(scanIncomplete ? { scanIncomplete: true } : {}),
	});

	it("warns on an empty comment search that never finished", () => {
		expect(renderComments(noComments(true))).toContain("stopped before the end of the index");
	});

	it("stays quiet on an empty comment search that did finish", () => {
		expect(renderComments(noComments(false))).not.toContain("stopped before the end");
	});

	it("warns on an empty literal search that never finished", () => {
		expect(renderLiterals(noLiterals(true))).toContain("stopped before the end of the index");
	});

	it("stays quiet on an empty literal search that did finish", () => {
		expect(renderLiterals(noLiterals(false))).not.toContain("stopped before the end");
	});
});

describe("comment citations", () => {
	it("prints each comment fact id", () => {
		const result: CommentsResult = {
			query: { text: "retains" },
			comments: [
				{
					factId: "lexfact comment a.ref 0123456789abcdef",
					module: "a.ref",
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
					form: "leading",
					placement: "above",
					raw: "// retains checkout state",
					anchor: null,
				},
			],
			total: 1,
			truncated: false,
			count: { kind: "exact", count: 1 },
		};

		expect(renderComments(result)).toContain("`lexfact comment a.ref 0123456789abcdef`");
	});
});
