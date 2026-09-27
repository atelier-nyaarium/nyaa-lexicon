import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { nodesIn, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/**
 * `moduleDeclarations` answers one snapshot: the read, both hashes, the failure and the rows. That
 * holds only while the module runs to completion, so no `await` and no `async` may enter it.
 */
const MODULE = path.join(import.meta.dirname, "..", "moduleDeclarations.ts");

/** A suspension point: an `await`, a `for await`, or an `async` function. */
function suspends(node: ts.Node): string | undefined {
	if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) return "await";
	const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true ? "async" : undefined;
}

describe("the module snapshot runs to completion", () => {
	it("reads a real module, so a passing run is never vacuous", () => {
		expect(readFileSync(MODULE, "utf8").length).toBeGreaterThan(200);
	});

	it("fires on each suspension point", () => {
		for (const code of [
			"async function f() {}",
			"const g = async () => 1;",
			"for await (const x of y) {}",
			"await x;",
		])
			expect(
				nodesIn(parseSource("probe.ts", code).source).some((node) => suspends(node) !== undefined),
				code,
			).toBe(true);
	});

	it("holds no await and no async", () => {
		const { source } = parseSource(MODULE, readFileSync(MODULE, "utf8"));
		const offenders = nodesIn(source).flatMap((node) => suspends(node) ?? []);

		expect(offenders, "a suspension point lets a watcher batch land between the read and the rows").toEqual([]);
	});
});
