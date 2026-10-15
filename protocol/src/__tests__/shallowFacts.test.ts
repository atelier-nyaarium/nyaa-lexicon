import { describe, expect, it } from "bun:test";
import type { FileFacts } from "../project.js";
import { shallowFacts } from "../shallowFacts.js";

function facts(overrides: Partial<FileFacts> = {}): FileFacts {
	return {
		module: "a.txt",
		contentHash: "h",
		declarations: [],
		references: [],
		imports: [],
		literals: [],
		diagnostics: [],
		...overrides,
	};
}

describe("shallowFacts", () => {
	it("empties present evidence arrays and omits blank lines at shallow depths", () => {
		const projected = shallowFacts(
			facts({
				literals: [{} as FileFacts["literals"][number]],
				comments: [{} as NonNullable<FileFacts["comments"]>[number]],
				docs: [{} as NonNullable<FileFacts["docs"]>[number]],
				blankLines: [1],
			}),
			"outline",
		);

		expect(projected).toMatchObject({
			depth: "outline",
			literals: [],
			comments: [],
			docs: [],
		});
		expect(Object.hasOwn(projected, "blankLines")).toBe(false);
	});

	it("keeps absent optional evidence absent", () => {
		const projected = shallowFacts(facts(), "surface");

		expect(Object.hasOwn(projected, "comments")).toBe(false);
		expect(Object.hasOwn(projected, "docs")).toBe(false);
	});

	it("preserves full facts and optionally records an explicit full request", () => {
		const full = facts();

		expect(shallowFacts(full, undefined)).toBe(full);
		expect(shallowFacts(full, "full")).toBe(full);
		expect(shallowFacts(full, "full", { includeFullDepth: true })).toMatchObject({ depth: "full" });
	});
});
