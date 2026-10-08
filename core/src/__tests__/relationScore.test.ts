import { describe, expect, it } from "bun:test";
import { CoChangeIndex, type Commit } from "../history";
import { computedHealth, typeWordsOf, wordsOf } from "../relationScore";

const commit = (...files: string[]): Commit => ({
	hash: files.join("+"),
	at: 0,
	message: "",
	changes: files.map((file) => ({ path: file, added: 1, deleted: 0 })),
});

describe("relation scoring", () => {
	it("splits names into the words that say what a symbol is about", () => {
		expect(wordsOf("parseHTTPResponseBody")).toEqual(["parse", "http", "response", "body"]);
		expect(wordsOf("get_user_id")).toEqual(["user"]);
		expect(typeWordsOf("(rows: ReadonlyArray<UsageRow>, at: Date): Promise<string>")).toEqual([
			"usage",
			"row",
			"date",
		]);
	});

	it("calls one item of evidence insufficient", () => {
		const none = { holders: 0, commits: null, words: [], imports: 0, sameModule: false };
		expect(computedHealth({ ...none, words: ["duration"] })).toBe("insufficientEvidence");
		expect(computedHealth({ ...none, words: ["duration"], sameModule: true })).toBe("current");
	});
});

describe("the co-change index", () => {
	it("counts commits two files share, leaving out commits too wide to mean anything", () => {
		const index = new CoChangeIndex(
			[
				commit("a", "b"),
				commit("a", "b", "c"),
				commit("a", "c"),
				commit(...Array.from({ length: 41 }, (_, i) => `w${i}`), "a", "b"),
			],
			40,
		);
		expect(index.together("a", "b")).toBe(2);
		expect(index.outOf("a")).toBe(3);
		expect(index.partners("a", 5)).toEqual([
			{ file: "b", together: 2 },
			{ file: "c", together: 2 },
		]);
	});
});
