import { describe, expect, it } from "bun:test";
import { renderDescribe, renderDocs, renderFacts, renderKnowledgeGaps, renderOutline, renderOverview } from "../render";

////////////////////////////////
//  Helpers

function overview(extra: Partial<Parameters<typeof renderOverview>[0]> = {}): string {
	return renderOverview({
		files: 2,
		symbols: 2,
		references: 0,
		imports: 0,
		literals: 0,
		modules: 2,
		scope: "12 files",
		index: { state: "ready", done: 0, total: 0, failures: 0, fullFiles: 2, outlineFiles: 0 },
		largest: [],
		...extra,
	});
}

////////////////////////////////
//  Tests

describe("saying what a seeded page could not tell", () => {
	const row = {
		symbolId: "lexicon typescript src/a.ts add().",
		question: "describe",
		why: "missing" as const,
		askCount: 0,
		fanIn: 4,
	};

	it("names the unknown counts under a seeded header, in a sentence", () => {
		const rendered = renderKnowledgeGaps(
			{
				question: "describe",
				rows: [row],
				total: 1,
				external: 0,
				truncated: false,
				seeded: true,
				seededUnknown: { generated: 1, exported: 2 },
			},
			undefined,
		);

		expect(rendered).toContain(
			"> Of these, 1 comes from a file git could not call generated or not, and 2 have no export verdict from the provider; all stay eligible.",
		);
	});

	it("says nothing when nothing was unknown, and nothing on a page of measured demand", () => {
		const seeded = renderKnowledgeGaps(
			{
				question: "describe",
				rows: [row],
				total: 1,
				external: 0,
				truncated: false,
				seeded: true,
				seededUnknown: { generated: 0, exported: 0 },
			},
			undefined,
		);
		const measured = renderKnowledgeGaps(
			{
				question: "describe",
				rows: [{ ...row, askCount: 3 }],
				total: 1,
				external: 0,
				truncated: false,
				seededUnknown: { generated: 1, exported: 0 },
			},
			undefined,
		);

		expect(seeded).not.toContain("Of these");
		expect(measured).not.toContain("Of these");
	});
});

describe("keeping the page's several file counts apart", () => {
	// Name modules absent from workspace counts.
	it("names the external modules the counts table excludes and the depth line includes", () => {
		const rendered = overview({
			files: 753,
			index: { state: "ready", done: 0, total: 0, failures: 0, stored: 932, fullFiles: 750, outlineFiles: 182 },
		});

		expect(rendered).toContain("179 external surface modules");
		expect(rendered).toContain("932 in total");
		// Store-wide depth uses modules.
		expect(rendered).toContain("750 modules at final depth");
	});

	// The steady state: nothing outline, so no depth line exists to point at.
	it("stands on its own when the upgrade has finished and no depth line is printed", () => {
		const rendered = overview({
			files: 700,
			index: { state: "ready", done: 0, total: 0, failures: 0, stored: 800, fullFiles: 800, outlineFiles: 0 },
		});

		expect(rendered).not.toContain("Depth:");
		expect(rendered).toContain("100 external surface modules");
		expect(rendered).toContain("800 in total");
		expect(rendered).not.toContain("depth line");
	});

	it("says nothing about external modules when the index holds none", () => {
		const rendered = overview({
			files: 10,
			index: { state: "ready", done: 0, total: 0, failures: 0, stored: 10, fullFiles: 10, outlineFiles: 0 },
		});

		expect(rendered).not.toContain("external surface");
	});
});

describe("telling code from data", () => {
	it("counts files and symbols per class and ranks data files under their own heading", () => {
		const rendered = overview({
			content: {
				files: { code: 100, data: 40, document: 3, text: 0, unknown: 0 },
				symbols: { code: 900, data: 4500, document: 30, text: 0, unknown: 0 },
			},
			largest: [{ module: "src/a.ts", symbols: 120 }],
			largestData: [
				{ module: "fixtures/specs.json", symbols: 2694, content: "data" },
				{ module: "README.md", symbols: 30, content: "document" },
			],
		});

		expect(rendered).toContain(
			"Files: 100 code, 40 data, 3 documents. Symbols: 900 in code, 4500 in data, 30 in documents.",
		);
		expect(rendered).toContain("`fixtures/specs.json`: 2694 symbols (data)");
		expect(rendered).toContain("`README.md`: 30 symbols (document)");
		expect(rendered).toContain("Data files carry more symbols than code");
		expect(rendered.indexOf("## Largest modules")).toBeLessThan(
			rendered.indexOf("## Largest data and document files"),
		);
	});

	it("says nothing about classes when every file is code, and names the rows still unrecorded", () => {
		const allCode = overview({
			content: {
				files: { code: 5, data: 0, document: 0, text: 0, unknown: 0 },
				symbols: { code: 50, data: 0, document: 0, text: 0, unknown: 0 },
			},
		});
		expect(allCode).not.toContain("Files: ");
		expect(allCode).not.toContain("Largest data");

		const stale = overview({
			content: {
				files: { code: 5, data: 0, document: 0, text: 0, unknown: 2 },
				symbols: { code: 50, data: 0, document: 0, text: 0, unknown: 9 },
			},
		});
		expect(stale).toContain("2 files were read before their content class was recorded");
	});
});

describe("explaining where a workspace's files went", () => {
	// Scan parts must reconcile.
	it("states parts that add up to the total seen", () => {
		const rendered = overview({
			scan: { tracked: 12, claimed: 9, unclaimed: 3, generated: 0, denied: 0 },
		});

		expect(rendered).toContain("12 files seen");
		expect(rendered).toContain("- 9 claimed by providers");
		expect(rendered).toContain("- 3 claimed by no provider");
	});

	it("names generated and out-of-scope files only when there are some", () => {
		const withBoth = overview({ scan: { tracked: 10, claimed: 5, unclaimed: 2, generated: 2, denied: 1 } });
		expect(withBoth).toContain("2 generated");
		expect(withBoth).toContain("1 outside scope");

		const withNeither = overview({ scan: { tracked: 7, claimed: 5, unclaimed: 2, generated: 0, denied: 0 } });
		expect(withNeither).not.toContain("generated");
		expect(withNeither).not.toContain("outside scope");
	});
});

describe("showing what a provider said while reading", () => {
	const note = {
		severity: "info" as const,
		message: "comment in strict JSON",
		range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
	};

	it("lists a file's notes under its outline, with the line", () => {
		const rendered = renderOutline("tsconfig.json", [], { module: "tsconfig.json", known: true, notes: [note] });

		expect(rendered).toContain("## Provider notes");
		expect(rendered).toContain("Line 2: info: comment in strict JSON");
	});

	it("says the notes are unknown for a file read before they were kept, and stays silent otherwise", () => {
		const before = renderOutline("a.ts", [], { module: "a.ts", known: false, reason: "indexedBeforeNotes" });
		expect(before).toContain("Provider notes unknown");

		const unindexed = renderOutline("a.ts", [], { module: "a.ts", known: false, reason: "notIndexed" });
		expect(unindexed).not.toContain("Provider notes");
		const clean = renderOutline("a.ts", [], { module: "a.ts", known: true, notes: [] });
		expect(clean).not.toContain("Provider notes");
	});

	it("counts noted and unread files on the overview", () => {
		expect(overview({ notes: { noted: 3, unknown: 2 } })).toContain("Files with provider notes: 3");
		expect(overview({ notes: { noted: 3, unknown: 2 } })).toContain("Files read before notes were kept: 2");
		expect(overview({ notes: { noted: 0, unknown: 0 } })).not.toContain("provider notes");
	});
});

describe("reporting what failed to parse", () => {
	const failures = (count: number, reason: string) =>
		Array.from({ length: count }, (_, index) => ({ module: `src/f${index}.ts`, reason }));

	// The original complaint: a count nobody can act on.
	it("names each file with its reason", () => {
		const rendered = overview({
			index: { state: "ready", done: 0, total: 0, failures: 2, fullFiles: 2, outlineFiles: 0 },
			parseFailures: [
				{ module: "src/a.ts", reason: "'}' expected." },
				{ module: "src/b.ts", reason: "parseFile timed out after 60000ms" },
			],
		});

		expect(rendered).toContain("src/a.ts");
		expect(rendered).toContain("'}' expected.");
		expect(rendered).toContain("src/b.ts");
		expect(rendered).toContain("parseFile timed out after 60000ms");
	});

	// 373 identical failures once shipped. One line beats 373 of the same sentence.
	it("collapses many failures sharing a reason, and stays bounded", () => {
		const rendered = overview({
			index: { state: "ready", done: 0, total: 0, failures: 373, fullFiles: 2, outlineFiles: 0 },
			parseFailures: failures(373, "parseFile timed out after 60000ms"),
		});

		expect(rendered).toContain("parseFile timed out after 60000ms (373 files)");
		// Grouping deduplicates the sentence, never the paths: nothing else can reach an omitted
		// one, so omitting it restores the unactionable warning this section replaced.
		for (const index of [0, 11, 200, 372]) expect(rendered).toContain(`src/f${index}.ts`);
		// The reason is said once, not 373 times.
		expect(rendered.match(/parseFile timed out/g)).toHaveLength(1);
	});

	it("keeps every reason, sorted by how many files share it", () => {
		const rendered = overview({
			index: { state: "ready", done: 0, total: 0, failures: 4, fullFiles: 2, outlineFiles: 0 },
			parseFailures: [
				{ module: "src/a.ts", reason: "rare" },
				{ module: "src/b.ts", reason: "common" },
				{ module: "src/c.ts", reason: "common" },
				{ module: "src/d.ts", reason: "common" },
			],
		});

		expect(rendered.indexOf("common (3 files)")).toBeLessThan(rendered.indexOf("rare"));
		expect(rendered).toContain("src/a.ts");
	});

	it("says nothing about failures when there are none", () => {
		expect(overview()).not.toContain("Failed to parse");
	});
});

describe("offering every citable fact kind, not a hand-kept subset", () => {
	const SYMBOL = "lexicon reference src/a.ts work#";

	function facts(kind: string): string {
		return renderFacts({
			symbolId: SYMBOL,
			facts: [{ factId: `lexfact ${kind} src/a.ts abc123`, kind, module: "src/a.ts", summary: `a ${kind}` }],
			truncated: [],
		});
	}

	// A citation cannot be made from an id the author was never shown.
	it.each(["declaration", "reference", "import", "literal", "comment", "doc"])("prints a %s id", (kind) => {
		expect(facts(kind)).toContain(`lexfact ${kind} src/a.ts abc123`);
	});

	it("leaves doubt ids out, since a doubt is a handshake rather than evidence", () => {
		expect(facts("doubt")).not.toContain("lexfact doubt");
	});
});

////////////////////////////////
//  Documents

function region(extra: Record<string, unknown> = {}) {
	return {
		factId: "lexfact doc CLAUDE.md abc123",
		module: "CLAUDE.md",
		range: { start: { line: 41, character: 0 }, end: { line: 42, character: 0 } },
		fenced: false,
		raw: "No band-aids. Weigh the long-run cost.",
		headingPath: ["nyaa-lexicon", "Principles"],
		...extra,
	};
}

function docs(overrides: Record<string, unknown> = {}): string {
	return renderDocs({
		query: { text: "band-aid" },
		docs: [region()],
		count: { kind: "exact", count: 1 },
		total: 1,
		truncated: false,
		...overrides,
	} as unknown as Parameters<typeof renderDocs>[0]);
}

describe("answering a docs search with a place rather than a line", () => {
	it("names the heading path, which is why this is not a comment search", () => {
		expect(docs()).toContain("nyaa-lexicon > Principles");
		expect(docs()).toContain("CLAUDE.md");
	});

	it("says when a match sits inside a code block, and stays quiet when it does not", () => {
		expect(docs({ docs: [region({ fenced: true })] })).toContain("[in a code block]");
		expect(docs()).not.toContain("[in a code block]");
	});

	it("says the region sits under no heading rather than printing an empty path", () => {
		expect(docs({ docs: [region({ headingPath: [] })] })).toContain("(no heading)");
	});

	it("prints the match column when core provides a hit", () => {
		expect(docs({ docs: [region({ hit: { line: 1, character: 4 } })] })).toContain("Line 2:5");
		expect(docs()).toContain("- Line 42: nyaa-lexicon > Principles");
	});

	it("reports the true total and how much the page left out", () => {
		const rendered = docs({ count: { kind: "exact", count: 9 }, total: 9, truncated: true });
		expect(rendered).toContain("9 regions");
		expect(rendered).toContain("8 more");
	});

	// A probe is a floor; the sentence comes from the count.
	it("calls a floor a floor, and says which bound stopped the counting", () => {
		const probed = docs({
			count: { kind: "atLeast", count: 51, reason: "pageCapped" },
			total: 51,
			truncated: true,
		});
		expect(probed).toContain("at least 51 regions");
		expect(probed).toContain("uncounted. Raise `limit`");
		expect(probed).not.toContain("stopped before the end");

		const scanned = docs({
			count: { kind: "atLeast", count: 1, reason: "scanCapped" },
			total: 1,
			truncated: false,
		});
		expect(scanned).toContain("at least 1 region");
		expect(scanned).toContain("stopped before the end of the index");
		expect(scanned).not.toContain("Raise `limit`");

		const both = docs({
			count: { kind: "atLeast", count: 80, reason: "pageAndScanCapped" },
			total: 80,
			truncated: true,
		});
		expect(both).toContain("uncounted. Raise `limit`");
		expect(both).toContain("stopped before the end of the index");
	});
});

describe("describing a heading", () => {
	function described(kind: string, extra: Record<string, unknown> = {}): string {
		return renderDescribe({
			symbol: { symbolId: "id", name: "Principles", kind, module: "CLAUDE.md", visibility: "public" },
			members: [],
			referenceCount: 0,
			graph: { fanOut: 0 },
			hierarchy: { supertypes: [], subtypes: [], ancestors: [], unboundSupertypes: [] },
			tier: "full",
			...extra,
		} as unknown as Parameters<typeof renderDescribe>[0]);
	}

	// A fence around a section title reads as code that does not exist.
	it("prints no signature block, unlike a code symbol", () => {
		expect(described("heading")).not.toContain("```ts");
		expect(described("function")).toContain("```ts");
	});

	it("shows the section prose, which is what a document has instead of a body", () => {
		const rendered = described("heading", {
			prose: [{ line: 41, fenced: false, text: "No band-aids." }],
			moreProse: 3,
		});

		expect(rendered).toContain("No band-aids.");
		expect(rendered).toContain("3 more");
	});

	it("marks prose that came from a code block", () => {
		expect(described("heading", { prose: [{ line: 5, fenced: true, text: "bun run build" }] })).toContain(
			"in a code block",
		);
	});

	// Zero would read as a checked fact rather than a question that does not apply to a section.
	it("says the code questions do not apply, rather than answering each of them zero", () => {
		const heading = described("heading");

		expect(heading).not.toContain("Used in 0 places");
		expect(heading).not.toContain("Type hierarchy");
		expect(heading).not.toContain("Dependencies");
		expect(heading).toContain("document structure");
		expect(described("function")).toContain("Used in 0 places");
	});
});
