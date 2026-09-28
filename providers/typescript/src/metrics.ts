// A declaration's size and control-flow complexity.

import type { Metrics } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import type { declarationRangeOf } from "./ranges.js";

////////////////////////////////
//  Interfaces & Types

interface MetricsFunctionLike {
	parameters: readonly ts.ParameterDeclaration[];
	body: ts.ConciseBody | undefined;
}

////////////////////////////////
//  Functions & Helpers

function functionLikeForMetrics(node: ts.Node): MetricsFunctionLike | undefined {
	if (ts.isMethodSignature(node)) return { parameters: node.parameters, body: undefined };
	if (ts.isClassStaticBlockDeclaration(node)) return { parameters: [], body: node.body };
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	) {
		return { parameters: node.parameters, body: node.body };
	}
	if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
		const initializer = node.initializer;
		if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
			return { parameters: initializer.parameters, body: initializer.body };
		}
	}
	return undefined;
}

function isControlNestingNode(node: ts.Node): boolean {
	return (
		ts.isIfStatement(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isSwitchStatement(node) ||
		ts.isTryStatement(node) ||
		ts.isCatchClause(node) ||
		ts.isWithStatement(node) ||
		ts.isConditionalExpression(node)
	);
}

function isDecisionNode(node: ts.Node): boolean {
	if (
		ts.isIfStatement(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isConditionalExpression(node) ||
		ts.isCatchClause(node)
	) {
		return true;
	}
	if (ts.isCaseClause(node)) return true;
	return (
		ts.isBinaryExpression(node) &&
		(node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
			node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
			node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
	);
}

function isNestedFunction(node: ts.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isClassStaticBlockDeclaration(node)
	);
}

function bodyMetrics(body: ts.Node): Pick<Metrics, "nesting" | "branches"> {
	let nesting = 0;
	let branches = 0;

	function walk(node: ts.Node, depth: number): void {
		if (isNestedFunction(node)) return;
		const nextDepth = isControlNestingNode(node) ? depth + 1 : depth;
		nesting = Math.max(nesting, nextDepth);
		if (isDecisionNode(node)) branches += 1;
		ts.forEachChild(node, (child) => walk(child, nextDepth));
	}

	walk(body, 0);
	return { nesting, branches: branches + 1 };
}

export function metricsOf(node: ts.Node, range: ReturnType<typeof declarationRangeOf>): Metrics {
	const metrics: Metrics = { lines: range.end.line - range.start.line + 1 };
	const functionLike = functionLikeForMetrics(node);
	if (functionLike === undefined) return metrics;
	metrics.parameters = functionLike.parameters.length;
	if (functionLike.body === undefined) return metrics;
	Object.assign(metrics, bodyMetrics(functionLike.body));
	return metrics;
}
