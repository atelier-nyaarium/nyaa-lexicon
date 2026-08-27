import type { ConformanceCase } from "./types.js";

const XML = "xml";
const HTML = "html";

export function markupCases(): ConformanceCase[] {
	return [
		{
			id: "markup-identity-precedence",
			tier: "declarations",
			about: "Markup identity attributes prefer id, then name, then key, while empty values fall back to the tag.",
			fixtures: {
				[XML]: {
					files: { "identity.xml": '<root id="winner" name="ignored" key="ignored"/>\n' },
					subject: "identity.xml",
				},
				[HTML]: {
					files: { "identity.html": '<root id="winner" name="ignored" key="ignored"></root>\n' },
					subject: "identity.html",
				},
			},
			declarations: [{ name: "winner", kind: "property" }],
		},
		{
			id: "markup-occurrences",
			tier: "declarations",
			about: "Repeated sibling elements remain distinct declarations after occurrence minting.",
			fixtures: {
				[XML]: { files: { "repeated.xml": "<root><item/><item/></root>\n" }, subject: "repeated.xml" },
				[HTML]: {
					files: { "repeated.html": "<root><item></item><item></item></root>\n" },
					subject: "repeated.html",
				},
			},
			declarationNames: ["root", "item", "item"],
		},
		{
			id: "markup-heading-and-region",
			tier: "docs",
			about: "HTML headings and their block prose share one declaration tree and the prose anchor.",
			fixtures: {
				[HTML]: {
					files: { "document.html": "<h1>Title</h1><p>before <em>middle</em> after</p>\n" },
					subject: "document.html",
					docs: [{ text: "before <em>middle</em> after", under: "Title", fenced: false }],
				},
			},
		},
		{
			id: "markup-fenced-region",
			tier: "docs",
			about: "Preformatted HTML prose is retained as a fenced document region.",
			fixtures: {
				[HTML]: {
					files: { "fenced.html": "<pre>one\n two</pre>\n" },
					subject: "fenced.html",
					docs: [{ text: "one\n two", fenced: true }],
				},
			},
		},
		{
			id: "markup-implied-end-tag",
			tier: "docs",
			about: "HTML implied end tags still produce a source-backed block region.",
			fixtures: {
				[HTML]: {
					files: { "implied.html": "<ul><li>one<li>two</ul>\n" },
					subject: "implied.html",
					docs: [
						{ text: "one", fenced: false },
						{ text: "two", fenced: false },
					],
				},
			},
		},
		{
			id: "markup-malformed-xml-position",
			tier: "syntaxDiagnostics",
			about: "Malformed XML is rejected with a parser diagnostic.",
			fixtures: { [XML]: { files: { "broken.xml": "<root>\n" }, subject: "broken.xml" } },
			parseErrors: "required",
			declarationNames: [],
		},
		{
			id: "markup-oversized-value",
			tier: "literals",
			about: "Oversized markup values are diagnosed and omitted from literal facts.",
			fixtures: {
				[XML]: { files: { "large.xml": `<root d="${"x".repeat(20_000)}"/>\n` }, subject: "large.xml" },
				[HTML]: { files: { "large.html": `<root d="${"x".repeat(20_000)}"></root>\n` }, subject: "large.html" },
			},
			notes: "required",
		},
		{
			id: "markup-empty-file",
			tier: "declarations",
			about: "Empty markup files produce no facts or diagnostics.",
			fixtures: {
				[XML]: { files: { "empty.xml": "" }, subject: "empty.xml" },
				[HTML]: { files: { "empty.html": "" }, subject: "empty.html" },
			},
			declarationNames: [],
			parseErrors: "forbidden",
			notes: "forbidden",
		},
	];
}
