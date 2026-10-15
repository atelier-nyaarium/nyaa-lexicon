import { describe, expect, test } from "bun:test";
import { resolveConditionalGroups } from "../conditionalGroups.js";

describe("resolveConditionalGroups", () => {
	test("keeps balanced branches except an initial zero branch", () => {
		const directives = [
			{ start: 0, end: 1, keyword: "if" },
			{ start: 3, end: 4, keyword: "elif" },
			{ start: 6, end: 7, keyword: "else" },
			{ start: 9, end: 10, keyword: "endif" },
		];
		const result = resolveConditionalGroups({
			directives,
			tokenCount: 11,
			directiveTokens: new Set([0, 3, 6, 9]),
			firstConditionIsZero: () => true,
			delimiterAt: () => "",
		});

		expect(result.groups[0]?.keptBranches).toEqual([1, 2]);
		expect(result.removedBranches).toEqual([{ start: 1, end: 3 }]);
	});

	test("selects a branch when the alternatives leave different delimiters", () => {
		const result = resolveConditionalGroups({
			directives: [
				{ start: 0, end: 1, keyword: "if" },
				{ start: 3, end: 4, keyword: "else" },
				{ start: 6, end: 7, keyword: "endif" },
			],
			tokenCount: 8,
			directiveTokens: new Set([0, 3, 6]),
			firstConditionIsZero: () => false,
			delimiterAt: (index) => (index === 1 ? "(" : index === 4 ? ")" : ""),
		});

		expect(result.groups[0]?.residue).toEqual(["("]);
		expect(result.groups[0]?.keptBranches).toEqual([0]);
		expect(result.removedBranches).toEqual([{ start: 4, end: 6 }]);
	});

	test("reports stray branches and ends and leaves unclosed groups unresolved", () => {
		const result = resolveConditionalGroups({
			directives: [
				{ start: 0, end: 1, keyword: "else" },
				{ start: 2, end: 3, keyword: "endif" },
				{ start: 4, end: 5, keyword: "if" },
			],
			tokenCount: 6,
			directiveTokens: new Set([0, 2, 4]),
			firstConditionIsZero: () => false,
			delimiterAt: () => "",
		});

		expect(result.issues.map((issue) => issue.kind)).toEqual(["unexpected-branch", "unexpected-end", "unclosed"]);
		expect(result.removedBranches).toEqual([]);
	});
});
