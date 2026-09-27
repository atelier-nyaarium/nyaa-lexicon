// Questions about syntax nodes that several fact passes ask.

import type * as A from "../syntax/ast.js";
import { childNodes, forEachChild } from "../syntax/ast.js";

////////////////////////////////
//  Interfaces & Types

export type Definition = A.FunctionDef | A.ClassDef;
export type Assignment = A.Assign | A.AnnAssign | A.AugAssign | A.NamedExpr;
/** Statements whose targets bind names. */
export type Binder = Assignment | A.For | A.With;

////////////////////////////////
//  Constants

const ASSIGNMENTS: ReadonlySet<A.Node["type"]> = new Set(["Assign", "AnnAssign", "AugAssign", "NamedExpr"]);
const BINDERS: ReadonlySet<A.Node["type"]> = new Set([...ASSIGNMENTS, "For", "AsyncFor", "With", "AsyncWith"]);
const CONTROL: ReadonlySet<A.Node["type"]> = new Set([
	"If",
	"For",
	"AsyncFor",
	"While",
	"With",
	"AsyncWith",
	"Try",
	"TryStar",
	"Match",
]);

////////////////////////////////
//  Classes

/** `ast.NodeVisitor`: children in field order unless `visit` handles the node. */
export class NodeVisitor {
	visit(node: A.Node): void {
		this.genericVisit(node);
	}

	protected genericVisit(node: A.Node): void {
		forEachChild(node, (child) => this.visit(child));
	}
}

////////////////////////////////
//  Functions & Helpers

export function isFunction(node: A.Node): node is A.FunctionDef {
	return node.type === "FunctionDef" || node.type === "AsyncFunctionDef";
}

export function isDefinition(node: A.Node): node is Definition {
	return node.type === "ClassDef" || isFunction(node);
}

export function isAssignment(node: A.Node): node is Assignment {
	return ASSIGNMENTS.has(node.type);
}

export function isBinder(node: A.Node): node is Binder {
	return BINDERS.has(node.type);
}

export function isStringConstant(node: A.Node | undefined): node is A.Constant & { value: { kind: "str" } } {
	return node?.type === "Constant" && node.value.kind === "str";
}

/** A leading string expression statement. */
export function docstringOf(body: readonly A.Statement[]): A.Constant | undefined {
	const first = body[0];
	return first?.type === "Expr" && isStringConstant(first.value) ? first.value : undefined;
}

export function namesInTarget(target: A.Node): A.Name[] {
	if (target.type === "Name") return [target];
	if (target.type === "Tuple" || target.type === "List") return target.elts.flatMap(namesInTarget);
	if (target.type === "Starred") return namesInTarget(target.value);
	return [];
}

export function assignmentTargets(node: A.Node): A.Name[] {
	switch (node.type) {
		case "Assign":
			return node.targets.flatMap(namesInTarget);
		case "AnnAssign":
		case "AugAssign":
		case "NamedExpr":
		case "For":
		case "AsyncFor":
			return namesInTarget(node.target);
		case "With":
		case "AsyncWith":
			return node.items.flatMap((item) =>
				item.optionalVars === undefined ? [] : namesInTarget(item.optionalVars),
			);
		default:
			return [];
	}
}

/** Targets bound whole, not unpacked from a tuple or list. */
export function wholeTargets(node: Binder): A.Expression[] {
	if (node.type === "Assign") return node.targets;
	if ("items" in node) return node.items.flatMap((item) => optional(item.optionalVars));
	return [node.target];
}

export function optional<T>(value: T | undefined): T[] {
	return value === undefined ? [] : [value];
}

/** Every parameter, keyword-only ones before `*args` and `**kwargs`. */
export function parameters(args: A.Arguments): A.Arg[] {
	return [...args.posonlyargs, ...args.args, ...args.kwonlyargs, ...optional(args.vararg), ...optional(args.kwarg)];
}

/** Every parameter in written order. */
export function writtenParameters(args: A.Arguments): A.Arg[] {
	return [...args.posonlyargs, ...args.args, ...optional(args.vararg), ...args.kwonlyargs, ...optional(args.kwarg)];
}

export function lambdaParameterNames(node: A.Lambda): Set<string> {
	return new Set(parameters(node.args).map((argument) => argument.arg));
}

export function comprehensionTargetNames(node: A.Comprehended | A.DictComp): Set<string> {
	return new Set(node.generators.flatMap((generator) => namesInTarget(generator.target).map((name) => name.id)));
}

export function patternNames(pattern: A.Node): string[] {
	const names: string[] = [];
	if ((pattern.type === "MatchAs" || pattern.type === "MatchStar") && pattern.name !== undefined)
		names.push(pattern.name);
	if (pattern.type === "MatchMapping" && pattern.rest !== undefined) names.push(pattern.rest);
	for (const child of childNodes(pattern)) names.push(...patternNames(child));
	return names;
}

/** A type parameter's bound and default. */
export function typeParamExpressions(node: A.Node): A.Expression[] {
	if (
		node.type !== "FunctionDef" &&
		node.type !== "AsyncFunctionDef" &&
		node.type !== "ClassDef" &&
		node.type !== "TypeAlias"
	) {
		return [];
	}
	return node.typeParams.flatMap((parameter) => [
		...(parameter.type === "TypeVar" && parameter.bound !== undefined ? [parameter.bound] : []),
		...optional(parameter.defaultValue),
	]);
}

export function typeParamsOf(node: A.Node): A.TypeParam[] {
	return node.type === "FunctionDef" ||
		node.type === "AsyncFunctionDef" ||
		node.type === "ClassDef" ||
		node.type === "TypeAlias"
		? node.typeParams
		: [];
}

/** Blocks a control statement holds, in field order: body, else, finally, then handlers or cases. */
export function nestedStatements(node: A.Node): A.Statement[][] {
	if (!CONTROL.has(node.type)) return [];
	const record = node as unknown as Record<string, A.Statement[] | undefined>;
	const groups = ["body", "orelse", "finalbody"].flatMap((field) => {
		const group = record[field];
		return group !== undefined && group.length > 0 ? [group] : [];
	});
	if (node.type === "Try" || node.type === "TryStar") groups.push(...node.handlers.map((handler) => handler.body));
	if (node.type === "Match") groups.push(...node.cases.map((matchCase) => matchCase.body));
	return groups;
}

/** Every statement list, outermost first, through control blocks only. */
export function* statementLists(statements: A.Statement[]): Generator<A.Statement[]> {
	yield statements;
	for (const node of statements) {
		for (const nested of nestedStatements(node)) yield* statementLists(nested);
	}
}

export function isMainGuard(node: A.Node): boolean {
	if (node.type !== "If" || node.test.type !== "Compare") return false;
	const test = node.test;
	if (test.ops.length !== 1 || test.ops[0] !== "Eq" || test.comparators.length !== 1) return false;
	const left = test.left;
	const right = test.comparators[0] as A.Expression;
	const isName = (side: A.Expression): boolean => side.type === "Name" && side.id === "__name__";
	const isMain = (side: A.Expression): boolean =>
		side.type === "Constant" && side.value.kind === "str" && side.value.value === "__main__";
	return (isName(left) && isMain(right)) || (isName(right) && isMain(left));
}
