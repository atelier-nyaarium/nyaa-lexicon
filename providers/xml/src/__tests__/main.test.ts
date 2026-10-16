import { describe, expect, it } from "bun:test";
import { SECRET_READERS } from "@nyaa-lexicon/formats/secret";
import { handlersFor, withOccurrences } from "@nyaa-lexicon/protocol";
import { TIERS, XmlProvider } from "../main.js";

describe("XML provider", () => {
	it("declares its data tiers", () => {
		expect(TIERS).toMatchObject({ declarations: true, literals: true, comments: true, docs: false });
		expect(new XmlProvider().initialize(".").content).toBe("data");
	});

	it("keeps duplicate element ids distinct", () => {
		const handler = handlersFor(new XmlProvider(), SECRET_READERS);
		const facts = handler.parseFile({ module: "a.xml", contentHash: "h", text: "<root><item/><item/></root>" });
		const settled = withOccurrences(facts);
		expect(settled.declarations.filter((d) => d.kind === "property").map((d) => d.symbolId)).toEqual([
			"lexicon xml a.xml root.",
			"lexicon xml a.xml root.item.",
			"lexicon xml a.xml root.item[2].",
		]);
	});

	it("projects optional detail away at outline depth", () => {
		const facts = new XmlProvider().parseFile({
			module: "a.xml",
			contentHash: "h",
			text: "<!-- note -->\n<root/>\n",
			depth: "outline",
		});

		expect(facts).toMatchObject({ depth: "outline", literals: [], comments: [] });
		expect(Object.hasOwn(facts, "blankLines")).toBe(false);
		expect(Object.hasOwn(facts, "docs")).toBe(false);
	});

	it("keeps the rename refusal detail", () => {
		const response = new XmlProvider().renameEdits({
			module: "a.xml",
			text: "",
			oldName: "a",
			newName: "b",
			sites: [],
		});

		expect(response).toMatchObject({
			status: "refused",
			reason: "NotImplemented",
			detail: "XML rename edits are not implemented",
		});
	});

	it("keeps an attribute and child with the same name separate", () => {
		const facts = new XmlProvider().parseFile({ module: "a.xml", contentHash: "h", text: `<a b="1"><b/></a>` });
		const settled = withOccurrences(facts);
		expect(new Set(settled.declarations.map((d) => d.symbolId)).size).toBe(settled.declarations.length);
		expect(settled.literals[0]?.containerId).toContain("a.b.");
	});
});
