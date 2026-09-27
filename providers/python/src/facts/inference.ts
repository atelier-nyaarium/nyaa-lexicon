// Types for declarations without an annotation: an initializer's value, or a function's returns,
// folded where Python itself would fold them.

import type * as A from "../syntax/ast.js";
import { type Analyzer, identityKey } from "./analyzer.js";
import { isFunction, NodeVisitor, namesInTarget, nestedStatements, parameters } from "./nodes.js";
import { pathKey } from "./scopes.js";
import type { RawDescriptor, RawInferredType } from "./types.js";
import { binaryOperation, isLiteral, type PyLiteral, pyRepr } from "./values.js";

////////////////////////////////
//  Interfaces & Types

type Inferred =
	| { kind: "unknown"; reason: "NotImplemented" | "RecursionLimit"; detail: string }
	| { kind: "never" }
	| { kind: "literal"; value: PyLiteral; display: string }
	| { kind: "type"; display: string; descriptorPath?: RawDescriptor[] };

type Environment = Map<string, Inferred>;

////////////////////////////////
//  Constants

const MAX_DEPTH = 8;

const FOLDED_OPERATORS: ReadonlySet<A.Operator> = new Set(["Add", "Sub", "Mult", "Div", "FloorDiv", "Mod"]);

////////////////////////////////
//  Functions & Helpers

function unknown(
	reason: "NotImplemented" | "RecursionLimit" = "NotImplemented",
	detail = "expression type is not inferred",
): Inferred {
	return { kind: "unknown", reason, detail };
}

function literal(value: PyLiteral): Inferred {
	return { kind: "literal", value, display: value.kind === "None" ? "None" : `Literal[${pyRepr(value)}]` };
}

function typeValue(display: string, descriptorPath?: RawDescriptor[]): Inferred {
	return descriptorPath === undefined ? { kind: "type", display } : { kind: "type", display, descriptorPath };
}

function displayOf(value: Exclude<Inferred, { kind: "unknown" | "never" }>): string {
	return value.display;
}

function join(values: Inferred[]): Inferred {
	const unknownValue = values.find((value) => value.kind === "unknown");
	if (unknownValue !== undefined) return unknownValue;
	const known = values.filter(
		(value): value is Exclude<Inferred, { kind: "unknown" | "never" }> => value.kind !== "never",
	);
	if (known.length === 0) return { kind: "never" };
	if (known.every((value) => value.kind === "literal")) {
		const literals = known as Array<Extract<Inferred, { kind: "literal" }>>;
		if (new Set(literals.map((value) => value.value.kind)).size === 1) {
			const markers = [...new Set(literals.map((value) => pyRepr(value.value)))];
			if (markers.length === 1 && markers[0] === "None") return literal({ kind: "None" });
			return typeValue(`Literal[${markers.join(", ")}]`);
		}
	}
	const displays = [...new Set(known.map(displayOf))];
	if (displays.length === 1) {
		const paths = known.map((value) => (value.kind === "type" ? value.descriptorPath : undefined));
		const first = paths[0];
		if (first !== undefined && paths.every((path) => path !== undefined && pathKey(path) === pathKey(first))) {
			return typeValue(displays[0] as string, first);
		}
		return typeValue(displays[0] as string);
	}
	return typeValue(displays.join(" | "));
}

function isSysExit(node: A.Statement): boolean {
	return (
		node.type === "Expr" &&
		node.value.type === "Call" &&
		node.value.func.type === "Attribute" &&
		node.value.func.value.type === "Name" &&
		node.value.func.value.id === "sys" &&
		node.value.func.attr === "exit"
	);
}

function canFallThrough(node: A.Statement): boolean {
	if (node.type === "Return" || node.type === "Raise" || isSysExit(node)) return false;
	if (node.type === "If") return node.orelse.length === 0 || fallsThrough(node.body) || fallsThrough(node.orelse);
	if (node.type === "Try") return node.finalbody.length === 0 || fallsThrough(node.finalbody);
	return true;
}

function fallsThrough(statements: readonly A.Statement[]): boolean {
	return statements.every(canFallThrough);
}

function* statementNodes(statements: readonly A.Statement[]): Generator<A.Statement> {
	for (const node of statements) {
		yield node;
		if (node.type === "FunctionDef" || node.type === "AsyncFunctionDef" || node.type === "ClassDef") continue;
		for (const nested of nestedStatements(node)) yield* statementNodes(nested);
	}
}

function returnBasis(count: number, fallsThroughEnd: boolean, result: Inferred): string {
	if (result.kind === "never") return "non-returning function";
	if (count === 0) return "implicit None";
	const noun = count === 1 ? "return statement" : "return statements";
	return fallsThroughEnd ? `${count} ${noun} and implicit None` : `${count} ${noun}`;
}

////////////////////////////////
//  Classes

/** A function body's returns and whether it yields, nested scopes aside. */
class ReturnCollector extends NodeVisitor {
	readonly returns: A.Return[] = [];
	yields = false;

	override visit(node: A.Node): void {
		switch (node.type) {
			case "FunctionDef":
			case "AsyncFunctionDef":
			case "ClassDef":
			case "Lambda":
				return;
			case "Return":
				this.returns.push(node);
				break;
			case "Yield":
			case "YieldFrom":
				this.yields = true;
				break;
		}
		this.genericVisit(node);
	}
}

export class InferenceAnalyzer {
	private readonly functions = new Map<string, { path: RawDescriptor[]; node: A.FunctionDef }>();
	private readonly functionsByScope = new Map<string, RawDescriptor[][]>();
	private readonly memo = new Map<string, Inferred>();
	private readonly bases = new Map<string, string>();

	constructor(private readonly analyzer: Analyzer) {
		for (const [key, { path, nodes }] of analyzer.declarationNodes) {
			const node = nodes.at(-1) as A.Node;
			if (!isFunction(node)) continue;
			this.functions.set(key, { path, node });
			const scopeKey = `${pathKey(path.slice(0, -1))}#${node.name}`;
			this.functionsByScope.set(scopeKey, [...(this.functionsByScope.get(scopeKey) ?? []), path]);
		}
	}

	private functionForName(scope: RawDescriptor[], name: string): RawDescriptor[] | undefined {
		for (let length = scope.length; length >= 0; length--) {
			const paths = this.functionsByScope.get(`${pathKey(scope.slice(0, length))}#${name}`) ?? [];
			if (paths.length === 1) return paths[0];
			if (paths.length > 1) return undefined;
		}
		return undefined;
	}

	private evaluate(
		node: A.Expression,
		environment: Environment,
		scope: RawDescriptor[],
		stack: string[],
		depth: number,
	): Inferred {
		if (depth >= MAX_DEPTH) return unknown("RecursionLimit", "type inference reached its depth limit");
		const next = (child: A.Expression): Inferred => this.evaluate(child, environment, scope, stack, depth + 1);
		switch (node.type) {
			case "Constant":
				return isLiteral(node.value)
					? literal(node.value)
					: unknown("NotImplemented", "literal value is not supported");
			case "Name":
				return environment.get(node.id) ?? unknown("NotImplemented", `type of ${node.id} is not inferred`);
			case "UnaryOp": {
				if (node.op !== "UAdd" && node.op !== "USub") break;
				const value = next(node.operand);
				if (value.kind === "literal" && (value.value.kind === "int" || value.value.kind === "float")) {
					if (node.op === "UAdd") return literal(value.value);
					return literal(
						value.value.kind === "int"
							? { kind: "int", value: -value.value.value }
							: { kind: "float", value: -value.value.value },
					);
				}
				return value.kind === "unknown" ? value : unknown("NotImplemented", "unary expression is not inferred");
			}
			case "BinOp": {
				const left = next(node.left);
				const right = next(node.right);
				if (left.kind === "unknown") return left;
				if (right.kind === "unknown") return right;
				if (left.kind === "literal" && right.kind === "literal" && FOLDED_OPERATORS.has(node.op)) {
					const result = binaryOperation(node.op, left.value, right.value);
					if (result !== undefined) return literal(result);
				}
				return unknown("NotImplemented", "binary expression is not inferred");
			}
			case "IfExp":
				return join([next(node.body), next(node.orelse)]);
			case "List":
				return typeValue("list");
			case "Dict":
				return typeValue("dict");
			case "Set":
				return typeValue("set");
			case "Tuple":
				return typeValue("tuple");
			case "Call": {
				if (node.func.type !== "Name") break;
				// "extends" keeps this a class-only check.
				const binding = this.analyzer.scopes.bindingFor({
					name: node.func.id,
					role: "extends",
					scopePath: scope,
					position: this.analyzer.source.rangeOf(node.func).start,
				});
				if (binding.status === "bound") return typeValue(node.func.id, binding.descriptorPath);
				const target = this.functionForName(scope, node.func.id);
				if (target !== undefined) return this.inferFunction(target, stack, depth + 1);
				break;
			}
			case "JoinedStr":
				return typeValue("str");
		}
		return unknown();
	}

	private environmentOf(node: A.FunctionDef, scope: RawDescriptor[], stack: string[], depth: number): Environment {
		const environment: Environment = new Map();
		for (const argument of parameters(node.args)) {
			environment.set(argument.arg, unknown("NotImplemented", `parameter ${argument.arg} has no inferred type`));
		}
		for (const statement of statementNodes(node.body)) {
			if (statement.type === "Assign") {
				const value = this.evaluate(statement.value, environment, scope, stack, depth + 1);
				for (const target of statement.targets)
					for (const name of namesInTarget(target)) environment.set(name.id, value);
			} else if (statement.type === "AnnAssign" && statement.value !== undefined) {
				const value = this.evaluate(statement.value, environment, scope, stack, depth + 1);
				for (const name of namesInTarget(statement.target)) environment.set(name.id, value);
			} else if (statement.type === "AugAssign") {
				for (const name of namesInTarget(statement.target)) {
					environment.set(
						name.id,
						unknown("NotImplemented", `augmented assignment to ${name.id} is not inferred`),
					);
				}
			}
		}
		return environment;
	}

	private inferFunction(path: RawDescriptor[], stack: string[], depth: number): Inferred {
		const key = identityKey(path);
		const remembered = this.memo.get(key);
		if (remembered !== undefined) return remembered;
		if (stack.includes(key) || depth >= MAX_DEPTH)
			return unknown("RecursionLimit", "recursive return inference reached its limit");
		const entry = this.functions.get(key);
		if (entry === undefined) return unknown("NotImplemented", "function declaration is not indexed");
		const collector = new ReturnCollector();
		for (const statement of entry.node.body) collector.visit(statement);
		if (collector.yields) {
			const result = unknown("NotImplemented", "generator return inference is not implemented");
			this.memo.set(key, result);
			return result;
		}
		const inner = [...stack, key];
		const environment = this.environmentOf(entry.node, path, inner, depth + 1);
		const values = collector.returns.map((node) =>
			node.value === undefined
				? literal({ kind: "None" })
				: this.evaluate(node.value, environment, path, inner, depth + 1),
		);
		const endReached = fallsThrough(entry.node.body);
		if (endReached) values.push(literal({ kind: "None" }));
		const result = join(values);
		this.bases.set(key, returnBasis(collector.returns.length, endReached, result));
		this.memo.set(key, result);
		return result;
	}

	private inferDeclaration(path: RawDescriptor[]): [Inferred, string | undefined] {
		const key = identityKey(path);
		const node = this.analyzer.declarationNodes.get(key)?.nodes.at(-1);
		if (node !== undefined && isFunction(node)) {
			const result = this.inferFunction(path, [], 0);
			return [result, this.bases.get(key) ?? "return statements"];
		}
		if (node === undefined) return [unknown("NotImplemented", "declaration initializer is not indexed"), undefined];
		const value =
			node.type === "Assign" || node.type === "AnnAssign" || node.type === "NamedExpr" ? node.value : undefined;
		if (value === undefined) {
			const detail =
				node.type === "ClassDef"
					? "class type inference is not implemented"
					: "initializer type is not inferred";
			return [unknown("NotImplemented", detail), undefined];
		}
		return [this.evaluate(value, new Map(), path.slice(0, -1), [], 0), "initializer"];
	}

	run(): RawInferredType[] {
		const answers: RawInferredType[] = [];
		for (const raw of this.analyzer.declarations.values()) {
			if (raw.typeText !== undefined) continue;
			const path = raw.descriptorPath;
			const [result, basis] = this.inferDeclaration(path);
			if (result.kind === "unknown")
				answers.push({ descriptorPath: path, reason: result.reason, detail: result.detail });
			else {
				answers.push({
					descriptorPath: path,
					display: result.kind === "never" ? "Never" : result.display,
					basis: basis ?? "inference",
					...(result.kind === "type" && result.descriptorPath !== undefined
						? { typeDescriptorPath: result.descriptorPath }
						: {}),
				});
			}
		}
		return answers;
	}
}
