import { describe, expect, it } from "vitest";
import { HtmlProvider, TIERS } from "../main.js";

describe("HTML provider", () => {
	it("declares document tiers", () => {
		expect(TIERS).toMatchObject({ declarations: true, literals: true, comments: true, docs: true });
		expect(new HtmlProvider().initialize(".").content).toBe("document");
	});

	it("parses a page fully, and outlines it without its prose or values", () => {
		const provider = new HtmlProvider();
		const text = `<h1>Title</h1><p id="p1">words</p>`;
		const full = provider.parseFile({ module: "a.html", contentHash: "h", text });
		expect(full.declarations.map((d) => [d.name, d.kind])).toEqual([
			["Title", "heading"],
			["p1", "property"],
			["id", "field"],
		]);
		expect(full.docs.map((doc) => doc.plain)).toEqual(["words"]);
		expect(full.literals.map((l) => l.value)).toEqual(["p1"]);
		const outline = provider.parseFile({ module: "a.html", contentHash: "h", text, depth: "outline" });
		expect(outline).toMatchObject({ depth: "outline", docs: [], literals: [] });
		expect(outline.declarations).toHaveLength(3);
	});
});
