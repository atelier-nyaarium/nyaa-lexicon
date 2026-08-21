import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	comparePositions,
	coordinatesOf,
	FileFactsSchema,
	InitializeResponseSchema,
	ProjectModelSchema,
	type Range,
	reasonOf,
} from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { MarkdownProvider, TIERS } from "../main.js";
import { parseMarkdown } from "../parser.js";

const temporary: string[] = [];

afterEach(() => {
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-markdown-"));
	temporary.push(root);
	for (const [name, content] of Object.entries(files)) {
		const absolute = path.join(root, name);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, content, "utf8");
	}
	return root;
}

function names(text: string, kind: "heading" | "property"): string[] {
	return parseMarkdown("doc.md", text)
		.declarations.filter((declaration) => declaration.kind === kind)
		.map((declaration) => declaration.name);
}

describe("document structure", () => {
	test("a heading tree is a table of contents", () => {
		const parsed = parseMarkdown("doc.md", "# Title\n\n## Development\n\n### Releasing\n\n## Verifying\n");
		const byId = new Map(parsed.declarations.map((d) => [d.symbolId, d.name]));
		const tree = parsed.declarations.map((d) => [
			d.name,
			d.containerId === undefined ? null : byId.get(d.containerId),
		]);

		expect(tree).toEqual([
			["Title", null],
			["Development", "Title"],
			["Releasing", "Development"],
			["Verifying", "Title"],
		]);
	});

	test("a section's range covers everything under it, so its source can be read back", () => {
		const text = "# Title\n\nintro\n\n## Development\n\nbuild it\n\n## Verifying\n\ncheck it\n";
		const parsed = parseMarkdown("doc.md", text);
		const coordinates = coordinatesOf(text);
		const spans = parsed.declarations.map((d) => coordinates.sliceRange(d.range));

		expect(spans).toEqual([
			"# Title\n\nintro\n\n## Development\n\nbuild it\n\n## Verifying\n\ncheck it",
			"## Development\n\nbuild it",
			"## Verifying\n\ncheck it",
		]);
	});

	test("a heading's selection range is the source of its name, markup included", () => {
		const text = "# The `parseFile` call\n\n## Plain\n";
		const parsed = parseMarkdown("doc.md", text);
		const coordinates = coordinatesOf(text);

		expect(parsed.declarations.map((d) => coordinates.sliceRange(d.selectionRange))).toEqual([
			"The `parseFile` call",
			"Plain",
		]);
	});

	test("a heading name is its rendered text, so inline markup does not become part of it", () => {
		expect(names("# The `parseFile` call\n", "heading")).toEqual(["The parseFile call"]);
		expect(names("# See [the docs](x.md)\n", "heading")).toEqual(["See the docs"]);
		expect(names("## Closing sequence ##\n", "heading")).toEqual(["Closing sequence"]);
	});

	test("a heading with no text reports a diagnostic instead of an unnamed section", () => {
		const parsed = parseMarkdown("doc.md", "# T\n\n##\n\nafter\n");

		expect(names("# T\n\n##\n\nafter\n", "heading")).toEqual(["T"]);
		expect(parsed.diagnostics).toHaveLength(1);
		expect(parsed.docs.map((region) => region.anchorId)).toEqual([undefined]);
	});

	test("quoted and listed headings stay prose rather than growing sections", () => {
		const parsed = parseMarkdown("doc.md", "# T\n\n> ## quoted\n> body\n\n- # listed\n");

		expect(parsed.declarations.map((d) => d.name)).toEqual(["T"]);
		expect(parsed.docs.map((region) => region.text)).toEqual(["> ## quoted\n> body", "- # listed"]);
	});
});

describe("repeated sibling headings", () => {
	test("each repeat gets its own id and says so", () => {
		const parsed = parseMarkdown("doc.md", "# Top\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond\n");
		const ids = parsed.declarations.filter((d) => d.name === "Notes").map((d) => d.symbolId);

		expect(new Set(ids).size).toBe(2);
		expect(parsed.diagnostics.map((problem) => problem.severity)).toEqual(["info"]);
		expect(parsed.docs.map((region) => region.anchorId)).toEqual(ids);
	});

	test("the count is per parent, so the same name under two parents does not collide or number", () => {
		const parsed = parseMarkdown("doc.md", "# A\n\n## Notes\n\n# B\n\n## Notes\n");
		const ids = parsed.declarations.filter((d) => d.name === "Notes").map((d) => d.symbolId);

		expect(new Set(ids).size).toBe(2);
		expect(ids.some((id) => id.includes("(2)"))).toBe(false);
		expect(parsed.diagnostics).toEqual([]);
	});
});

describe("prose regions", () => {
	const document = [
		"---",
		"title: Rules",
		"---",
		"",
		"Preamble.",
		"",
		"# Title",
		"",
		"Before the fence.",
		"",
		"```bash",
		"## not a heading",
		"bun run build",
		"```",
		"",
		"~~~",
		"tilde fenced",
		"~~~",
		"",
		"After the fence.",
		"",
		"    indented code",
		"",
		"| a | b |",
		"| - | - |",
		"| 1 | 2 |",
		"",
		"---",
		"",
		"## Section",
		"",
		"- one",
		"- two",
		"",
	].join("\n");

	test("every region slices its own text back out of the source", () => {
		const parsed = parseMarkdown("doc.md", document);
		const coordinates = coordinatesOf(document);

		for (const region of parsed.docs) expect(coordinates.sliceRange(region.range)).toBe(region.text);
	});

	test("regions partition the document: disjoint and in reading order", () => {
		const parsed = parseMarkdown("doc.md", document);

		for (const [index, region] of parsed.docs.entries()) {
			if (index === 0) continue;
			const previous = parsed.docs[index - 1];
			expect(
				comparePositions(region.range.start, previous?.range.end ?? region.range.start),
			).toBeGreaterThanOrEqual(0);
		}
	});

	test("both fence characters are fenced, and an indented block is code but not fenced", () => {
		const parsed = parseMarkdown("doc.md", document);
		const fenced = parsed.docs.filter((region) => region.fenced);

		expect(fenced.map((region) => region.text)).toEqual(["## not a heading\nbun run build", "tilde fenced"]);
		expect(parsed.docs.some((region) => region.text.includes("indented code") && region.fenced)).toBe(false);
	});

	// It would normalize to nothing, so it would store as a region no search could ever reach.
	test("a fence holding only whitespace yields no region", () => {
		for (const source of ["# T\n\n```\n   \n```\n", "# T\n\n```\n\t\t\n```\n", "# T\n\n```\n\n\n```\n"]) {
			expect(parseMarkdown("doc.md", source).docs).toEqual([]);
		}
		expect(parseMarkdown("doc.md", "# T\n\n```\n  \nreal\n  \n```\n").docs.map((r) => r.text)).toEqual([
			"  \nreal\n  ",
		]);
	});

	test("a thematic break is punctuation, so it is not a searchable region", () => {
		const parsed = parseMarkdown("doc.md", document);

		expect(parsed.docs.some((region) => region.text.trim() === "---")).toBe(false);
	});

	test("prose anchors to the heading above it, and to nothing before the first one", () => {
		const parsed = parseMarkdown("doc.md", document);
		const byId = new Map(parsed.declarations.map((d) => [d.symbolId, d.name]));
		const anchors = parsed.docs.map((region) => (region.anchorId === undefined ? null : byId.get(region.anchorId)));

		expect(anchors).toEqual([null, "Title", "Title", "Title", "Title", "Title", "Title", "Section"]);
	});
});

describe("carriage returns", () => {
	const text = "# Title\r\n\r\nBefore.\r\n\r\n```sh\r\none\r\ntwo\r\n```\r\n\r\nAfter.\r\n";

	test("a carriage return terminates its line rather than becoming prose", () => {
		const parsed = parseMarkdown("doc.md", text);

		expect(parsed.docs.map((region) => region.text)).toEqual(["Before.", "one\r\ntwo", "After."]);
	});

	test("ranges still slice their own text back", () => {
		const parsed = parseMarkdown("doc.md", text);
		const coordinates = coordinatesOf(text);

		for (const region of parsed.docs) expect(coordinates.sliceRange(region.range)).toBe(region.text);
	});
});

describe("a byte order mark", () => {
	// mdast strips it, so an unshifted range addresses the character before the one it means.
	const BOM = String.fromCharCode(0xfeff);

	test("shifts nothing, with either line ending", () => {
		for (const ending of ["\n", "\r\n"]) {
			const text = `${BOM}# Title${ending}${ending}body${ending}`;
			const parsed = parseMarkdown("doc.md", text);
			const coordinates = coordinatesOf(text);

			expect(coordinates.sliceRange(parsed.declarations[0]?.selectionRange as Range)).toBe("Title");
			expect(parsed.docs.map((region) => region.text)).toEqual(["body"]);
			for (const region of parsed.docs) expect(coordinates.sliceRange(region.range)).toBe(region.text);
		}
	});
});

describe("frontmatter", () => {
	test("a key with no name is not a declaration", () => {
		for (const source of ["---\n: 1\n---\n\n# H\n", "---\n?\n: x\n---\n\n# H\n"]) {
			expect(names(source, "property")).toEqual([]);
			expect(names(source, "heading")).toEqual(["H"]);
		}
	});

	test("its closing delimiter never becomes a heading", () => {
		const text = "---\ntitle: Rules\nmeta:\n  owner: nyaa\n---\n\n# Body\n";

		expect(names(text, "heading")).toEqual(["Body"]);
	});

	test("keys are properties, nested maps chain, and sequence entries are omitted", () => {
		const parsed = parseMarkdown("doc.md", "---\ntitle: Rules\ntags:\n  - one\nmeta:\n  owner: nyaa\n---\n");
		const byId = new Map(parsed.declarations.map((d) => [d.symbolId, d.name]));

		expect(
			parsed.declarations.map((d) => [d.name, d.containerId === undefined ? null : byId.get(d.containerId)]),
		).toEqual([
			["title", null],
			["tags", null],
			["meta", null],
			["owner", "meta"],
		]);
	});

	test("it rides every markdown extension, not only .mdc", () => {
		for (const module of ["rules.md", "rules.mdc", "rules.markdown"]) {
			expect(parseMarkdown(module, "---\na: 1\n---\n\n# B\n").declarations.map((d) => d.kind)).toEqual([
				"property",
				"heading",
			]);
		}
	});

	test("a broken document reports the error and still keys what it parsed", () => {
		const parsed = parseMarkdown("doc.md", "---\na: [1,\n---\n\n# B\n");

		expect(parsed.diagnostics.map((problem) => problem.severity)).toContain("error");
		expect(names("---\na: [1,\n---\n\n# B\n", "property")).toEqual(["a"]);
	});

	test("key ranges point into the file, and a key's range carries its value", () => {
		const text = "---\ntitle: Rules\nmeta:\n  owner: nyaa\n---\n";
		const parsed = parseMarkdown("doc.md", text);
		const coordinates = coordinatesOf(text);

		expect(parsed.declarations.map((d) => coordinates.sliceRange(d.selectionRange))).toEqual([
			"title",
			"meta",
			"owner",
		]);
		expect(parsed.declarations.map((d) => coordinates.sliceRange(d.range))).toEqual([
			"title: Rules",
			"meta:\n  owner: nyaa",
			"owner: nyaa",
		]);
	});
});

describe("the provider surface", () => {
	// The whole tier set, because a wrong FALSE reads as an honest gap and a wrong true is a lie.
	test("initialize declares only what a document can answer", () => {
		const response = InitializeResponseSchema.parse(new MarkdownProvider().initialize(process.cwd()));

		expect(response.tiers).toEqual({
			projectModel: true,
			declarations: true,
			references: false,
			imports: false,
			binding: false,
			types: false,
			literals: false,
			comments: false,
			docs: true,
			metrics: false,
			syntaxDiagnostics: true,
		});
		expect(response.tiers).toEqual(TIERS);
		expect(response.extensions).toEqual([".md", ".mdc", ".markdown"]);
	});

	test("discoverProject claims every markdown extension and skips vendored trees", () => {
		const root = workspace({
			"README.md": "# a\n",
			"rules/style.mdc": "---\na: 1\n---\n",
			"docs/long.markdown": "# b\n",
			"notes.txt": "not markdown\n",
			"node_modules/pkg/README.md": "# skip me\n",
		});
		const model = ProjectModelSchema.parse(new MarkdownProvider().discoverProject(root));

		expect(model.files).toEqual(["README.md", "docs/long.markdown", "rules/style.mdc"]);
	});

	test("parseFile answers a valid FileFacts and carries prose at full depth", () => {
		const provider = new MarkdownProvider();
		const facts = FileFactsSchema.parse(
			provider.parseFile({ module: "doc.md", contentHash: "h", text: "# T\n\nbody\n" }),
		);

		expect(facts.module).toBe("doc.md");
		expect(facts.contentHash).toBe("h");
		expect(facts.declarations.map((d) => d.name)).toEqual(["T"]);
		expect(facts.docs?.map((region) => region.text)).toEqual(["body"]);
		expect(facts.depth).toBeUndefined();
		// Empty, never absent: absent is how a provider says a tier is false.
		expect([facts.references, facts.imports, facts.literals, facts.comments]).toEqual([[], [], [], []]);
	});

	test("a shallower request gets the table of contents without the prose, and says which depth", () => {
		const provider = new MarkdownProvider();

		for (const depth of ["outline", "surface"] as const) {
			const facts = FileFactsSchema.parse(
				provider.parseFile({ module: "doc.md", contentHash: "h", text: "# T\n\nbody\n", depth }),
			);
			expect(facts.declarations).toHaveLength(1);
			expect(facts.docs).toEqual([]);
			expect(facts.depth).toBe(depth);
		}
	});

	test("a document answers nothing about types, bindings or imports, with a reason", () => {
		const provider = new MarkdownProvider();
		const resolution = provider.resolveImport({ fromModule: "doc.md", specifier: "./x" });

		expect(reasonOf(provider.typeOf({ symbolId: "x" }))).toBe("NotImplemented");
		expect(reasonOf(provider.bind({ module: "doc.md", name: "x" }))).toBe("NotImplemented");
		expect(resolution.status === "unresolved" && resolution.reason).toBe("NotImplemented");
	});

	test("a write is refused rather than attempted, and says why", () => {
		const provider = new MarkdownProvider();
		const rename = provider.renameEdits({ module: "doc.md", text: "", oldName: "x", newName: "y", sites: [] });
		const move = provider.moveEdits({
			role: {},
			module: "doc.md",
			text: "",
			exists: true,
			symbolId: "x",
			name: "x",
			fromModule: "doc.md",
			toModule: "other.md",
			dependencies: [],
			importSites: [],
			sites: [],
		});

		expect([rename.status, move.status]).toEqual(["refused", "refused"]);
		expect([rename.status === "refused" && rename.reason, move.status === "refused" && move.reason]).toEqual([
			"NotImplemented",
			"NotImplemented",
		]);
	});
});
