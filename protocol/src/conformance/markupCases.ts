import type { ConformanceCase } from "./types.js";

const XML = "xml";
const HTML = "html";
const TEXT = "text";

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
				[TEXT]: { files: { empty: "" }, subject: "empty" },
			},
			declarationNames: [],
			parseErrors: "forbidden",
			notes: "forbidden",
		},
		{
			id: "text-paragraphs",
			tier: "docs",
			about: "Plain text is split into maximal nonblank paragraph regions.",
			fixtures: {
				[TEXT]: {
					files: { "paragraphs.txt": "first line\nsecond line\n\nthird\n" },
					subject: "paragraphs.txt",
					docs: [
						{ text: "first line\nsecond line", fenced: false },
						{ text: "third", fenced: false },
					],
				},
			},
		},
		{
			id: "text-crlf-and-trailing-newline",
			tier: "docs",
			about: "Plain text retains CRLF source text and excludes the trailing line break from its region.",
			fixtures: {
				[TEXT]: {
					files: { "lines.txt": "one\r\ntwo\r\n" },
					subject: "lines.txt",
					docs: [{ text: "one\r\ntwo", fenced: false }],
				},
			},
		},
		{
			id: "text-long-paragraph-split",
			tier: "docs",
			about: "A long paragraph is split at a line boundary without dropping source text.",
			fixtures: {
				[TEXT]: {
					files: { "split.txt": `${"a".repeat(16 * 1024)}\nnext` },
					subject: "split.txt",
					docs: [
						{ text: "a".repeat(16 * 1024), fenced: false },
						{ text: "next", fenced: false },
					],
				},
			},
		},
		{
			id: "text-region-cap",
			tier: "docs",
			about: "Plain text reports an informational note when the per-file region cap omits paragraphs.",
			fixtures: {
				[TEXT]: {
					files: { "cap.txt": `${"x\n\n".repeat(10_001)}tail` },
					subject: "cap.txt",
				},
			},
			notes: "required",
		},
		{
			id: "text-no-extension-and-dockerfile",
			tier: "docs",
			about: "Plain text claims files without extensions, including a Dockerfile.",
			fixtures: {
				[TEXT]: {
					files: { Dockerfile: 'FROM scratch\n\nENTRYPOINT ["app"]' },
					subject: "Dockerfile",
					docs: [
						{ text: "FROM scratch", fenced: false },
						{ text: 'ENTRYPOINT ["app"]', fenced: false },
					],
				},
			},
		},
	];
}
