import { describe, expect, it } from "bun:test";
import { type NoteOpening, noteOpening } from "../noteText";

describe("how a note opens", () => {
	it("names the block a note opens with, and a paragraph only when one comes first", () => {
		const openings: Array<[string, NoteOpening["kind"]]> = [
			["", "empty"],
			["# Cart", "heading"],
			["Cart\n----\n\nHolds items.", "heading"],
			["- one\n- two", "list"],
			["2) second", "list"],
			["> quoted", "quote"],
			["```mermaid\ngraph LR\n```", "code"],
			["    indented code", "code"],
			["* * *", "rule"],
			["<div>\nInternal\n</div>", "html"],
			["[more]: https://example.test\n\nSee [more][more].", "definition"],
			["\n\nHolds items.", "paragraph"],
			["Costs 3 - 2 items.", "paragraph"],
			["``` aa ```\nfoo", "paragraph"],
		];
		expect(openings.map(([text]) => noteOpening(text).kind)).toEqual(openings.map(([, kind]) => kind));
	});

	it("reads the opening paragraph as one line, and where the rest starts", () => {
		const text = "Holds the items\nof one checkout.\n\n## Why\n\nShoppers.";
		const opening = noteOpening(text);
		expect(opening).toMatchObject({ kind: "paragraph", summary: "Holds the items of one checkout." });
		expect(opening.kind === "paragraph" && text.slice(opening.restAt).trim()).toBe("## Why\n\nShoppers.");

		const cases: Array<[string, string, string]> = [
			["Holds items.\n# Why\nShoppers.", "Holds items.", "# Why\nShoppers."],
			["Costs:\n- one cart", "Costs:", "- one cart"],
			["A cache is shared\n2. after retries.", "A cache is shared 2. after retries.", ""],
			["Wraps a [Cart](ref://src/a.ts:Cart).\r\n\r\nMore.", "Wraps a [Cart](ref://src/a.ts:Cart).", "More."],
			[`${String.fromCharCode(0xfeff)}Holds items.\r\n\r\nMore.`, "Holds items.", "More."],
		];
		for (const [written, summary, rest] of cases) {
			const read = noteOpening(written);
			expect(read.kind === "paragraph" ? [read.summary, written.slice(read.restAt).trim()] : read.kind).toEqual([
				summary,
				rest,
			]);
		}
	});

	it("reads a crafted emphasis run at the size cap in well under a second", () => {
		const started = performance.now();
		noteOpening(`${"*".repeat(7999)}x${"*".repeat(8000)}`);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
