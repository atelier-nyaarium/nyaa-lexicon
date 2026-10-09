import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import ts from "typescript";
import { lineOf, nodesIn, type ParsedSource, parsedFiles, parseSource } from "../astResidue";

/**
 * Holds `unjudgedLoadCycle` as the one spelling of the answer a provider gives when it does not judge
 * load cycles.
 *
 * Bug class killed: a hand copy of the default, which drifts from the kit's and from what core reads
 * a provider's missing method as. The token is the answer's own: an `unknowns` array holding
 * `{ reason: "provider" }`. Tests are not swept; they assert on the answer rather than give it.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) => join(ROOT, dir));

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures", "__tests__"]);

const OWNER = join(ROOT, "protocol", "src", "loadCycles.ts");

/** `unknowns: [..., { reason: "provider" }, ...]`. */
function copies(parsed: ParsedSource): ts.Node[] {
	return nodesIn(parsed.source).filter(
		(node) =>
			ts.isPropertyAssignment(node) &&
			node.name.getText(parsed.source) === "unknowns" &&
			ts.isArrayLiteralExpression(node.initializer) &&
			node.initializer.elements.some(
				(element) =>
					ts.isObjectLiteralExpression(element) &&
					element.properties.some(
						(property) =>
							ts.isPropertyAssignment(property) &&
							property.name.getText(parsed.source) === "reason" &&
							ts.isStringLiteralLike(property.initializer) &&
							property.initializer.text === "provider",
					),
			),
	);
}

describe("one spelling of the unjudged load-cycle answer", () => {
	const swept = PACKAGES.flatMap((dir) => parsedFiles(dir, SKIP_DIRS));

	it("sweeps the packages and finds the owner's own spelling, so a passing run is never vacuous", () => {
		expect(swept.length).toBeGreaterThan(50);
		expect(swept.filter((parsed) => parsed.file === OWNER).flatMap(copies)).toHaveLength(1);
	});

	it("recognizes a planted copy", () => {
		const planted = parseSource(
			"planted.ts",
			'const answer = { verdict: "unknown", unknowns: [{ reason: "provider" }] };',
		);
		expect(copies(planted)).toHaveLength(1);
	});

	it("finds no copy outside the owner", () => {
		const offenders = swept
			.filter((parsed) => parsed.file !== OWNER)
			.flatMap((parsed) =>
				copies(parsed).map((node) => `${relative(ROOT, parsed.file)}:${lineOf(parsed, node)}`),
			);

		expect(offenders, "answer with unjudgedLoadCycle from @nyaa-lexicon/protocol").toEqual([]);
	});
});
