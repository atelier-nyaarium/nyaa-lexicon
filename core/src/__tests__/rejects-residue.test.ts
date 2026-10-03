import { describe, expect, it } from "bun:test";
import path from "node:path";
import { nodesIn, parsedFiles } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/** Every package holding tests. */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SKIP = ["node_modules", "dist", ".tsbuild", "temp"];

/** Lines reading `.rejects` off a direct `expect(...)` call. */
function rejectsIn(source: ts.SourceFile): number[] {
	return nodesIn(source)
		.filter(
			(node) =>
				ts.isPropertyAccessExpression(node) &&
				node.name.text === "rejects" &&
				ts.isCallExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "expect",
		)
		.map((node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
}

describe("awaiting a rejection in a test", () => {
	it("finds a planted expect(...).rejects", () => {
		const planted = ts.createSourceFile(
			"planted.test.ts",
			"await rejection(p);\nawait expect(p).rejects.toThrow();\n",
			ts.ScriptTarget.ESNext,
			true,
		);

		expect(rejectsIn(planted)).toEqual([2]);
	});

	// `expect(promise).rejects` stalls bun's loop while I/O is pending; `rejection` and `rethrown` do not.
	it("never goes through expect(...).rejects", () => {
		const tests = parsedFiles(ROOT, SKIP).filter(({ file }) => file.endsWith(".test.ts"));
		const offenders = tests.flatMap(({ file, source }) =>
			rejectsIn(source).map((line) => `${path.relative(ROOT, file)}:${line}`),
		);

		expect(tests.length).toBeGreaterThan(100);
		expect(offenders).toEqual([]);
	});
});
