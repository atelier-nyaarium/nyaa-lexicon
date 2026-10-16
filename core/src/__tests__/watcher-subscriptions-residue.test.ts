import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { calleeOf, callsIn, parsedFiles, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

const CORE_SRC = `${import.meta.dirname}/..`;
const SKIP = ["dist", "node_modules", ".tsbuild"];
const FILES = parsedFiles(CORE_SRC, SKIP);
const PSEUDO_PATH = [".", "git", "/", "index"].join("");

function pseudoPathLiterals(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources.flatMap(({ file, source }) => {
		const found: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isStringLiteralLike(node) && node.text === PSEUDO_PATH) found.push(file);
			ts.forEachChild(node, visit);
		};
		visit(source);
		return found;
	});
}

function watchCallOffenders(sources: ReturnType<typeof parsedFiles>): string[] {
	return sources.flatMap(({ file, source }) =>
		callsIn(source)
			.filter((call) => calleeOf(call)?.name === "watch")
			.filter((call) => {
				const argument = call.arguments[0]?.getText(source);
				return argument !== "options.workspaceRoot" && argument !== "path.dirname(subscription.path)";
			})
			.map(() => relative(CORE_SRC, file)),
	);
}

function hasName(node: ts.Node, name: string): boolean {
	if (ts.isIdentifier(node) && node.text === name) return true;
	let found = false;
	ts.forEachChild(node, (child) => {
		if (!found) found = hasName(child, name);
	});
	return found;
}

function configComparisons(source: ts.SourceFile): ts.BinaryExpression[] {
	const found: ts.BinaryExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isBinaryExpression(node) &&
			[
				ts.SyntaxKind.EqualsEqualsToken,
				ts.SyntaxKind.EqualsEqualsEqualsToken,
				ts.SyntaxKind.ExclamationEqualsToken,
				ts.SyntaxKind.ExclamationEqualsEqualsToken,
			].includes(node.operatorToken.kind) &&
			(hasName(node.left, "CONFIG_FILE") || hasName(node.right, "CONFIG_FILE"))
		)
			found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe("watcher subscription ownership", () => {
	it("removes the synthetic index module", () => {
		expect(FILES.length).toBeGreaterThan(0);
		expect(pseudoPathLiterals(FILES)).toEqual([]);

		const planted = parseSource("planted.ts", `const path = "${PSEUDO_PATH}";`);
		expect(pseudoPathLiterals([planted])).toHaveLength(1);
	});

	it("limits filesystem watches to root and subscription paths", () => {
		const sources = FILES.filter(({ file }) => !file.includes("__tests__"));
		expect(sources.length).toBeGreaterThan(0);
		expect(watchCallOffenders(sources)).toEqual([]);

		const planted = parseSource("planted.ts", "watch(other, callback);");
		expect(watchCallOffenders([planted])).toHaveLength(1);
	});

	it("routes config changes through evidence inputs", () => {
		const indexer = FILES.find(({ file }) => file.endsWith("/indexer.ts"));
		if (indexer === undefined) throw new Error("indexer source is missing");
		expect(configComparisons(indexer.source)).toEqual([]);

		const planted = parseSource("indexer.ts", "if (module === CONFIG_FILE) return true;");
		expect(configComparisons(planted.source)).toHaveLength(1);
	});
});
