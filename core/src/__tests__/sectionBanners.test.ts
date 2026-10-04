import { describe, expect, it } from "bun:test";
import { applyEdits, coordinatesOf, type Range, type StoredComment } from "@nyaa-lexicon/protocol";
import { bannerPrefixes, bannerRemovals, sectionBanners } from "../sectionBanners.js";

function comment(text: string, start: number, end: number): StoredComment {
	return {
		factId: "comment",
		module: "source.ts",
		range: coordinatesOf(text).rangeAt(start, end) as Range,
		form: "standalone",
		placement: "inside",
		raw: text.slice(start, end).trimEnd(),
		normalized: text.slice(start, end).trim(),
		anchorId: null,
	};
}

/** Each banner comment found by its first line, each declaration by `const <name>`. */
function banned(text: string, firsts: readonly string[], names: readonly string[]) {
	const comments = [comment(text, 0, text.indexOf("\n"))];
	for (const first of firsts) {
		const start = text.indexOf(first);
		const blank = text.indexOf("\n\n", start);
		comments.push(comment(text, start, blank === -1 ? text.length : blank));
	}
	const declarations = names.map((name) => {
		const start = text.indexOf(`const ${name}`);
		return { symbolId: name, range: coordinatesOf(text).rangeAt(start, start + 1) as Range };
	});
	return sectionBanners(text, comments, { scopes: new Set(), declarations });
}

const TWO = "// licence\n\n// --- First ---\n\nconst a = 1;\n\nconst b = 2;\n\n// --- Second ---\n\nconst c = 3;\n";

describe("section banners", () => {
	it("are drawn as banners, alone on their lines, after the header, each holding the declarations up to the next", () => {
		const plain = "// licence\n\n// a note\n\nconst a = 1;\n";
		const shared = "// licence\n\n/* ------ */ sideEffect();\n\nconst a = 1;\n";
		const start = shared.indexOf("/*");
		const sharedBanners = sectionBanners(
			shared,
			[comment(shared, 0, 10), comment(shared, start, shared.indexOf("*/") + 2)],
			{
				scopes: new Set(),
				declarations: [
					{
						symbolId: "a",
						range: coordinatesOf(shared).rangeAt(
							shared.indexOf("const a"),
							shared.indexOf("const a") + 1,
						) as Range,
					},
				],
			},
		);
		expect([
			banned(TWO, ["// --- First", "// --- Second"], ["a", "b", "c"]).map((banner) => banner.declarations),
			banned(plain, ["// a note"], ["a"]),
			sharedBanners,
		]).toEqual([[["a", "b"], ["c"]], [], []]);
	});

	it("go only when their whole section moves, with a blank line, and never the header", () => {
		const banners = banned(TWO, ["// --- First", "// --- Second"], ["a", "b", "c"]);
		const after = (moved: readonly string[]) => {
			const result = applyEdits(TWO, bannerRemovals(TWO, banners, new Set(moved)));
			return "problem" in result ? result.problem : result.text;
		};
		expect([after(["a"]), after(["c"])]).toEqual([
			TWO,
			"// licence\n\n// --- First ---\n\nconst a = 1;\n\nconst b = 2;\n\nconst c = 3;\n",
		]);
	});

	it("copy once per run of members from one section, in the members' order and line ending", () => {
		const banners = banned(TWO, ["// --- First", "// --- Second"], ["a", "b", "c"]);
		expect([
			[...bannerPrefixes(TWO, "\n", banners, ["a", "b", "c"])],
			[...bannerPrefixes(TWO, "\r\n", banners, ["c", "a"])],
		]).toEqual([
			[
				["a", "// --- First ---\n\n"],
				["c", "// --- Second ---\n\n"],
			],
			[
				["c", "// --- Second ---\r\n\r\n"],
				["a", "// --- First ---\r\n\r\n"],
			],
		]);
	});
});
