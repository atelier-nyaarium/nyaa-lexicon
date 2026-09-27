import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { DAEMON_CONTROLS, DAEMON_METHODS, sourceFiles } from "@nyaa-lexicon/protocol";
import { literalText, nodesIn, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds per-request policy to the declared lifecycle: nothing in the client or the daemon compares a
 * request's name to decide how it is treated.
 *
 * Bug class killed: a request gated by a name check in one place and by its declared rule in
 * another, so the daemon before its handler, the daemon after it and a client disagree about it.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SWEPT = [join(ROOT, "client", "src"), join(ROOT, "core", "src")];

const SKIP = ["__tests__", "dist", "node_modules", ".tsbuild"];

const NAMES = new Set([...Object.keys(DAEMON_METHODS), ...Object.keys(DAEMON_CONTROLS)]);

const EQUALITIES = new Set([
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

////////////////////////////////
//  Functions & Helpers

/** Request names in equality operands or switch cases. */
function comparedNames(root: ts.Node): string[] {
	return nodesIn(root).flatMap((node) => {
		const operands =
			ts.isBinaryExpression(node) && EQUALITIES.has(node.operatorToken.kind)
				? [node.left, node.right]
				: ts.isCaseClause(node)
					? [node.expression]
					: [];
		return operands.flatMap((operand) => {
			const name = literalText(operand);
			return name !== undefined && NAMES.has(name) ? [name] : [];
		});
	});
}

////////////////////////////////
//  Tests

describe("request policy lives in the declared lifecycle", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
	});

	it("catches a planted name branch in each spelling", () => {
		const planted = [
			`if (method === "shutdown") stop();`,
			`if ('indexStatus' !== name) warm();`,
			"switch (method) { case `refactorStatus`: break; }",
			`if (rule.lifecycle === "control") answer();`,
			`callDaemon(lock, "shutdown", {});`,
		].join("\n");
		expect(comparedNames(parseSource("probe.ts", planted).source)).toEqual([
			"shutdown",
			"indexStatus",
			"refactorStatus",
		]);
	});

	it("has no client or daemon source branching on a request name", () => {
		const found = SWEPT.flatMap((dir) => parsedFiles(dir, SKIP)).flatMap(({ file, source }) => {
			const where = relative(ROOT, file).split("\\").join("/");
			return comparedNames(source).map((name) => `${where}: ${name}`);
		});

		expect(found, "judge a request by requestRule(name), never by comparing its name").toEqual([]);
	});
});
