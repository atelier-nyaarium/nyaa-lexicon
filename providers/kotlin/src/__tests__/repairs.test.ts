import { describe, expect, test } from "bun:test";
import { type ParseArtifact, parseSource } from "../repairs.js";
import { nodesOf } from "../tree.js";

/** Kotlin's template opener, spelled apart from a TypeScript placeholder. */
const D = "$";

/** Repairs with covered text. */
function repairs(artifact: ParseArtifact): Array<[string, string[]]> {
	return artifact.record.map(({ repair, spans }) => [
		repair,
		spans.map(([start, end]) => artifact.text.slice(start, end)),
	]);
}

/** Broken parent links, offsets. */
function lineageBreaks(artifact: ParseArtifact): number {
	return nodesOf(artifact.tree.root).filter(
		(node) =>
			node.children.some((child) => child.parent !== node) ||
			node.start < 0 ||
			node.end > artifact.text.length ||
			node.start > node.end,
	).length;
}

describe("the repair pipeline", () => {
	test("each repair records what it rewrote as original text, over one tree lineage", () => {
		const forms: Array<[string, Array<[string, string[]]>]> = [
			["val x = 1\n", []],
			["val x = 1\n/* c */ fun f() = x\n", [["comments", ["/* c */"]]]],
			[`val json = ${D}${D}"""{ "a": ${D}${D}{x} }"""\nval after = 1\n`, [["respelling", [`${D}${D}`]]]],
			["val a = listOf(1).filter { open }\nfun open() = true\n", [["respelling", ["o", "o"]]]],
			[
				"@Target(AnnotationTarget.CLASS) annotation class Marker\n",
				[["annotations", ["@Target(AnnotationTarget.CLASS) annotation class Marker"]]],
			],
			["class A(val d: I) : I by d {\n    fun f() = d\n}\n", [["delegation", ["by d "]]]],
		];

		for (const [text, expected] of forms) {
			const artifact = parseSource(text);
			expect({
				text,
				repairs: repairs(artifact),
				errors: artifact.damage.errors,
				breaks: lineageBreaks(artifact),
			}).toEqual({ text, repairs: expected, errors: 0, breaks: 0 });
		}
	});

	test("thousands of one-line delegations each own a class body, in time linear in the owners", () => {
		const count = 4000;
		const text = Array.from(
			{ length: count },
			(_, index) => `interface I${index}\nclass A${index}(val d: I${index}) : I${index} by d { fun f() = d }\n`,
		).join("");
		const started = performance.now();
		const artifact = parseSource(text);
		const elapsed = performance.now() - started;
		const nodes = nodesOf(artifact.tree.root);
		const owners = nodes.filter(
			(node) => node.type === "class_declaration" && text.startsWith("class", node.start),
		);

		expect({
			errors: artifact.damage.errors,
			breaks: lineageBreaks(artifact),
			repaired: artifact.record.find((record) => record.repair === "delegation")?.spans.length,
			bodied: owners.filter((owner) => owner.children.some((child) => child.type === "class_body")).length,
			lambdas: nodes.filter((node) => node.type === "annotated_lambda").length,
		}).toEqual({ errors: 0, breaks: 0, repaired: count, bodied: count, lambdas: 0 });
		expect(elapsed).toBeLessThan(5000);
	});

	test("a reading tried and not taken leaves the tree it was tried against whole", () => {
		for (const text of ["@A fun f( {\n", "@A class {\n", "@A object {\n", "@Ann @B(1) fun g() = while\n"])
			expect({ text, breaks: lineageBreaks(parseSource(text)) }).toEqual({ text, breaks: 0 });
	});
});
