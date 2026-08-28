import { describe, expect, it } from "bun:test";
import { coordinatesOf } from "@nyaa-lexicon/protocol";
import { readText } from "../text";

function read(text: string) {
	return readText({ language: "x", module: "README", text, offset: 0, coordinates: coordinatesOf(text) });
}

describe("plain text", () => {
	it("reads nonblank runs as verbatim paragraphs", () => {
		const facts = read("one\nline\n\ntwo\n");
		expect(facts.docs.map((region) => region.text)).toEqual(["one\nline", "two"]);
		expect(facts.docs.every((region) => !region.fenced)).toBe(true);
	});

	it("keeps CRLF and positions", () => {
		const facts = read("one\r\n\r\ntwo");
		expect(facts.docs.map((region) => region.text)).toEqual(["one", "two"]);
		expect(facts.docs[1]?.range.start).toEqual({ line: 2, character: 0 });
	});

	it("splits long paragraphs at line boundaries", () => {
		const text = `${"a".repeat(16 * 1024)}\nnext`;
		const facts = read(text);
		expect(facts.docs.map((region) => region.text)).toEqual(["a".repeat(16 * 1024), "next"]);
	});

	it("caps regions and reports omitted paragraphs", () => {
		const facts = read(`${"x\n\n".repeat(10_000)}last`);
		expect(facts.docs).toHaveLength(10_000);
		expect(facts.diagnostics[0]?.message).toContain("omitted 1 paragraphs");
	});
});
