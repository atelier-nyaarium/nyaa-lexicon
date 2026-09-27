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

type Member =
	| { kind: "literal"; value: PyLiteral; display: string }
	| { kind: "type"; display: string; descriptorPath?: RawDescriptor[] };

type Inferred =
	| { kind: "unknown"; reason: "NotImplemented" | "RecursionLimit"; detail: string }
	| { kind: "never" }
	| Member
	/** Two or more members, flat. */
	| { kind: "union"; members: Member[]; display: string };

type Environment = Map<string, Inferred>;

/** The kinds `int`, `float`, `bool` and `str` a value is of, for arithmetic on unknown values. */
type Primitive = "int" | "float" | "bool" | "str";

////////////////////////////////
//  Constants

const MAX_DEPTH = 8;

const FOLDED_OPERATORS: ReadonlySet<A.Operator> = new Set(["Add", "Sub", "Mult", "Div", "FloorDiv", "Mod"]);

const FLOAT_OPERATORS: ReadonlySet<A.Operator> = new Set(["Add", "Sub", "Mult", "FloorDiv", "Mod", "Pow"]);

const BITWISE_OPERATORS: ReadonlySet<A.Operator> = new Set(["BitAnd", "BitOr", "BitXor"]);

const PRIMITIVES: ReadonlySet<string> = new Set(["int", "float", "bool", "str"]);

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

/** Every value any path gives: an unknown path leaves it unknown, a dead one adds nothing. */
function join(values: Inferred[]): Inferred {
	const unknownValue = values.find((value) => value.kind === "unknown");
	if (unknownValue !== undefined) return unknownValue;
	const members = new Map<string, Member>();
	for (const value of values) {
		const flat = value.kind === "union" ? value.members : value.kind === "never" ? [] : [value as Member];
		for (const member of flat) {
			const key = member.kind === "literal" ? `literal ${pyRepr(member.value)}` : `type ${member.display}`;
			const seen = members.get(key);
			// A class named twice keeps its id only when both name the same one.
			if (
				seen?.kind === "type" &&
				member.kind === "type" &&
				!samePath(seen.descriptorPath, member.descriptorPath)
			)
				members.set(key, typeValue(member.display) as Member);
			else if (seen === undefined) members.set(key, member);
		}
	}
	// `int` takes in `Literal[0]`.
	const all = [...members.values()].filter(
		(member) => member.kind !== "literal" || !members.has(`type ${member.value.kind}`),
	);
	if (all.length === 0) return { kind: "never" };
	if (all.length === 1) return all[0] as Member;
	return { kind: "union", members: all, display: unionDisplay(all) };
}

function samePath(left: RawDescriptor[] | undefined, right: RawDescriptor[] | undefined): boolean {
	return left !== undefined && right !== undefined && pathKey(left) === pathKey(right);
}

/** `Literal[...]` for the literals, then the types, then `None`, as typing writes a union. */
function unionDisplay(members: readonly Member[]): string {
	const literals = members.filter((member) => member.kind === "literal" && member.value.kind !== "None");
	const parts =
		literals.length === 0
			? []
			: [
					`Literal[${literals.map((member) => pyRepr((member as Extract<Member, { kind: "literal" }>).value)).join(", ")}]`,
				];
	for (const member of members) if (member.kind === "type") parts.push(member.display);
	if (members.some((member) => member.kind === "literal" && member.value.kind === "None")) parts.push("None");
	return parts.join(" | ");
}

function primitiveOf(value: Inferred): Primitive | undefined {
	if (value.kind === "literal") return value.value.kind === "None" ? undefined : value.value.kind;
	if (value.kind === "type") return PRIMITIVES.has(value.display) ? (value.display as Primitive) : undefined;
	if (value.kind !== "union") return undefined;
	const kinds = new Set(value.members.map(primitiveOf));
	return kinds.size === 1 ? [...kinds][0] : undefined;
}

/** What an operator gives on values known only by kind, where Python's own rules fix the result. */
function arithmetic(operator: A.Operator, left: Inferred, right: Inferred): Inferred | undefined {
	const a = primitiveOf(left);
	const b = primitiveOf(right);
	if (a === undefined || b === undefined) return undefined;
	const integral = (kind: Primitive) => kind === "int" || kind === "bool";
	if (a === "str" || b === "str") {
		if (operator === "Add" && a === "str" && b === "str") return typeValue("str");
		if (operator === "Mult" && ((a === "str" && integral(b)) || (b === "str" && integral(a))))
			return typeValue("str");
		return operator === "Mod" && a === "str" ? typeValue("str") : undefined;
	}
	if (operator === "Div") return typeValue("float");
	if (a === "float" || b === "float") return FLOAT_OPERATORS.has(operator) ? typeValue("float") : undefined;
	if (BITWISE_OPERATORS.has(operator) && a === "bool" && b === "bool") return typeValue("bool");
	// A negative power of an int is a float.
	return operator === "Pow" || operator === "MatMult" ? undefined : typeValue("int");
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
	if (node.type === "Try" || node.type === "TryStar") {
		if (node.finalbody.length > 0 && !fallsThrough(node.finalbody)) return false;
		const completes = fallsThrough(node.body) && fallsThrough(node.orelse);
		return completes || node.handlers.some((handler) => fallsThrough(handler.body));
	}
	if (node.type === "With" || node.type === "AsyncWith") return fallsThrough(node.body);
	if (node.type === "While") return !isTruthyConstant(node.test) || breaks(node.body);
	return true;
}

function fallsThrough(statements: readonly A.Statement[]): boolean {
	return statements.every(canFallThrough);
}

function replace(environment: Environment, next: Environment): void {
	environment.clear();
	for (const [name, value] of next) environment.set(name, value);
}

/** Every value a name holds across paths; a path where it is unbound adds none. */
function merge(environments: readonly Environment[]): Environment {
	const merged: Environment = new Map();
	const names = new Set(environments.flatMap((environment) => [...environment.keys()]));
	for (const name of names) {
		merged.set(name, join(environments.map((environment) => environment.get(name) ?? { kind: "never" })));
	}
	return merged;
}

/** A loop may run any number of times, so a literal it changes keeps only its type. */
function widened(before: Environment, after: Environment): Environment {
	const widen = (member: Member): Member =>
		member.kind === "literal" && member.value.kind !== "None" ? (typeValue(member.value.kind) as Member) : member;
	const result: Environment = new Map(after);
	for (const [name, value] of after) {
		if (before.get(name) === value) continue;
		if (value.kind === "literal") result.set(name, widen(value));
		else if (value.kind === "union") result.set(name, join(value.members.map(widen)));
	}
	return result;
}

/** A `break` that leaves this loop, not one inside a loop or definition nested in it. */
function breaks(statements: readonly A.Statement[]): boolean {
	return statements.some((node) => {
		if (node.type === "Break") return true;
		if (node.type === "For" || node.type === "AsyncFor" || node.type === "While") return breaks(node.orelse);
		return nestedStatements(node).some(breaks);
	});
}

function isTruthyConstant(test: A.Expression): boolean {
	if (test.type !== "Constant") return false;
	const value = test.value;
	return (value.kind === "bool" && value.value) || (value.kind === "int" && value.value !== 0n);
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
				return environment.get(node.id) ?? this.outerName(node, scope, stack, depth);
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
				return (
					arithmetic(node.op, left, right) ?? unknown("NotImplemented", "binary expression is not inferred")
				);
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
				// A parameter or local of that name is what gets called.
				if (environment.has(node.func.id)) break;
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

	/** A name the body does not bind: a module or enclosing variable's own inferred value. */
	private outerName(node: A.Name, scope: RawDescriptor[], stack: string[], depth: number): Inferred {
		const missing = unknown("NotImplemented", `type of ${node.id} is not inferred`);
		const binding = this.analyzer.scopes.bindingFor({
			name: node.id,
			role: "read",
			scopePath: scope,
			position: this.analyzer.source.rangeOf(node).start,
		});
		if (binding.status !== "bound") return missing;
		const key = identityKey(binding.descriptorPath);
		const declared = this.analyzer.declarationNodes.get(key)?.nodes.at(-1);
		if (declared?.type !== "Assign") return missing;
		const remembered = this.memo.get(key);
		if (remembered !== undefined) return remembered;
		if (stack.includes(key) || depth >= MAX_DEPTH)
			return unknown("RecursionLimit", "type inference reached its depth limit");
		const result = this.evaluate(
			declared.value,
			new Map(),
			binding.descriptorPath.slice(0, -1),
			[...stack, key],
			depth + 1,
		);
		this.memo.set(key, result);
		return result;
	}

	/**
	 * Walks a body in order: each assignment rebinds, branches join where they meet, and each
	 * `return` is valued where it runs. Mutates `environment`; branches walk copies.
	 */
	private walk(
		statements: readonly A.Statement[],
		environment: Environment,
		scope: RawDescriptor[],
		stack: string[],
		depth: number,
		returns: Inferred[],
	): Environment {
		const evaluate = (expression: A.Expression) => this.evaluate(expression, environment, scope, stack, depth + 1);
		const branch = (body: readonly A.Statement[], from: Environment) =>
			this.walk(body, new Map(from), scope, stack, depth, returns);
		const unbind = (names: readonly A.Name[], why: string) => {
			for (const name of names) environment.set(name.id, unknown("NotImplemented", `${name.id} ${why}`));
		};
		const assign = (target: A.Expression, value: Inferred) => {
			if (target.type === "Name") environment.set(target.id, value);
			else unbind(namesInTarget(target), "is unpacked, which is not inferred");
		};
		for (const node of statements) {
			switch (node.type) {
				case "Assign": {
					const value = evaluate(node.value);
					for (const target of node.targets) assign(target, value);
					break;
				}
				case "AnnAssign":
					if (node.value !== undefined) assign(node.target, evaluate(node.value));
					break;
				case "AugAssign": {
					if (node.target.type !== "Name") break;
					const left = environment.get(node.target.id);
					const right = evaluate(node.value);
					const folded =
						left?.kind === "literal" && right.kind === "literal" && FOLDED_OPERATORS.has(node.op)
							? binaryOperation(node.op, left.value, right.value)
							: undefined;
					const typed = left === undefined ? undefined : arithmetic(node.op, left, right);
					environment.set(
						node.target.id,
						folded !== undefined
							? literal(folded)
							: (typed ??
									unknown(
										"NotImplemented",
										`augmented assignment to ${node.target.id} is not inferred`,
									)),
					);
					break;
				}
				case "Return":
					returns.push(node.value === undefined ? literal({ kind: "None" }) : evaluate(node.value));
					break;
				case "If": {
					const body = branch(node.body, environment);
					const orelse = branch(node.orelse, environment);
					const live = [
						fallsThrough(node.body) ? body : undefined,
						fallsThrough(node.orelse) ? orelse : undefined,
					];
					replace(environment, merge(live.filter((end) => end !== undefined)));
					break;
				}
				case "For":
				case "AsyncFor":
				case "While": {
					if (node.type !== "While")
						unbind(namesInTarget(node.target), "is a loop target, which is not inferred");
					// A first pass learns what one iteration changes; the second runs from any iteration.
					const once = this.walk(node.body, new Map(environment), scope, stack, depth, []);
					const entry = merge([environment, widened(environment, once)]);
					const body = branch(node.body, entry);
					replace(environment, merge([entry, widened(entry, body)]));
					this.walk(node.orelse, environment, scope, stack, depth, returns);
					break;
				}
				case "With":
				case "AsyncWith":
					for (const item of node.items)
						if (item.optionalVars !== undefined)
							unbind(
								namesInTarget(item.optionalVars),
								"is bound by a context manager, which is not inferred",
							);
					this.walk(node.body, environment, scope, stack, depth, returns);
					break;
				case "Try":
				case "TryStar": {
					const start = new Map(environment);
					const body = branch(node.body, environment);
					// A handler may start from anywhere in the body.
					const caught = merge([start, body]);
					const ends = node.handlers.flatMap((handler) => {
						const end = branch(handler.body, caught);
						if (handler.name !== undefined)
							end.set(handler.name, unknown("NotImplemented", "exception type is not inferred"));
						return fallsThrough(handler.body) ? [end] : [];
					});
					const orelse = branch(node.orelse, body);
					if (fallsThrough(node.body) && fallsThrough(node.orelse)) ends.push(orelse);
					replace(environment, merge(ends.length > 0 ? ends : [orelse]));
					this.walk(node.finalbody, environment, scope, stack, depth, returns);
					break;
				}
				case "Match": {
					const ends = node.cases.map((matchCase) => branch(matchCase.body, environment));
					replace(environment, merge([new Map(environment), ...ends]));
					break;
				}
				case "FunctionDef":
				case "AsyncFunctionDef":
				case "ClassDef":
					environment.set(node.name, unknown("NotImplemented", `${node.name} is a local definition`));
					break;
				case "Delete":
					for (const target of node.targets) unbind(namesInTarget(target), "is deleted");
					break;
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
		const environment: Environment = new Map();
		for (const argument of parameters(entry.node.args)) {
			environment.set(argument.arg, unknown("NotImplemented", `parameter ${argument.arg} has no inferred type`));
		}
		const values: Inferred[] = [];
		this.walk(entry.node.body, environment, path, inner, depth + 1, values);
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
