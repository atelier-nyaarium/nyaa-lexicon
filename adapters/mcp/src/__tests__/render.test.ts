import { describe, expect, it } from "vitest";
import { renderDescribe, renderDocs, renderFacts, renderOverview } from "../render";

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

describe("explaining where a workspace's files went", () => {
	// Scan parts must reconcile.
	it("states parts that add up to the total seen", () => {
		const rendered = overview({
			scan: { tracked: 12, claimed: 9, unclaimed: 3, generated: 0, denied: 0 },
		});

		expect(rendered).toContain("12 files seen");
		expect(rendered).toContain("- 9 claimed by providers");
		expect(rendered).toContain("- 3 of no provider's language");
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

	it("reports the true total and how much the page left out", () => {
		const rendered = docs({ total: 9, truncated: true });
		expect(rendered).toContain("9 regions");
		expect(rendered).toContain("8 more");
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
