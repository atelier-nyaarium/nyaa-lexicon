import { describe, expect, it } from "bun:test";
import { coordinatesOf, type Range } from "@nyaa-lexicon/protocol";
import { readXml } from "../xml.js";

function read(text: string) {
	return readXml({ language: "xml", module: "a.xml", text, offset: 0, coordinates: coordinatesOf(text) });
}

describe("XML", () => {
	it("indexes elements, attributes, values, text, CDATA, and comments", () => {
		const text = `<root id='r' xml:lang="en"><item>one</item><item><![CDATA[two]]></item><!-- c --></root>`;
		const facts = read(text);
		expect(facts.declarations.map((d) => d.name)).toEqual(["r", "id", "xml:lang", "item", "item"]);
		expect(facts.literals.map((l) => l.value)).toEqual(["r", "en", "one", "two"]);
		expect(facts.comments[0]?.text).toBe("<!-- c -->");
		expect(facts.literals.slice(0, 2).every((l) => l.range.start.line === 0)).toBe(true);
		expect(text.slice(0, facts.declarations[1]?.range.end.character ?? 0)).toContain("id='r'");
		expect(text.slice(0, facts.literals[0]?.range.end.character ?? 0)).toContain("id='r'");
	});

	it("promotes id, then name, then key, skipping empty values", () => {
		const text = `<root><a id="" name="n" key="k"/> <b name="" key="k2"/></root>`;
		const elements = read(text).declarations.filter((d) => d.kind === "property");
		expect(elements.map((d) => d.name)).toEqual(["root", "n", "k2"]);
		// The rename span is the identity inside its quotes.
		expect(coordinatesOf(text).sliceRange((elements[1] as { selectionRange: Range }).selectionRange)).toBe("n");
	});

	it("caps a signature and names the holder of an oversized value", () => {
		const facts = read(`<root><big d="${"x".repeat(20_000)}"/><t>${"y".repeat(20_000)}</t></root>`);
		expect(facts.declarations.find((d) => d.name === "big")?.signature?.length).toBeLessThan(200);
		expect(facts.literals).toEqual([]);
		expect(facts.diagnostics.map((d) => d.message)).toEqual([
			expect.stringContaining('"d" has an oversized value'),
			expect.stringContaining('"t" has an oversized value'),
		]);
	});

	it("keeps quoted attribute ranges and CRLF coordinates", () => {
		const text = `<a b = 'x'>\r\n</a>`;
		const facts = read(text);
		const attribute = facts.declarations.find((d) => d.kind === "field");
		expect(text.slice(0, 10)).toContain("b = 'x'");
		expect(facts.literals[0]?.value).toBe("x");
		expect(attribute?.selectionRange?.start.character).toBe(3);
	});

	it("returns no facts for malformed, empty, and whitespace-only XML", () => {
		expect(read(`<a>`).declarations).toEqual([]);
		expect(read(`<a>`).diagnostics[0]?.severity).toBe("error");
		expect(read("").diagnostics).toEqual([]);
		expect(read(" \r\n ").declarations).toEqual([]);
	});

	it("skips a BOM without shifting the returned range", () => {
		const text = `\uFEFF<root>value</root>`;
		const facts = read(text);
		expect(facts.declarations[0]?.range.start.character).toBe(1);
		expect(facts.literals[0]?.range.start.character).toBe(7);
	});
});
