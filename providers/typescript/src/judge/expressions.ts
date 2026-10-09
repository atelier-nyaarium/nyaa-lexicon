// Expressions: what each evaluates to at load, and which reads and calls it makes on the way.

import ts from "typescript";
import { classExpression } from "./definitions.js";
import { canNullish, canPresent, eitherPresent } from "./domains.js";
import { requireCall } from "./loader.js";
import { copyOwn, readMember } from "./members.js";
import {
	DEFERRED,
	type Flow,
	type Frame,
	held,
	isNullish,
	isObject,
	joinValues,
	literal,
	provOf,
	typeofValue,
	UNDEFINED,
	UNKNOWN,
	underGuards,
	type Value,
} from "./model.js";
import { awaitExpression, binary, conditionalExpression, deleteExpression, template, unary } from "./operators.js";
import { conditionSymbols, hasModifier, unwrapExpression } from "./symbols.js";
import type { Args, ChainGuard, Step, Walker } from "./walker.js";
import { isAssigned } from "./writes.js";

////////////////////////////////
//  Constants

/** Members that let a function be called with another `this`. */
const FUNCTION_CALLS = new Set(["call", "apply"]);

////////////////////////////////
//  Functions & Helpers

/** A bigint literal's value; its text ends in `n`. */
function bigint(text: string): Value {
	try {
		return literal(BigInt(text.slice(0, -1)));
	} catch {
		return UNKNOWN;
	}
}

/** The outermost node of an optional chain, which a short circuit skips to the end of. */
function outermostChain(node: ts.Expression): boolean {
	if (!ts.isOptionalChain(node)) return false;
	const parent = node.parent;
	const continues =
		(ts.isPropertyAccessExpression(parent) ||
			ts.isElementAccessExpression(parent) ||
			ts.isCallExpression(parent) ||
			ts.isNonNullExpression(parent)) &&
		parent.expression === node &&
		ts.isOptionalChain(parent);
	return !continues;
}

////////////////////////////////
//  Evaluation

/** An expression's value, depending on what the values of the operands it evaluated came from. */
export function* evaluate(w: Walker, node: ts.Expression, frame: Frame, flow: Flow): Step<Value> {
	w.openExpression();
	let value: Value = UNKNOWN;
	try {
		value = yield* evaluateNode(w, node, frame, flow);
	} finally {
		value = w.closeExpression(value);
	}
	return value;
}

function* evaluateNode(w: Walker, node: ts.Expression, frame: Frame, flow: Flow): Step<Value> {
	yield* w.step();
	if (!flow.alive || w.halted) return UNKNOWN;
	if (outermostChain(node)) return yield* optionalChain(w, node, frame, flow);
	if (w.chain?.cut === true) return UNDEFINED;
	switch (node.kind) {
		case ts.SyntaxKind.NumericLiteral:
			return literal(Number((node as ts.NumericLiteral).text));
		case ts.SyntaxKind.BigIntLiteral:
			return bigint((node as ts.BigIntLiteral).text);
		case ts.SyntaxKind.StringLiteral:
		case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
			return literal((node as ts.StringLiteralLike).text);
		case ts.SyntaxKind.TrueKeyword:
			return literal(true);
		case ts.SyntaxKind.FalseKeyword:
			return literal(false);
		case ts.SyntaxKind.NullKeyword:
			return literal(null);
		case ts.SyntaxKind.Identifier:
			return yield* w.read(node as ts.Identifier, frame, flow);
		case ts.SyntaxKind.ThisKeyword:
			return thisOf(w, frame, flow);
		case ts.SyntaxKind.ParenthesizedExpression:
		case ts.SyntaxKind.AsExpression:
		case ts.SyntaxKind.SatisfiesExpression:
		case ts.SyntaxKind.NonNullExpression:
		case ts.SyntaxKind.TypeAssertionExpression:
		case ts.SyntaxKind.PartiallyEmittedExpression:
			return yield* evaluate(w, (node as ts.ParenthesizedExpression).expression, frame, flow);
		case ts.SyntaxKind.PropertyAccessExpression:
			return yield* propertyAccess(w, node as ts.PropertyAccessExpression, frame, flow);
		case ts.SyntaxKind.ElementAccessExpression:
			return yield* elementAccess(w, node as ts.ElementAccessExpression, frame, flow);
		case ts.SyntaxKind.CallExpression:
			return yield* call(w, node as ts.CallExpression, frame, flow);
		case ts.SyntaxKind.NewExpression:
			return yield* newExpression(w, node as ts.NewExpression, frame, flow);
		case ts.SyntaxKind.TaggedTemplateExpression:
			return yield* taggedTemplate(w, node as ts.TaggedTemplateExpression, frame, flow);
		case ts.SyntaxKind.TemplateExpression:
			return yield* template(w, node as ts.TemplateExpression, frame, flow);
		case ts.SyntaxKind.BinaryExpression:
			return yield* binary(w, node as ts.BinaryExpression, frame, flow);
		case ts.SyntaxKind.PrefixUnaryExpression:
		case ts.SyntaxKind.PostfixUnaryExpression:
			return yield* unary(w, node as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression, frame, flow);
		case ts.SyntaxKind.ConditionalExpression:
			return yield* conditionalExpression(w, node as ts.ConditionalExpression, frame, flow);
		case ts.SyntaxKind.FunctionExpression:
		case ts.SyntaxKind.ArrowFunction:
			return { kind: "function", node: node as ts.FunctionExpression | ts.ArrowFunction, scope: frame };
		case ts.SyntaxKind.ClassExpression:
			return yield* classExpression(w, node as ts.ClassExpression, frame, flow);
		case ts.SyntaxKind.ObjectLiteralExpression:
			return yield* objectLiteral(w, node as ts.ObjectLiteralExpression, frame, flow);
		case ts.SyntaxKind.ArrayLiteralExpression:
			return yield* arrayLiteral(w, node as ts.ArrayLiteralExpression, frame, flow);
		case ts.SyntaxKind.AwaitExpression:
			return yield* awaitExpression(w, node as ts.AwaitExpression, frame, flow);
		case ts.SyntaxKind.TypeOfExpression: {
			const value = yield* evaluate(w, (node as ts.TypeOfExpression).expression, frame, flow);
			// An ECMAScript module has a `require` only where its host gives one.
			if (value.kind === "builtin" && value.name === "require" && w.runtime === "esm") return UNKNOWN;
			return typeofValue(value);
		}
		case ts.SyntaxKind.VoidExpression:
			yield* evaluate(w, (node as ts.VoidExpression).expression, frame, flow);
			return UNDEFINED;
		case ts.SyntaxKind.DeleteExpression:
			return yield* deleteExpression(w, node as ts.DeleteExpression, frame, flow);
		case ts.SyntaxKind.OmittedExpression:
			return UNDEFINED;
		case ts.SyntaxKind.MetaProperty:
		case ts.SyntaxKind.SuperKeyword:
		case ts.SyntaxKind.RegularExpressionLiteral:
			return UNKNOWN;
		default:
			// JSX, `yield` and the rest: outside the model.
			w.unseen(node);
			return UNKNOWN;
	}
}

/** `this`: in a derived constructor before `super()` returns, a ReferenceError. */
function thisOf(w: Walker, frame: Frame, flow: Flow): Value {
	let scope: Frame | null = frame;
	while (scope?.fn !== null && scope?.fn !== undefined && ts.isArrowFunction(scope.fn)) scope = scope.parent;
	const state = scope?.thisInit?.state;
	if (state === "no") {
		w.throwExit(flow, false);
		return UNKNOWN;
	}
	if (state === "maybe") w.throwExit(flow, true);
	return frame.thisValue;
}

/**
 * An optional chain runs only when every `?.` receiver is present. The walk follows it under a guard
 * that takes effect, with what the receiver came from, once a receiver may be absent.
 */
function* optionalChain(w: Walker, node: ts.Expression, frame: Frame, flow: Flow): Step<Value> {
	const saved = w.chain;
	const guard: ChainGuard = { sources: new Set(), opaque: false, conditional: false };
	const chain = { cut: false, guard };
	w.chain = chain;
	const base = [...flow.guards];
	const inner = w.branch(flow, guard);
	let value: Value;
	try {
		value = yield* evaluateChain(w, node, frame, inner);
	} finally {
		w.chain = saved;
	}
	w.join(flow, base, [inner], true);
	if (chain.cut) return UNDEFINED;
	if (!guard.conditional) return value;
	for (const symbol of conditionSymbols(w.checker, node)) guard.sources.add(symbol);
	return underGuards(joinValues(value, UNDEFINED), [guard]);
}

function* evaluateChain(w: Walker, node: ts.Expression, frame: Frame, flow: Flow): Step<Value> {
	switch (node.kind) {
		case ts.SyntaxKind.PropertyAccessExpression:
			return yield* propertyAccess(w, node as ts.PropertyAccessExpression, frame, flow);
		case ts.SyntaxKind.ElementAccessExpression:
			return yield* elementAccess(w, node as ts.ElementAccessExpression, frame, flow);
		case ts.SyntaxKind.CallExpression:
			return yield* call(w, node as ts.CallExpression, frame, flow);
		case ts.SyntaxKind.NonNullExpression:
			return yield* evaluateChain(w, (node as ts.NonNullExpression).expression, frame, flow);
		default:
			return yield* evaluate(w, node, frame, flow);
	}
}

/**
 * Short-circuits the enclosing chain when an optional receiver is null or undefined. One that may be
 * makes the chain's guard take effect, depending on what the receiver came from.
 */
function cuts(w: Walker, node: ts.Node, receiver: Value): boolean {
	const optional = (node as { questionDotToken?: ts.Node }).questionDotToken !== undefined;
	const chain = w.chain;
	if (!optional || chain === undefined) return false;
	if (isNullish(receiver)) {
		chain.cut = true;
		return true;
	}
	if (receiver.kind === "unknown") {
		const domain = receiver.domain;
		// An input's domain may decide it: always absent, or never.
		if (domain !== undefined && !canPresent(domain)) {
			chain.cut = true;
			return true;
		}
		if (domain !== undefined && !canNullish(domain)) return false;
		const prov = provOf(receiver);
		for (const source of prov.sources) chain.guard.sources.add(source);
		// Absent or not either way only for an input whose type admits both.
		chain.guard.opaque ||= prov.opaque || domain === undefined || !eitherPresent(domain);
		chain.guard.conditional = true;
	}
	return false;
}

function* propertyAccess(w: Walker, node: ts.PropertyAccessExpression, frame: Frame, flow: Flow): Step<Value> {
	if (node.expression.kind === ts.SyntaxKind.SuperKeyword)
		return yield* superMember(w, node.name.text, node.name, frame, flow);
	const receiver = yield* evaluateChain(w, node.expression, frame, flow);
	if (!flow.alive || w.chain?.cut === true || cuts(w, node, receiver)) return UNDEFINED;
	return yield* readMember(w, receiver, node.name.text, node.name, frame, flow);
}

function* elementAccess(w: Walker, node: ts.ElementAccessExpression, frame: Frame, flow: Flow): Step<Value> {
	if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
		const key = yield* w.keyOf(node.argumentExpression, frame, flow);
		if (!flow.alive) return UNKNOWN;
		return yield* superMember(w, key, node.argumentExpression, frame, flow);
	}
	const receiver = yield* evaluateChain(w, node.expression, frame, flow);
	if (!flow.alive || w.chain?.cut === true || cuts(w, node, receiver)) return UNDEFINED;
	const key = yield* w.keyOf(node.argumentExpression, frame, flow);
	if (!flow.alive) return UNKNOWN;
	return yield* readMember(w, receiver, key, node.argumentExpression, frame, flow);
}

/**
 * `super[key]`: the lookup starts at the base of the class the reference sits in, at its statics
 * from a static member. A getter it runs gets `this` as its receiver.
 */
function* superMember(w: Walker, key: string | undefined, node: ts.Node, frame: Frame, flow: Flow): Step<Value> {
	const element = ts.findAncestor(node, (at) => ts.isClassElement(at) && ts.isClassLike(at.parent));
	const owner = element === undefined ? undefined : w.classes.get(element.parent);
	const base = owner === undefined ? undefined : w.bases.get(owner.id);
	if (element === undefined || key === undefined || base === undefined || base === null || base.kind !== "class") {
		w.unseen(node);
		return UNKNOWN;
	}
	const statics = ts.isClassStaticBlockDeclaration(element) || hasModifier(element, ts.SyntaxKind.StaticKeyword);
	const home: Value = statics ? base : { kind: "prototype", owner: base };
	const self = thisOf(w, frame, flow);
	if (!flow.alive) return UNKNOWN;
	return yield* readMember(w, home, key, node, frame, flow, self);
}

////////////////////////////////
//  Calls

function* evaluateArguments(
	w: Walker,
	nodes: readonly ts.Expression[] | undefined,
	frame: Frame,
	flow: Flow,
): Step<Args> {
	const values: Value[] = [];
	for (const node of nodes ?? []) {
		if (!flow.alive) break;
		if (ts.isSpreadElement(node)) {
			const spread = unwrapExpression(node.expression);
			const value = yield* evaluate(w, node.expression, frame, flow);
			if (ts.isArrayLiteralExpression(spread) && value.kind === "array") {
				values.push(...value.elements);
				continue;
			}
			// Spreading anything else runs its iterator.
			w.unseen(node);
			return { values, open: true };
		}
		values.push(yield* evaluate(w, node, frame, flow));
	}
	return { values, open: false };
}

/** Whether the program assigns what the callee expression names, through its binding or property. */
function siteReplaced(w: Walker, callee: ts.Expression): boolean {
	const name = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined;
	if (name === undefined) return false;
	const symbol = w.checker.getSymbolAtLocation(name);
	return (symbol?.declarations ?? []).some((declaration) => isAssigned(w.writes, declaration, name.text));
}

function* call(w: Walker, node: ts.CallExpression, frame: Frame, flow: Flow): Step<Value> {
	const callee = unwrapExpression(node.expression);
	if (callee.kind === ts.SyntaxKind.SuperKeyword) return yield* w.superConstruct(node, frame, flow);
	if (callee.kind === ts.SyntaxKind.ImportKeyword) {
		// A dynamic import loads after the current job.
		yield* evaluateArguments(w, node.arguments, frame, flow);
		return DEFERRED;
	}
	let target: Value;
	let thisValue: Value = UNDEFINED;
	if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
		if (callee.expression.kind === ts.SyntaxKind.SuperKeyword) {
			target = yield* evaluate(w, callee, frame, flow);
			thisValue = frame.thisValue;
		} else {
			const receiver = yield* evaluateChain(w, callee.expression, frame, flow);
			if (!flow.alive || w.chain?.cut === true || cuts(w, callee, receiver)) return UNDEFINED;
			const key = ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: yield* w.keyOf(callee.argumentExpression, frame, flow);
			if (
				(receiver.kind === "function" || receiver.kind === "class") &&
				key !== undefined &&
				FUNCTION_CALLS.has(key) &&
				!w.hooked(receiver)
			)
				return yield* callWith(w, receiver, key, node, frame, flow);
			const keyNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee.argumentExpression;
			target = yield* readMember(w, receiver, key, keyNode, frame, flow);
			thisValue = receiver;
		}
	} else target = yield* evaluateChain(w, node.expression, frame, flow);
	if (!flow.alive || w.chain?.cut === true || cuts(w, node, target)) return UNDEFINED;
	const args = yield* evaluateArguments(w, node.arguments, frame, flow);
	if (!flow.alive) return UNKNOWN;
	if (target.kind === "builtin" && target.name === "require") return yield* requireCall(w, node, args, frame, flow);
	return yield* w.invoke(target, thisValue, args, node, frame, flow, siteReplaced(w, callee));
}

/** `f.call(self, ...args)` and `f.apply(self, [args])`: the same function with another `this`. */
function* callWith(
	w: Walker,
	callee: Value,
	key: string,
	node: ts.CallExpression,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	const args = yield* evaluateArguments(w, node.arguments, frame, flow);
	const [self = UNDEFINED, ...rest] = args.values;
	if (key === "call") return yield* w.invoke(callee, self, { values: rest, open: args.open }, node, frame, flow);
	const list = node.arguments[1] === undefined ? undefined : unwrapExpression(node.arguments[1]);
	const spread = rest[0];
	if (list === undefined) return yield* w.invoke(callee, self, { values: [], open: false }, node, frame, flow);
	if (ts.isArrayLiteralExpression(list) && spread?.kind === "array")
		return yield* w.invoke(callee, self, { values: spread.elements, open: false }, node, frame, flow);
	w.note(node);
	return yield* w.invoke(callee, self, { values: [], open: true }, node, frame, flow);
}

function* newExpression(w: Walker, node: ts.NewExpression, frame: Frame, flow: Flow): Step<Value> {
	const target = yield* evaluate(w, node.expression, frame, flow);
	if (!flow.alive) return UNKNOWN;
	const args = yield* evaluateArguments(w, node.arguments, frame, flow);
	if (!flow.alive) return UNKNOWN;
	return yield* w.invoke(
		target,
		UNDEFINED,
		args,
		node,
		frame,
		flow,
		siteReplaced(w, unwrapExpression(node.expression)),
	);
}

function* taggedTemplate(w: Walker, node: ts.TaggedTemplateExpression, frame: Frame, flow: Flow): Step<Value> {
	const tag = yield* evaluate(w, node.tag, frame, flow);
	const values: Value[] = [UNKNOWN];
	if (ts.isTemplateExpression(node.template)) {
		for (const span of node.template.templateSpans) values.push(yield* evaluate(w, span.expression, frame, flow));
	}
	if (!flow.alive) return UNKNOWN;
	return yield* w.invoke(
		tag,
		UNDEFINED,
		{ values, open: false },
		node,
		frame,
		flow,
		siteReplaced(w, unwrapExpression(node.tag)),
	);
}

////////////////////////////////
//  Literals

function* propertyKey(w: Walker, name: ts.PropertyName, frame: Frame, flow: Flow): Step<string | undefined> {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name))
		return name.text;
	if (ts.isComputedPropertyName(name)) return yield* w.keyOf(name.expression, frame, flow);
	return undefined;
}

/** `__proto__: value` in a literal sets its prototype rather than a property. */
function prototypeOf(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
	if (!ts.isPropertyAssignment(property)) return undefined;
	const name = property.name;
	return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "__proto__"
		? property.initializer
		: undefined;
}

function* objectLiteral(w: Walker, node: ts.ObjectLiteralExpression, frame: Frame, flow: Flow): Step<Value> {
	const object = w.newObject({ label: "object", base: [...flow.guards] });
	const self: Value = { kind: "object", id: object.id };
	for (const property of node.properties) {
		if (!flow.alive) return UNKNOWN;
		if (ts.isSpreadAssignment(property)) {
			const source = yield* evaluate(w, property.expression, frame, flow);
			yield* copyOwn(w, source, object, new Set(), property.expression, frame, flow);
			continue;
		}
		const prototype = prototypeOf(property);
		if (prototype !== undefined) {
			const value = yield* evaluate(w, prototype, frame, flow);
			// Anything but an object or null leaves the prototype as it was.
			if (isObject(value) !== false || (value.kind === "literal" && value.value === null)) object.proto = value;
			continue;
		}
		const key = yield* propertyKey(w, property.name, frame, flow);
		if (key === undefined) object.open = true;
		let value: Value;
		if (ts.isPropertyAssignment(property)) value = yield* evaluate(w, property.initializer, frame, flow);
		else if (ts.isShorthandPropertyAssignment(property)) value = yield* w.read(property.name, frame, flow);
		else if (ts.isMethodDeclaration(property)) value = { kind: "function", node: property, scope: frame };
		else if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
			if (key === undefined) continue;
			const held = object.props.get(key);
			const accessor: Value = { kind: "function", node: property, scope: frame };
			object.props.set(key, {
				state: "yes",
				value: UNKNOWN,
				getter: ts.isGetAccessorDeclaration(property) ? accessor : held?.getter,
				setter: ts.isSetAccessorDeclaration(property) ? accessor : held?.setter,
			});
			continue;
		} else continue;
		if (key !== undefined) object.props.set(key, { state: "yes", value: held(value) });
	}
	return self;
}

function* arrayLiteral(w: Walker, node: ts.ArrayLiteralExpression, frame: Frame, flow: Flow): Step<Value> {
	const elements: Value[] = [];
	for (const element of node.elements) {
		if (!flow.alive) return UNKNOWN;
		if (ts.isSpreadElement(element)) {
			const inner = unwrapExpression(element.expression);
			const value = yield* evaluate(w, element.expression, frame, flow);
			if (ts.isArrayLiteralExpression(inner) && value.kind === "array") {
				elements.push(...value.elements);
				continue;
			}
			w.unseen(element);
			return UNKNOWN;
		}
		elements.push(yield* evaluate(w, element, frame, flow));
	}
	return { kind: "array", elements };
}
