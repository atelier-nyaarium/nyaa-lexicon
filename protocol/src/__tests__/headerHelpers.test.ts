import { describe, expect, it } from "bun:test";
import type { OffsetRange } from "../coordinates.js";
import type { HeaderSpan } from "../header.js";
import {
	blankLinesFromTrivia,
	commentsFromTrivia,
	headerRangeGroups,
	headerTriviaGroups,
	type NormalizedTrivia,
	normalizeTriviaRanges,
	rangesStartingWithin,
} from "../header.js";
import type { Range } from "../symbols.js";

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range {
	return {
		start: { line: startLine, character: startCharacter },
		end: { line: endLine, character: endCharacter },
	};
}

describe("normalized trivia", () => {
	it("projects comment adjacency from surrounding token lines", () => {
		const trivia: NormalizedTrivia[] = [
			{ kind: "token", range: range(0, 0, 0, 1), firstLine: 0, lastLine: 0 },
			{ kind: "comment", range: range(0, 2, 0, 7), firstLine: 0, lastLine: 0, text: "# first" },
			{ kind: "token", range: range(0, 8, 0, 9), firstLine: 0, lastLine: 0 },
			{ kind: "comment", range: range(1, 0, 2, 0), firstLine: 1, lastLine: 1, text: "# next" },
			{ kind: "token", range: range(2, 1, 2, 2), firstLine: 2, lastLine: 2 },
		];

		expect(commentsFromTrivia(trivia)).toEqual([
			{ range: range(0, 2, 0, 7), text: "# first", codeBefore: true, codeAfter: true },
			{ range: range(1, 0, 2, 0), text: "# next", codeBefore: false, codeAfter: true },
		]);
	});

	it("reports lines untouched by any projected token", () => {
		const trivia: NormalizedTrivia[] = [
			{ kind: "token", range: range(1, 0, 1, 1), firstLine: 1, lastLine: 1 },
			{ kind: "comment", range: range(3, 0, 3, 3), firstLine: 3, lastLine: 3, text: "# note" },
			{ kind: "token", range: range(4, 0, 4, 1), firstLine: 4, lastLine: 4 },
		];

		expect(blankLinesFromTrivia(trivia, 5)).toEqual([0, 2]);
		expect(blankLinesFromTrivia(trivia, 0)).toEqual([]);
	});
});

describe("header range groups", () => {
	it("keeps lead and declaration ranges separate", () => {
		const span: HeaderSpan = { lead: { start: 10, end: 20 }, start: 30, end: 40 };
		expect(headerRangeGroups(span)).toEqual([[{ start: 10, end: 20 }], [{ start: 30, end: 40 }]]);
		expect(headerRangeGroups({ start: 3, end: 8 })).toEqual([[{ start: 3, end: 8 }]]);
	});

	it("normalizes unordered overlapping trivia and selects starts within each piece", () => {
		const ranges: OffsetRange[] = normalizeTriviaRanges([
			{ start: 8, end: 10 },
			{ start: 2, end: 8 },
			{ start: 4, end: 6 },
			{ start: 2, end: 5 },
			{ start: 10, end: 12 },
		]);
		const span: HeaderSpan = { lead: { start: 1, end: 9 }, start: 10, end: 13 };

		expect(ranges).toEqual([
			{ start: 2, end: 8 },
			{ start: 8, end: 10 },
			{ start: 10, end: 12 },
		]);
		expect(rangesStartingWithin(ranges, { start: 8, end: 10 })).toEqual([{ start: 8, end: 10 }]);
		expect(headerTriviaGroups(ranges, span)).toEqual([
			[
				{ start: 2, end: 8 },
				{ start: 8, end: 10 },
			],
			[{ start: 10, end: 12 }],
		]);
	});
});
