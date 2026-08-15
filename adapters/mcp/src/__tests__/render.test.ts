import { describe, expect, it } from "vitest";
import { renderOverview } from "../render";

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
