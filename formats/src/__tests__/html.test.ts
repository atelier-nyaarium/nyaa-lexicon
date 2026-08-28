import { describe, expect, it } from "bun:test";
import { coordinatesOf, type Range } from "@nyaa-lexicon/protocol";
import { readHtml } from "../html.js";

function read(text: string) {
	return readHtml({ language: "html", module: "a.html", text, offset: 0, coordinates: coordinatesOf(text) });
}

describe("HTML", () => {
	it("indexes one element tree and visible block prose", () => {
		const text = `<h1 id="top">Title</h1><p>before <em>middle</em> after</p>`;
		const facts = read(text);
		// A heading is named by what it says; its id is a field beneath it.
		const heading = facts.declarations.find((d) => d.kind === "heading");
		expect(heading?.name).toBe("Title");
		expect(facts.declarations.find((d) => d.kind === "field")).toMatchObject({
			name: "id",
			containerId: heading?.symbolId,
		});
		expect(facts.literals[0]).toMatchObject({ value: "top" });
		expect(facts.docs).toHaveLength(1);
		expect(facts.docs[0]).toMatchObject({ plain: "before middle after", anchorId: heading?.symbolId });
		const region = facts.docs[0];
		expect(region === undefined ? undefined : coordinatesOf(text).sliceRange(region.range)).toBe(
			"before <em>middle</em> after",
		);
	});

	it("keeps a block's own words when a nested block follows them", () => {
		const facts = read(`<div>intro <p>inner</p> outro</div>`);
		expect(facts.docs.map((doc) => doc.plain)).toEqual(["intro outro", "inner"]);
	});

	it("names a promoted element by its identity inside the quotes, and reads a bare value", () => {
		const text = `<p id="top" data-n=42>x</p>`;
		const facts = read(text);
		const element = facts.declarations.find((d) => d.kind === "property");
		expect(element?.name).toBe("top");
		expect(coordinatesOf(text).sliceRange((element as { selectionRange: Range }).selectionRange)).toBe("top");
		expect(facts.literals.map((l) => l.value)).toEqual(["top", "42"]);
		expect(coordinatesOf(text).sliceRange((facts.literals[1] as { range: Range }).range)).toBe("42");
	});

	it("handles attributes, comments, void elements, and ignored subtrees", () => {
		const text = `<div a='1' disabled><img src="x"><script>bad()</script><style>x{}</style><template><p>no</p></template><!-- yes --></div>`;
		const facts = read(text);
		expect(facts.literals.map((l) => l.value)).toEqual(["1", "x"]);
		expect(facts.comments[0]?.text).toBe("<!-- yes -->");
		expect(facts.docs).toEqual([]);
	});

	it("falls back to tags and caps oversized values and signatures", () => {
		const text = `<div d="${"x".repeat(20_000)}"></div>`;
		const facts = read(text);
		const element = facts.declarations.find((d) => d.kind === "property");
		expect(element?.name).toBe("div");
		expect(element?.signature?.length).toBeLessThan(200);
		expect(facts.literals).toEqual([]);
		expect(facts.diagnostics[0]?.message).toContain("oversized");
	});

	it("uses one heading tree, fences blocks, and handles implied end tags", () => {
		const facts = read("<h1>Title</h1><pre>code</pre><ul><li>one<li>two</ul>");
		expect(facts.declarations.find((d) => d.kind === "heading")?.name).toBe("Title");
		expect(facts.docs.map((doc) => [doc.text, doc.fenced])).toEqual([
			["code", true],
			["one", false],
			["two", false],
		]);
	});

	it("ignores bogus CDATA comments and keeps foreign SVG elements", () => {
		const facts = read('<svg><path d="M 0 0" /></svg><![CDATA[ignored]]>');
		expect(facts.declarations.map((d) => d.name)).toContain("path");
		expect(facts.comments).toEqual([]);
	});
});
