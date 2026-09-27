import { describe, expect, it } from "bun:test";
import { TOO_DEEP } from "@nyaa-lexicon/protocol";
import { parseXmlDocument } from "../xml/parser.js";
import type { XmlContent, XmlDocument, XmlElement } from "../xml/syntax.js";

function parsed(text: string): XmlDocument {
	const result = parseXmlDocument(text);
	if (result.problem !== undefined) throw new Error(`${result.problem.message} at ${result.problem.pos}`);
	return result.document;
}

function elements(document: XmlDocument): XmlElement[] {
	const found: XmlElement[] = [];
	const pending: XmlContent[] = [document.root];
	while (pending.length > 0) {
		const node = pending.pop() as XmlContent;
		if (node.type !== "element") continue;
		found.push(node);
		pending.push(...node.children);
	}
	return found;
}

describe("XML parser", () => {
	it("spans every node and places a token for everything but white space", () => {
		const text = [
			'<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
			"<!DOCTYPE r [",
			'  <!ATTLIST r x CDATA "a>b">',
			"  <!-- in the subset -->",
			"]>",
			"<?pi data?><r  a = \"1\" b='two'>",
			"  text &amp; more<![CDATA[<raw>]]><e/><!-- c --></r >",
			"",
		].join("\n");
		const document = parsed(text);
		let at = 0;
		for (const token of document.tokens) {
			expect(text.slice(at, token.pos).trim()).toBe("");
			at = token.end;
		}
		expect(text.slice(at).trim()).toBe("");
		expect(
			document.tokens.filter((token) => token.kind === "comment").map((t) => text.slice(t.pos, t.end)),
		).toEqual(["<!-- in the subset -->", "<!-- c -->"]);
		const [root, empty] = elements(document);
		expect(text.slice(root?.pos, root?.end)).toStartWith("<r  a");
		expect(text.slice(root?.endTagPos, root?.end)).toBe("</r >");
		expect(text.slice(empty?.pos, empty?.end)).toBe("<e/>");
		expect(root?.attributes.map((a) => [text.slice(a.pos, a.nameEnd), text.slice(a.valuePos, a.end)])).toEqual([
			["a", '"1"'],
			["b", "'two'"],
		]);
		expect(root?.children.map((child) => child.type)).toEqual(["text", "cdata", "element", "comment"]);
	});

	it("normalizes line breaks in text and white space in values, and replaces references", () => {
		const root = parsed('<a b="x\r\n\ty &amp; &#x41;&#10;">l1\r\nl2\r&lt; &#65;</a>').root;
		expect(root.attributes[0]?.value).toBe("x  y & A\n");
		expect(root.children[0]).toMatchObject({ type: "text", text: "l1\nl2\n< A" });
	});

	it("replaces declared entities, and keeps as written what it cannot place", () => {
		const subset = [
			'<!ENTITY inner "x">',
			'<!ENTITY outer "one &inner; two">',
			'<!ENTITY markup "<b/>">',
			'<!ENTITY file SYSTEM "file.txt">',
		].join("");
		const root = parsed(`<!DOCTYPE a [${subset}]><a v="&outer;">&outer;|&markup;|&file;</a>`).root;
		expect(root.attributes[0]?.value).toBe("one x two");
		expect(root.children[0]).toMatchObject({ text: "one x two|&markup;|&file;" });
		// An external subset may declare what the text does not.
		expect(parsed('<!DOCTYPE a SYSTEM "a.dtd"><a>&nbsp;</a>').root.children[0]).toMatchObject({ text: "&nbsp;" });
	});

	it("expands entity chains under the nesting limit, and reports a failure inside one at its reference", () => {
		const chain = (length: number) => {
			const declarations = Array.from({ length }, (_, index) =>
				index === length - 1 ? `<!ENTITY e${index} "x">` : `<!ENTITY e${index} "&e${index + 1};">`,
			);
			return `<!DOCTYPE r [${declarations.join("")}]><r>&e0;</r>`;
		};
		expect(parsed(chain(50)).root.children[0]).toMatchObject({ text: "x" });
		expect(parseXmlDocument(chain(5000)).problem?.message).toBe(TOO_DEEP);
		const text = '<!DOCTYPE r [<!ENTITY x "&missing;">]><r>&x;</r>';
		expect(parseXmlDocument(text).problem?.pos).toBe(text.indexOf("&x;"));
		expect(parseXmlDocument('<!DOCTYPE r [<!ENTITY e "]]>">]><r>&e;</r>').problem).toBeDefined();
	});

	it("refuses an expansion that writes far more text than the document holds", () => {
		const levels = Array.from({ length: 10 }, (_, index) =>
			index === 0 ? '<!ENTITY e0 "xxxxxxxxxx">' : `<!ENTITY e${index} "${`&e${index - 1};`.repeat(10)}">`,
		);
		const bomb = `<!DOCTYPE r [${levels.join("")}]><r>&e9;</r>`;
		expect(parseXmlDocument(bomb).problem?.pos).toBe(bomb.indexOf("&e9;"));
		expect(parsed(bomb.replace("&e9;", "&e4;")).root.children[0]).toMatchObject({ text: "x".repeat(100_000) });
	});

	it("reads declarations after an unread parameter entity only in a standalone document", () => {
		const subset = '<!DOCTYPE r [<!ENTITY % p "">%p;<!ENTITY e "ok">]>';
		expect(parsed(`<?xml version="1.0" standalone="yes"?>${subset}<r>&e;</r>`).root.children[0]).toMatchObject({
			text: "ok",
		});
		expect(parsed(`${subset}<r>&e;</r>`).root.children[0]).toMatchObject({ text: "&e;" });
	});

	it("accepts what XML 1.0 allows", () => {
		for (const text of [
			"<a/>",
			'<?xml-stylesheet href="s.css"?><a/>',
			"<a b = '1' />",
			"<a>]] ]></a>",
			"<a><!-- - --></a>",
			"<a:b xmlns:a='u'><a:c/></a:b>",
			"<a>&#x1F600;</a>",
			'<!DOCTYPE a PUBLIC "-//X//Y" "y.dtd"><a/>',
			'<?xml version="1.1"?><a/>',
			"<a>&#00000000065;</a>",
			`${String.fromCodePoint(0xfeff)}<a/>`,
		]) {
			expect(parseXmlDocument(text).problem).toBeUndefined();
		}
	});

	it("refuses each well-formedness error at a position", () => {
		for (const text of [
			"",
			"text",
			"<a>",
			"<a></b>",
			"<a/><b/>",
			'<a b="1" b="2"/>',
			'<a b="1"c="2"/>',
			"<a b=1/>",
			'<a b="<"/>',
			"<a>]]></a>",
			"<a><!-- -- --></a>",
			"<a><!-- a---></a>",
			"<a>&unknown;</a>",
			'<?xml version="1.0" standalone="yes"?><!DOCTYPE a SYSTEM "a.dtd"><a>&nbsp;</a>',
			"<a>&#0;</a>",
			"<a>&#xD800;</a>",
			"<a>& b</a>",
			"<a>\u0001</a>",
			"<a>1 < 2</a>",
			'<?xml version="2.0"?><a/>',
			'<a/><?xml version="1.0"?>',
			"<a><?xml x?></a>",
			'<!DOCTYPE a [<!ENTITY x "&y;"><!ENTITY y "&x;">]><a>&x;</a>',
			'<!DOCTYPE a [<!ENTITY m "<b/>">]><a v="&m;"/>',
			'<!DOCTYPE a [<!ENTITY f SYSTEM "f">]><a v="&f;"/>',
			"<a><![CDATA[x</a>",
		]) {
			const problem = parseXmlDocument(text).problem;
			expect(problem === undefined ? text : problem.pos).toBeNumber();
		}
	});
});
