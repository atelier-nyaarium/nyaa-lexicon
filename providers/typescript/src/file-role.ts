// Whether loading a file runs it, which makes it an entry rather than a library.

import type { FileRole } from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { isAssignmentOperator } from "./references.js";

////////////////////////////////
//  Functions & Helpers

function unwrapParentheses(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current)) current = current.expression;
	return current;
}

function isRequireMainGuard(expression: ts.Expression): boolean {
	const condition = unwrapParentheses(expression);
	if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
		return false;
	}
	const isRequireMain = (node: ts.Expression) => {
		const value = unwrapParentheses(node);
		return (
			ts.isPropertyAccessExpression(value) &&
			ts.isIdentifier(value.expression) &&
			value.expression.text === "require" &&
			value.name.text === "main"
		);
	};
	const isModule = (node: ts.Expression) => {
		const value = unwrapParentheses(node);
		return ts.isIdentifier(value) && value.text === "module";
	};
	return (
		(isRequireMain(condition.left) && isModule(condition.right)) ||
		(isModule(condition.left) && isRequireMain(condition.right))
	);
}

function isImportMetaMainGuard(expression: ts.Expression): boolean {
	const condition = unwrapParentheses(expression);
	if (!ts.isPropertyAccessExpression(condition) || condition.name.text !== "main") return false;
	const meta = condition.expression;
	return ts.isMetaProperty(meta) && meta.keywordToken === ts.SyntaxKind.ImportKeyword && meta.name.text === "meta";
}

function isRunAsProgramGuard(condition: ts.Expression): boolean {
	return isImportMetaMainGuard(condition) || isRequireMainGuard(condition);
}

function runsOnLoad(statement: ts.Statement): boolean {
	return (
		ts.isExpressionStatement(statement) ||
		ts.isIfStatement(statement) ||
		ts.isForStatement(statement) ||
		ts.isForInStatement(statement) ||
		ts.isForOfStatement(statement) ||
		ts.isWhileStatement(statement) ||
		ts.isDoStatement(statement) ||
		ts.isTryStatement(statement) ||
		ts.isSwitchStatement(statement) ||
		ts.isBlock(statement) ||
		ts.isWithStatement(statement) ||
		ts.isThrowStatement(statement) ||
		ts.isLabeledStatement(statement) ||
		ts.isDebuggerStatement(statement)
	);
}

/** Effects on load, weakest first. A file takes its strongest. */
const LoadEffect = { Declares: 0, Guarded: 1, Runs: 2 } as const;

function strongest(statements: readonly (ts.Statement | undefined)[]): number {
	let effect: number = LoadEffect.Declares;
	for (const statement of statements) {
		if (statement !== undefined) effect = Math.max(effect, loadEffect(statement));
	}
	return effect;
}

function loadEffect(statement: ts.Statement): number {
	if (!runsOnLoad(statement)) return LoadEffect.Declares;
	if (ts.isExpressionStatement(statement)) {
		const expression = unwrapParentheses(statement.expression);
		return ts.isBinaryExpression(expression) && isAssignmentOperator(expression.operatorToken.kind)
			? LoadEffect.Declares
			: LoadEffect.Runs;
	}
	if (ts.isIfStatement(statement)) {
		// A guard's branch is the program; its else still runs on import.
		if (isRunAsProgramGuard(statement.expression)) {
			return Math.max(LoadEffect.Guarded, strongest([statement.elseStatement]));
		}
		return strongest([statement.thenStatement, statement.elseStatement]);
	}
	if (ts.isTryStatement(statement)) {
		return strongest([statement.tryBlock, statement.catchClause?.block, statement.finallyBlock]);
	}
	if (ts.isBlock(statement)) return strongest(statement.statements);
	if (ts.isLabeledStatement(statement)) return loadEffect(statement.statement);
	return LoadEffect.Runs;
}

export function fileRoleOf(source: ts.SourceFile): FileRole {
	switch (strongest(source.statements)) {
		case LoadEffect.Runs:
			return { kind: "entry", how: "topLevel" };
		case LoadEffect.Guarded:
			return { kind: "entry", how: "guardedMain" };
		default:
			return { kind: "library" };
	}
}
