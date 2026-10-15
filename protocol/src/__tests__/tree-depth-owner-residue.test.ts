import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, nodesIn, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) => join(ROOT, dir));
const OWNER = join(ROOT, "protocol", "src", "depth.ts");
const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

function boundedTraversal(parsed: ReturnType<typeof parseSource>): boolean {
	return nodesIn(parsed.source).some((node) => {
		if (
			!ts.isFunctionDeclaration(node) &&
			!ts.isMethodDeclaration(node) &&
			!ts.isFunctionExpression(node) &&
			!ts.isArrowFunction(node)
		) {
			return false;
		}
		const body = node.body;
		if (body === undefined) return false;
		const descendants = nodesIn(body);
		const hasLoop = descendants.some(
			(item) =>
				ts.isForStatement(item) ||
				ts.isForOfStatement(item) ||
				ts.isForInStatement(item) ||
				ts.isWhileStatement(item) ||
				ts.isDoStatement(item),
		);
		const checksDepth = descendants.some(
			(item) =>
				ts.isBinaryExpression(item) &&
				(item.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
					item.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken) &&
				ts.isIdentifier(item.left) &&
				ts.isIdentifier(item.right),
		);
		const walksChildren = callsIn(body).some((call) => {
			const name = calleeOf(call)?.name;
			return name === "childNodes" || name === "forEachChild" || name === "childrenOf";
		});
		return hasLoop && checksDepth && walksChildren;
	});
}

describe("one owner bounds parsed tree depth", () => {
	it("finds a copied iterative depth walk in an AST fixture", () => {
		const planted = parseSource(
			"planted.ts",
			"function walk(root, max) { const pending = [root]; while (pending.length) { const node = pending.pop(); if (level >= max) return true; for (const child of childNodes(node)) pending.push(child); } return false; }",
		);

		expect(boundedTraversal(planted)).toBe(true);
	});

	it("sweeps source files and finds no duplicate tree walk", () => {
		const all = PACKAGES.flatMap((dir) => sourceFiles(dir, SKIP_DIRS));
		expect(all.length).toBeGreaterThan(50);
		expect(all).toContain(OWNER);

		const offenders: string[] = [];
		for (const file of all) {
			if (file === OWNER) continue;
			const text = readSwept(file);
			if (text === null) continue;
			if (boundedTraversal(parseSource(file, text))) offenders.push(basename(file));
		}

		expect(offenders).toEqual([]);
	});
});
