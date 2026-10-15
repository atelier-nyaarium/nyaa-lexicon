import { describe, expect, it } from "bun:test";
import { basename, join } from "node:path";
import ts from "typescript";
import { calleeOf, callsIn, nodesIn, type ParsedSource, parseSource } from "../astResidue";
import { readSwept, sourceFiles } from "../residue";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PACKAGES = ["protocol", "core", "adapters", "providers"].map((dir) => join(ROOT, dir));
const OWNER = join(ROOT, "protocol", "src", "coordinates.ts");
const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "tmp", "fixtures"]);

function isCoordinateMember(node: ts.Node): node is ts.PropertyAccessExpression {
	return ts.isPropertyAccessExpression(node) && (node.name.text === "line" || node.name.text === "character");
}

function isEndpointCoordinate(node: ts.Node): boolean {
	return (
		isCoordinateMember(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		(node.expression.name.text === "start" || node.expression.name.text === "end")
	);
}

function isBareCoordinate(node: ts.Node): boolean {
	return isCoordinateMember(node) && ts.isIdentifier(node.expression);
}

function isRangeEndpoint(node: ts.Node, endpoint: "start" | "end"): node is ts.PropertyAccessExpression {
	return ts.isPropertyAccessExpression(node) && node.name.text === endpoint;
}

function endpointOwner(node: ts.Expression, endpoint: "start" | "end", parsed: ParsedSource): string | undefined {
	if (!isRangeEndpoint(node, endpoint)) return undefined;
	return node.expression.getText(parsed.source);
}

function orderedArguments(call: ts.CallExpression): [ts.Expression, ts.Expression] | undefined {
	if (calleeOf(call)?.name !== "comparePositions" || call.arguments.length !== 2) return undefined;
	const [first, second] = call.arguments;
	if (first === undefined || second === undefined) return undefined;
	const parent = call.parent;
	if (!ts.isBinaryExpression(parent)) return undefined;
	if (parent.left === call && ts.isNumericLiteral(parent.right) && parent.right.text === "0") {
		if (parent.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) return [first, second];
		if (parent.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken) return [second, first];
	}
	if (parent.right === call && ts.isNumericLiteral(parent.left) && parent.left.text === "0") {
		if (parent.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken) return [first, second];
		if (parent.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) return [second, first];
	}
	return undefined;
}

function comparedPositions(parsed: ParsedSource): boolean {
	return nodesIn(parsed.source).some((node) => {
		if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
			return false;
		const checks = callsIn(node).flatMap((call) => {
			const ordered = orderedArguments(call);
			return ordered === undefined ? [] : [ordered];
		});
		return checks.some(
			([start, position]) =>
				isRangeEndpoint(start, "start") &&
				checks.some(
					([samePosition, end]) =>
						position.getText(parsed.source) === samePosition.getText(parsed.source) &&
						isRangeEndpoint(end, "end"),
				),
		);
	});
}

function comparedRanges(parsed: ParsedSource): boolean {
	return nodesIn(parsed.source).some((node) => {
		if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
			return false;
		const starts: Array<[string, string]> = [];
		const ends: Array<[string, string]> = [];
		for (const call of callsIn(node)) {
			const ordered = orderedArguments(call);
			if (ordered === undefined) continue;
			const [first, second] = ordered;
			const firstStart = endpointOwner(first, "start", parsed);
			const secondStart = endpointOwner(second, "start", parsed);
			if (firstStart !== undefined && secondStart !== undefined) starts.push([firstStart, secondStart]);
			const firstEnd = endpointOwner(first, "end", parsed);
			const secondEnd = endpointOwner(second, "end", parsed);
			if (firstEnd !== undefined && secondEnd !== undefined) ends.push([firstEnd, secondEnd]);
		}
		return starts.some(([outer, inner]) =>
			ends.some(([sameInner, sameOuter]) => inner === sameInner && outer === sameOuter),
		);
	});
}

function directCoordinateComparison(parsed: ParsedSource): boolean {
	return nodesIn(parsed.source).some(
		(node) =>
			ts.isBinaryExpression(node) &&
			[
				ts.SyntaxKind.LessThanToken,
				ts.SyntaxKind.LessThanEqualsToken,
				ts.SyntaxKind.GreaterThanToken,
				ts.SyntaxKind.GreaterThanEqualsToken,
			].includes(node.operatorToken.kind) &&
			((isBareCoordinate(node.left) && isEndpointCoordinate(node.right)) ||
				(isEndpointCoordinate(node.left) && isBareCoordinate(node.right))),
	);
}

function duplicatesContainment(parsed: ParsedSource): boolean {
	return comparedPositions(parsed) || comparedRanges(parsed) || directCoordinateComparison(parsed);
}

describe("one owner defines position containment", () => {
	it("finds inclusive position and range comparison copies in AST fixtures", () => {
		const planted = parseSource(
			"planted.ts",
			"function contains(range, position) { return position.line >= range.start.line && position.line <= range.end.line; }",
		);

		expect(duplicatesContainment(planted)).toBe(true);
		const nested = parseSource(
			"nested.ts",
			"function contains(outer, inner) { return comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0; }",
		);
		expect(duplicatesContainment(nested)).toBe(true);

		const delegated = parseSource(
			"delegated.ts",
			"function contains(outer, inner) { return rangeInRange(outer, inner); }",
		);
		expect(duplicatesContainment(delegated)).toBe(false);
	});

	it("sweeps source files and finds no duplicate containment", () => {
		const all = PACKAGES.flatMap((dir) => sourceFiles(dir, SKIP_DIRS));
		expect(all.length).toBeGreaterThan(50);
		expect(all).toContain(OWNER);

		const offenders: string[] = [];
		for (const file of all) {
			if (file === OWNER) continue;
			const text = readSwept(file);
			if (text === null) continue;
			const parsed = parseSource(file, text);
			if (duplicatesContainment(parsed)) offenders.push(basename(file));
		}

		expect(offenders).toEqual([]);
	});
});
