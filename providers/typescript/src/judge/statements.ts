// Statements: what each runs at load, in order, and how each completion leaves it.

import ts from "typescript";
import { classDeclaration, enumDeclaration, namespaceDeclaration } from "./definitions.js";
import { moduleStatement } from "./loader.js";
import { copyOwn, readMember } from "./members.js";
import {
	type Exit,
	type Flow,
	type Frame,
	type Guard,
	isNullish,
	literal,
	MAX_ITERATIONS,
	mergeGuards,
	ownKeys,
	truthiness,
	UNDEFINED,
	UNKNOWN,
	type Value,
} from "./model.js";
import { switchStatement } from "./switches.js";
import { hasModifier, isModuleScoped, nameOfDeclaration, unwrapExpression } from "./symbols.js";
import type { Step, Walker } from "./walker.js";

////////////////////////////////
//  Statements

export function* statements(w: Walker, list: readonly ts.Statement[], frame: Frame, flow: Flow): Step<void> {
	hoist(list, frame);
	for (const statement of list) {
		if (!flow.alive || w.halted) return;
		yield* walkStatement(w, statement, frame, flow);
	}
}

/**
 * Entering a block: its function declarations are set, and its `let`, `const` and class bindings are
 * new, uninitialized until their declarations run.
 */
function hoist(list: readonly ts.Statement[], frame: Frame): void {
	const fresh = (name: ts.BindingName, binding: ts.Node): void => {
		frame.vars.delete(binding);
		if (ts.isIdentifier(name)) return;
		for (const element of name.elements) if (ts.isBindingElement(element)) fresh(element.name, element);
	};
	for (const statement of list) {
		if (ts.isFunctionDeclaration(statement) && statement.body !== undefined && !isModuleScoped(statement))
			frame.vars.set(statement, { kind: "function", node: statement, scope: frame });
		else if (ts.isClassDeclaration(statement)) frame.vars.delete(statement);
		else if (
			ts.isVariableStatement(statement) &&
			(statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
		)
			for (const declaration of statement.declarationList.declarations) fresh(declaration.name, declaration);
	}
}

function* walkStatement(w: Walker, node: ts.Statement, frame: Frame, flow: Flow, label?: string): Step<void> {
	yield* w.step();
	if (!flow.alive || w.halted) return;
	switch (node.kind) {
		case ts.SyntaxKind.VariableStatement: {
			const statement = node as ts.VariableStatement;
			if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return;
			yield* variables(w, statement.declarationList, frame, flow);
			return;
		}
		case ts.SyntaxKind.ExpressionStatement:
			yield* w.expr((node as ts.ExpressionStatement).expression, frame, flow);
			return;
		case ts.SyntaxKind.IfStatement:
			yield* ifStatement(w, node as ts.IfStatement, frame, flow);
			return;
		case ts.SyntaxKind.Block:
			yield* statements(w, (node as ts.Block).statements, frame, flow);
			return;
		case ts.SyntaxKind.ReturnStatement: {
			const expression = (node as ts.ReturnStatement).expression;
			const value = expression === undefined ? UNDEFINED : yield* w.expr(expression, frame, flow);
			if (!flow.alive) return;
			flow.exits.push({ kind: "return", guards: [...flow.guards], maybe: false, value });
			flow.alive = false;
			return;
		}
		case ts.SyntaxKind.ThrowStatement:
			yield* w.expr((node as ts.ThrowStatement).expression, frame, flow);
			if (flow.alive) w.throwExit(flow, false);
			return;
		case ts.SyntaxKind.BreakStatement:
		case ts.SyntaxKind.ContinueStatement: {
			const jump = node as ts.BreakOrContinueStatement;
			flow.exits.push({
				kind: node.kind === ts.SyntaxKind.BreakStatement ? "break" : "continue",
				label: jump.label?.text,
				guards: [...flow.guards],
				maybe: false,
			});
			flow.alive = false;
			return;
		}
		case ts.SyntaxKind.WhileStatement:
		case ts.SyntaxKind.DoStatement:
		case ts.SyntaxKind.ForStatement:
			yield* loop(w, node as ts.IterationStatement, frame, flow, label);
			return;
		case ts.SyntaxKind.ForOfStatement:
		case ts.SyntaxKind.ForInStatement:
			yield* iteration(w, node as ts.ForOfStatement | ts.ForInStatement, frame, flow, label);
			return;
		case ts.SyntaxKind.LabeledStatement:
			yield* labeled(w, node as ts.LabeledStatement, frame, flow);
			return;
		case ts.SyntaxKind.SwitchStatement:
			yield* switchStatement(w, node as ts.SwitchStatement, frame, flow, label);
			return;
		case ts.SyntaxKind.TryStatement:
			yield* tryStatement(w, node as ts.TryStatement, frame, flow);
			return;
		case ts.SyntaxKind.FunctionDeclaration:
			exportNamespaceFunction(w, node as ts.FunctionDeclaration, frame, flow);
			return;
		case ts.SyntaxKind.ClassDeclaration:
			yield* classDeclaration(w, node as ts.ClassDeclaration, frame, flow);
			return;
		case ts.SyntaxKind.EnumDeclaration:
			yield* enumDeclaration(w, node as ts.EnumDeclaration, frame, flow);
			return;
		case ts.SyntaxKind.ModuleDeclaration:
			yield* namespaceDeclaration(w, node as ts.ModuleDeclaration, frame, flow);
			return;
		case ts.SyntaxKind.ImportDeclaration:
		case ts.SyntaxKind.ExportDeclaration:
		case ts.SyntaxKind.ImportEqualsDeclaration:
		case ts.SyntaxKind.ExportAssignment:
			yield* moduleStatement(w, node, frame, flow);
			return;
		case ts.SyntaxKind.EmptyStatement:
		case ts.SyntaxKind.DebuggerStatement:
		case ts.SyntaxKind.InterfaceDeclaration:
		case ts.SyntaxKind.TypeAliasDeclaration:
		case ts.SyntaxKind.NamespaceExportDeclaration:
			return;
		default:
			// `with` and anything else unmodeled: its reads are unknown.
			yield* opaqueStatement(w, node, frame, flow);
	}
}

/** Walks a statement the model cannot place, so its effects count as possible and its reads unknown. */
function* opaqueStatement(w: Walker, node: ts.Statement, frame: Frame, flow: Flow): Step<void> {
	w.unseen(node);
	const inner = w.branch(flow, { sources: new Set(), opaque: true, conditional: true });
	const body = ts.isWithStatement(node) ? node.statement : undefined;
	if (body !== undefined) yield* walkStatement(w, body, frame, inner);
	w.join(flow, flow.guards, [inner], true);
}

/** An exported function inside a namespace is assigned to it where its declaration stands. */
function exportNamespaceFunction(w: Walker, node: ts.FunctionDeclaration, frame: Frame, flow: Flow): void {
	if (!hasModifier(node, ts.SyntaxKind.ExportKeyword) || node.body === undefined) return;
	const namespace = w.namespaceOf(frame, node);
	if (namespace === undefined) return;
	const value = frame.vars.get(node) ?? { kind: "function", node, scope: frame };
	w.setProp(namespace, nameOfDeclaration(node), value, flow);
}

function* variables(w: Walker, list: ts.VariableDeclarationList, frame: Frame, flow: Flow): Step<void> {
	if ((list.flags & ts.NodeFlags.Using) !== 0) w.unseen(list);
	for (const declaration of list.declarations) {
		const initializer = declaration.initializer;
		const value = initializer === undefined ? UNDEFINED : yield* w.expr(initializer, frame, flow);
		if (!flow.alive) return;
		const exact = initializer !== undefined && ts.isArrayLiteralExpression(unwrapExpression(initializer));
		yield* bindPattern(w, declaration.name, value, declaration, frame, flow, exact);
	}
}

/** Binds a declaration's name or pattern, reading each destructured property as it goes. */
export function* bindPattern(
	w: Walker,
	name: ts.BindingName,
	value: Value,
	binding: ts.Node,
	frame: Frame,
	flow: Flow,
	exact = false,
): Step<void> {
	if (ts.isIdentifier(name)) {
		w.initialize(binding, value, frame, flow);
		return;
	}
	if (ts.isObjectBindingPattern(name)) {
		// Destructuring null or undefined throws before reading anything.
		if (isNullish(value)) {
			w.throwExit(flow, false);
			return;
		}
		// The keys the elements so far took, which a rest element leaves out; undefined once one has no name.
		let taken: Set<string> | undefined = new Set();
		for (const element of name.elements) {
			if (!flow.alive) return;
			if (element.dotDotDotToken !== undefined) {
				const copied = yield* objectRest(w, value, taken, name, frame, flow);
				yield* bindPattern(w, element.name, copied, element, frame, flow);
				continue;
			}
			const key = element.propertyName ?? element.name;
			let property: Value = UNKNOWN;
			if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key)) {
				property = yield* readMember(w, value, key.text, key, frame, flow);
				taken?.add(key.text);
			} else if (ts.isComputedPropertyName(key)) {
				yield* w.expr(key.expression, frame, flow);
				w.note(key);
				taken = undefined;
			}
			const bound = yield* withDefault(w, property, element.initializer, frame, flow);
			yield* bindPattern(w, element.name, bound, element, frame, flow);
		}
		return;
	}
	// An array pattern iterates: only a literal's elements are known.
	const known = exact && value.kind === "array" ? value.elements : undefined;
	if (known === undefined) w.unseen(name);
	for (const [at, element] of name.elements.entries()) {
		if (!flow.alive || ts.isOmittedExpression(element)) continue;
		let item: Value = UNKNOWN;
		if (known !== undefined)
			item =
				element.dotDotDotToken === undefined
					? (known[at] ?? UNDEFINED)
					: { kind: "array", elements: known.slice(at) };
		const bound = yield* withDefault(w, item, element.initializer, frame, flow);
		yield* bindPattern(w, element.name, bound, element, frame, flow, known !== undefined);
	}
}

/**
 * An object rest: a new object with every own enumerable property the other elements did not take,
 * each getter run. Unknown when the walk cannot name what they took.
 */
export function* objectRest(
	w: Walker,
	value: Value,
	taken: ReadonlySet<string> | undefined,
	node: ts.Node,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	if (taken === undefined) {
		w.unseen(node);
		return UNKNOWN;
	}
	const object = w.newObject({ label: "object", base: [...flow.guards] });
	yield* copyOwn(w, value, object, taken, node, frame, flow);
	return { kind: "object", id: object.id };
}

/** A default runs for a missing or literal undefined value; for an unknown one, it may. */
export function* withDefault(
	w: Walker,
	value: Value,
	initializer: ts.Expression | undefined,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	if (initializer === undefined) return value;
	if (value.kind === "literal" && value.value === undefined) return yield* w.expr(initializer, frame, flow);
	if (value.kind !== "unknown") return value;
	const maybe = w.branch(flow, { sources: new Set(), opaque: true, conditional: true });
	yield* w.expr(initializer, frame, maybe);
	w.join(flow, flow.guards, [maybe], true);
	return UNKNOWN;
}

function* ifStatement(w: Walker, node: ts.IfStatement, frame: Frame, flow: Flow): Step<void> {
	const condition = yield* w.expr(node.expression, frame, flow);
	if (!flow.alive) return;
	const truth = truthiness(condition);
	if (truth === true) return yield* walkStatement(w, node.thenStatement, frame, flow);
	if (truth === false) {
		if (node.elseStatement !== undefined) yield* walkStatement(w, node.elseStatement, frame, flow);
		return;
	}
	const base = [...flow.guards];
	const guard = w.guard(condition, node.expression, flow);
	const then = w.branch(flow, guard);
	yield* walkStatement(w, node.thenStatement, frame, then);
	const otherwise = w.branch(flow, guard);
	if (node.elseStatement !== undefined) yield* walkStatement(w, node.elseStatement, frame, otherwise);
	w.join(flow, base, [then, otherwise], false);
}

/** Splits a loop body's exits into its own breaks and continues and those that leave it. */
function loopExits(exits: readonly Exit[], label: string | undefined) {
	const own = (exit: Exit) => exit.label === undefined || exit.label === label;
	return {
		breaks: exits.filter((exit) => exit.kind === "break" && own(exit)),
		continues: exits.filter((exit) => exit.kind === "continue" && own(exit)),
		rest: exits.filter((exit) => !((exit.kind === "break" || exit.kind === "continue") && own(exit))),
	};
}

function* loop(w: Walker, node: ts.IterationStatement, frame: Frame, flow: Flow, label?: string): Step<void> {
	const base = [...flow.guards];
	let condition: ts.Expression | undefined;
	if (ts.isForStatement(node)) {
		const head = node.initializer;
		if (head !== undefined) {
			if (ts.isVariableDeclarationList(head)) yield* variables(w, head, frame, flow);
			else yield* w.expr(head, frame, flow);
		}
		condition = node.condition;
	} else if (ts.isWhileStatement(node)) condition = node.expression;
	if (!flow.alive) return;
	const isDo = ts.isDoStatement(node);
	let truth: boolean | undefined = true;
	let tested: Value = UNDEFINED;
	if (!isDo && condition !== undefined) {
		tested = yield* w.expr(condition, frame, flow);
		truth = truthiness(tested);
		if (!flow.alive || truth === false) return;
	}
	const guard = truth === undefined && condition !== undefined ? w.guard(tested, condition, flow) : undefined;
	const body: Flow = {
		alive: true,
		guards: [...flow.guards, ...(guard === undefined ? [] : [guard]), repeated()],
		exits: [],
	};
	yield* walkStatement(w, node.statement, frame, body);
	const { breaks, continues, rest } = loopExits(body.exits, label);
	const repeats = body.alive || continues.length > 0;
	if (repeats && ts.isForStatement(node) && node.incrementor !== undefined) {
		const after = w.branch(body);
		after.alive = true;
		yield* w.expr(node.incrementor, frame, after);
		rest.push(...after.exits);
	}
	// A do body runs once; without a normal end, only a break leaves it.
	let ends = !isDo || repeats;
	if (isDo && repeats && ts.isDoStatement(node)) {
		const after: Flow = { alive: true, guards: [...body.guards], exits: [] };
		truth = truthiness(yield* w.expr(node.expression, frame, after));
		rest.push(...after.exits);
		ends = after.alive;
	}
	flow.exits.push(...rest);
	// A loop whose condition holds leaves only through a break; the paths around it never arrive.
	const around: Array<Pick<Exit, "guards" | "kind">> =
		truth === true && repeats
			? [...continues, ...(body.alive ? [{ guards: body.guards, kind: "continue" as const }] : [])]
			: [];
	flow.alive = (ends && truth !== true) || breaks.length > 0;
	flow.guards = w.dependent(base, [...rest, ...around]);
}

/**
 * The values a `for of` over an array literal or a string, or a `for in` over an object literal or a
 * primitive, binds; undefined otherwise.
 */
function literalItems(node: ts.ForOfStatement | ts.ForInStatement, iterable: Value): Value[] | undefined {
	const held = unwrapExpression(node.expression);
	if (iterable.kind === "literal") {
		const text = typeof iterable.value === "string" ? iterable.value : undefined;
		// A string iterates its code points, and its keys are its indices; other primitives have none.
		if (ts.isForOfStatement(node)) return text === undefined ? undefined : [...text].map(literal);
		return text === undefined ? [] : [...text.split("").keys()].map((at) => literal(String(at)));
	}
	if (ts.isForOfStatement(node)) {
		// A spread inside the literal may add any number of elements.
		if (!ts.isArrayLiteralExpression(held) || held.elements.some(ts.isSpreadElement)) return undefined;
		return iterable.kind === "array" ? [...iterable.elements] : undefined;
	}
	if (!ts.isObjectLiteralExpression(held)) return undefined;
	const names: string[] = [];
	for (const property of held.properties) {
		// A spread, a computed name or a prototype makes the keys something the walk cannot list.
		if (ts.isSpreadAssignment(property)) return undefined;
		const name = property.name;
		if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) return undefined;
		if (ts.isPropertyAssignment(property) && name.text === "__proto__") return undefined;
		names.push(name.text);
	}
	return ownKeys(names).map((key) => literal(key));
}

/** A loop body the walk follows once, though it may run again. */
function repeated(): Guard {
	return { sources: new Set(), opaque: false, conditional: false, repeats: true };
}

/**
 * `for of` and `for in`: over a literal, the body runs once per item with the variable bound to it,
 * up to a limit; past it, or over anything else, the variable is unknown.
 */
function* iteration(
	w: Walker,
	node: ts.ForOfStatement | ts.ForInStatement,
	frame: Frame,
	flow: Flow,
	label?: string,
): Step<void> {
	const base = [...flow.guards];
	const iterable = yield* w.expr(node.expression, frame, flow);
	if (!flow.alive) return;
	if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
		flow.exits.push({ kind: "await", guards: [...flow.guards], maybe: false });
		flow.alive = false;
		return;
	}
	const items = literalItems(node, iterable);
	if (items?.length === 0) return;
	if (items === undefined) w.unseen(node.expression);
	// Past the limit, the body is followed once with the variable unknown, though it runs again.
	const known = items !== undefined && items.length <= MAX_ITERATIONS;
	const rounds = known ? items : [UNKNOWN];
	const leaving: Exit[] = [];
	let broke = false;
	const unseen: Guard = { sources: new Set(), opaque: true, conditional: true };
	let guards: Guard[] = [...base, ...(items === undefined ? [unseen] : []), ...(known ? [] : [repeated()])];
	let alive = true;
	for (const item of rounds) {
		const body: Flow = { alive: true, guards: [...guards], exits: [] };
		yield* bind(w, node.initializer, item, frame, body);
		if (body.alive) yield* walkStatement(w, node.statement, frame, body);
		const { breaks, continues, rest } = loopExits(body.exits, label);
		leaving.push(...rest);
		if (breaks.length > 0) broke = true;
		alive = body.alive || continues.length > 0;
		if (!alive) break;
		// The next item runs only on paths no exit left.
		guards = w.dependent(guards, [...rest, ...breaks]);
	}
	flow.exits.push(...leaving);
	// Over a literal the last item's end, or a break, ends the loop; over anything else it may not run at all.
	flow.alive = items === undefined || alive || broke;
	flow.guards = w.dependent(base, leaving);
}

/** Binds a `for of` or `for in` head to one item. */
function* bind(w: Walker, head: ts.ForInitializer, item: Value, frame: Frame, flow: Flow): Step<void> {
	if (ts.isVariableDeclarationList(head)) {
		for (const declaration of head.declarations)
			yield* bindPattern(w, declaration.name, item, declaration, frame, flow);
	} else yield* w.assignTo(head, item, frame, flow);
}

function* labeled(w: Walker, node: ts.LabeledStatement, frame: Frame, flow: Flow): Step<void> {
	const label = node.label.text;
	const base = [...flow.guards];
	const inner = w.branch(flow);
	yield* walkStatement(w, node.statement, frame, inner, label);
	const breaks = inner.exits.filter((exit) => exit.kind === "break" && exit.label === label);
	const rest = inner.exits.filter((exit) => !breaks.includes(exit));
	flow.exits.push(...rest);
	flow.alive = inner.alive || breaks.length > 0;
	flow.guards = w.dependent(base, rest);
}

/**
 * Case tests run in order until one matches; the body runs from there, falling through. While
 * each test folds, the walk follows exactly that; from the first that does not, every clause left
 * runs under a guard.
 */
function* tryStatement(w: Walker, node: ts.TryStatement, frame: Frame, flow: Flow): Step<void> {
	const base = [...flow.guards];
	const handler = node.catchClause;
	// Inside a try with a catch, a throw resumes after it, so writes there may not happen.
	const region: Guard = { sources: new Set(), opaque: false, conditional: true, catches: true };
	const attempt = w.branch(flow, handler === undefined ? undefined : region);
	yield* statements(w, node.tryBlock.statements, frame, attempt);
	const throws = handler === undefined ? [] : attempt.exits.filter((exit) => exit.kind === "throw");
	const leaving = attempt.exits.filter((exit) => !throws.includes(exit));
	let caught: Flow | undefined;
	if (handler !== undefined && throws.length > 0) {
		const certain = throws.filter((exit) => !exit.maybe);
		const inner = base.length + 1;
		const extra = (certain.length > 0 ? certain : throws).flatMap((exit) => exit.guards.slice(inner));
		const guards = [...base];
		if (certain.length === 0) guards.push({ sources: new Set(), opaque: true, conditional: true });
		else if (extra.length > 0) guards.push(mergeGuards(extra));
		caught = { alive: true, guards, exits: [] };
		const variable = handler.variableDeclaration;
		if (variable !== undefined) yield* bindPattern(w, variable.name, UNKNOWN, variable, frame, caught);
		yield* statements(w, handler.block.statements, frame, caught);
		leaving.push(...caught.exits);
	}
	const alive = attempt.alive || caught?.alive === true;
	if (node.finallyBlock !== undefined) {
		const final: Flow = { alive: true, guards: [...base], exits: [] };
		yield* statements(w, node.finallyBlock.statements, frame, final);
		flow.exits.push(...final.exits);
		if (!final.alive) {
			flow.alive = false;
			return;
		}
	}
	flow.exits.push(...leaving);
	flow.alive = alive;
	flow.guards = w.dependent(base, leaving);
}
