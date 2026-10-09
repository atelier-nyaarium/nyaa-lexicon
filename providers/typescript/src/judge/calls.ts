// Calls: a workspace function walked with its arguments bound, or a call the walk cannot see into.

import ts from "typescript";
import { addInitializer } from "./decorators.js";
import { construct } from "./definitions.js";
import { domainOf } from "./domains.js";
import { writeMember } from "./members.js";
import {
	DEFERRED,
	EXACT,
	type Flow,
	type Frame,
	type FunctionValue,
	forget,
	free,
	GLOBAL,
	input,
	isConstructor,
	isNullish,
	isObject,
	joinValues,
	LOST,
	MAX_DEPTH,
	type Prov,
	provOf,
	UNDEFINED,
	UNKNOWN,
	underGuards,
	unionProv,
	type Value,
	withProv,
} from "./model.js";
import { argumentNode, calleeName, callSite } from "./sites.js";
import { bindPattern, statements, withDefault } from "./statements.js";
import {
	declarationOf,
	hasModifier,
	isDeferredCallee,
	isExternal,
	isPureLibrary,
	isStrict,
	nameOfDeclaration,
	typeCarriesCode,
} from "./symbols.js";
import type { Args, Step, Walker } from "./walker.js";
import { isAssigned } from "./writes.js";

////////////////////////////////
//  Calls

/** Calls a value: walks a workspace function nothing replaces, or treats a library call as opaque. */
export function* invoke(
	w: Walker,
	callee: Value,
	thisValue: Value,
	args: Args,
	site: ts.Node,
	frame: Frame,
	flow: Flow,
	replaced = false,
): Step<Value> {
	const constructs = ts.isNewExpression(site);
	// `new` on what is no constructor throws before anything runs.
	if (constructs && isConstructor(callee) === false) {
		w.throwExit(flow, false);
		return UNKNOWN;
	}
	if (callee.kind === "function") {
		if (replaced || replacedFunction(w, callee)) {
			w.unseen(site);
			escapeValues(w, args.values);
			w.throwExit(flow, true);
			return UNKNOWN;
		}
		if (!constructs) return yield* callFunction(w, callee, thisValue, args, site, flow);
		const instance: Value = { kind: "object", id: w.newObject({ label: "object", base: [...flow.guards] }).id };
		const made = yield* callFunction(w, callee, instance, args, site, flow);
		// A returned object replaces the instance; a returned primitive does not.
		const object = isObject(made);
		return object === true ? made : object === false ? instance : UNKNOWN;
	}
	if (callee.kind === "builtin" && callee.name === "addInitializer")
		return addInitializer(w, callee.gate, args, site, flow);
	if (callee.kind === "class") {
		if (replaced) {
			w.unseen(site);
			escapeValues(w, args.values);
			w.throwExit(flow, true);
			return UNKNOWN;
		}
		if (constructs) return yield* construct(w, callee, args, site, flow);
		// A class called without `new` throws.
		w.throwExit(flow, false);
		return UNKNOWN;
	}
	return opaqueCall(w, site, thisValue, args, flow, callee);
}

/** Whether the program assigns the binding or property a function value was read from. */
function replacedFunction(w: Walker, callee: FunctionValue): boolean {
	const node = callee.node;
	// Assigning an accessor's property runs its setter rather than replacing it.
	if (ts.isAccessor(node)) return false;
	const holder =
		ts.isFunctionExpression(node) || ts.isArrowFunction(node)
			? ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)
				? node.parent
				: node
			: node;
	return isAssigned(w.writes, holder, nameOfDeclaration(holder));
}

/**
 * A call the walk cannot see into: deferred, harmless, or unknown when workspace code reaches it. A
 * harmless call into the host or a package is an input read at its site. One into the language's own
 * library computes from what it was passed, so it varies only where that does. Each result depends
 * on what the call was passed, and on its callee when the checker cannot place it.
 */
export function opaqueCall(
	w: Walker,
	site: ts.Node,
	thisValue: Value,
	args: Args,
	flow: Flow,
	callee: Value = UNKNOWN,
): Value {
	const name = calleeName(site);
	const symbol = name === undefined ? undefined : w.checker.getSymbolAtLocation(name);
	if (name !== undefined && isDeferredCallee(w.pinned, w.writes, symbol, name.text)) return DEFERRED;
	const declaration = declarationOf(symbol);
	const workspace = declaration !== undefined && !isExternal(w.pinned, declaration);
	const passed = [thisValue, ...args.values];
	const carried = passed.some((value, at) => carriesCode(w, value, argumentNode(site, at - 1)));
	const evaluates = name?.text === "eval" || name?.text === "Function";
	const unseen = workspace || carried || evaluates || args.open || name === undefined;
	if (unseen) w.unseen(site);
	const inputs = contents(w, passed);
	escapeValues(w, passed);
	w.throwExit(flow, true);
	if (unseen) return UNKNOWN;
	// On nothing that varies, a computation the walk gave up on.
	if (isPureLibrary(w.pinned, symbol))
		return inputs.opaque || inputs.sources.size === 0 ? UNKNOWN : { kind: "unknown", prov: inputs };
	// A package's result is an input over its declared type; the host library's is computed from its state.
	const host = declaration !== undefined && w.pinned.program.isSourceFileDefaultLibrary(declaration.getSourceFile());
	const read = host ? free(site) : input(domainOf(w.checker.getTypeAtLocation(site)), site);
	const result = withProv(read, inputs);
	return declaration === undefined ? withProv(result, provOf(callee)) : result;
}

/**
 * The `this` a function body sees: as passed in strict code; in sloppy code, the global object in
 * place of null or undefined, and a primitive boxed into an object the walk does not track.
 */
function thisOfCall(w: Walker, node: ts.Node, thisValue: Value): Value {
	if (thisValue.kind !== "literal" || isStrict(w.pinned, node)) return thisValue;
	return isNullish(thisValue) ? GLOBAL : UNKNOWN;
}

/** What values and everything they hold came from, as a library reading them sees it. */
function contents(w: Walker, values: readonly Value[]): Prov {
	let prov = EXACT;
	const seen = new Set<number>();
	const pending = [...values];
	for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
		prov = unionProv(prov, provOf(value));
		if (value.kind === "array") {
			// Elements stored since are no longer known.
			if (value.held === true) return LOST;
			pending.push(...value.elements);
			continue;
		}
		const object = w.objectOf(value);
		if (object === undefined || seen.has(object.id)) continue;
		seen.add(object.id);
		if (object.open) return LOST;
		pending.push(...[...object.props.values()].map((prop) => prop.value));
		if (object.proto !== undefined) pending.push(object.proto);
	}
	return prov;
}

/** Whether a value may be workspace code a library could call back. */
function carriesCode(w: Walker, value: Value, node: ts.Node | undefined, depth = 0): boolean {
	switch (value.kind) {
		case "literal":
		case "builtin":
			return false;
		case "deferred":
			return value.generator === true;
		case "function":
		case "class":
		case "namespace":
		case "module":
		case "prototype":
			return true;
		case "array":
			// Elements stored since the walk last knew them may be anything their type allows.
			if (value.held === true)
				return (
					node === undefined ||
					!ts.isExpression(node) ||
					typeCarriesCode(w.pinned, w.checker.getTypeAtLocation(node))
				);
			return depth < 3 && value.elements.some((element) => carriesCode(w, element, undefined, depth + 1));
		case "object": {
			const object = w.objects.get(value.id);
			if (object === undefined || object.open || object.instanceOf !== undefined || object.proto !== undefined)
				return true;
			if (depth >= 3) return true;
			return [...object.props.values()].some(
				(prop) =>
					prop.getter !== undefined ||
					prop.setter !== undefined ||
					prop.forward !== undefined ||
					carriesCode(w, prop.value, undefined, depth + 1),
			);
		}
		default: {
			if (node === undefined || !ts.isExpression(node)) return true;
			return typeCarriesCode(w.pinned, w.checker.getTypeAtLocation(node));
		}
	}
}

/** Objects passed where the walk cannot follow, and what they hold, may be written by code it never sees. */
export function escapeValues(w: Walker, values: readonly Value[]): void {
	const seen = new Set<number>();
	const pending = [...values];
	for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
		if (value.kind === "builtin" && value.name === "addInitializer") {
			const gate = w.gates.get(value.gate);
			if (gate !== undefined && !gate.done) gate.list.open = true;
			continue;
		}
		// What it passes to may redefine or freeze a function, prototype or array.
		w.alter(value);
		if (value.kind === "array") {
			pending.push(...value.elements);
			continue;
		}
		const object = w.objectOf(value);
		if (object === undefined || seen.has(object.id)) continue;
		seen.add(object.id);
		pending.push(...[...object.props.values()].map((prop) => prop.value));
		if (object.proto !== undefined) pending.push(object.proto);
		forget(object);
	}
}

/** Walks a workspace function's body with its arguments bound, up to the depth limit. */
function* callFunction(
	w: Walker,
	callee: FunctionValue,
	thisValue: Value,
	args: Args,
	site: ts.Node,
	flow: Flow,
): Step<Value> {
	const node = callee.node;
	if (node.body === undefined) {
		w.unseen(site);
		w.throwExit(flow, true);
		return UNKNOWN;
	}
	// A generator's body waits for its first `next`.
	if (node.asteriskToken !== undefined) return { kind: "deferred", generator: true };
	if (w.active.has(node) || w.stack.length >= MAX_DEPTH) {
		w.unseen(site);
		w.throwExit(flow, true);
		return UNKNOWN;
	}
	const module = w.touch(node) ?? callee.scope.module;
	const frame: Frame = {
		module,
		vars: new Map(),
		parent: callee.scope,
		thisValue: ts.isArrowFunction(node) ? callee.scope.thisValue : thisOfCall(w, node, thisValue),
		fn: node,
		base: [...flow.guards],
	};
	const inner = w.branch(flow);
	const body = node.body;
	w.active.add(node);
	w.stack.push(callSite(site, w));
	try {
		yield* w.isolated(function* () {
			yield* bindParameters(w, node, args, frame, inner);
			if (!inner.alive) return;
			if (ts.isBlock(body)) {
				yield* statements(w, body.statements, frame, inner);
				return;
			}
			const value = yield* w.expr(body, frame, inner);
			if (!inner.alive) return;
			inner.exits.push({ kind: "return", guards: [...inner.guards], maybe: false, value });
			inner.alive = false;
		});
	} finally {
		w.active.delete(node);
		w.stack.pop();
	}
	// An async body's throw rejects its promise, and its `await` suspends it: the caller continues either way.
	if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) return DEFERRED;
	const returns = inner.exits.filter((exit) => exit.kind === "return");
	const throws = inner.exits.filter((exit) => exit.kind === "throw");
	// Each value depends on the guards of the path that returned it.
	const past = flow.guards.length;
	const values = [
		...returns.map((exit) => underGuards(exit.value ?? UNDEFINED, exit.guards.slice(past))),
		...(inner.alive ? [underGuards(UNDEFINED, inner.guards.slice(past))] : []),
	];
	const result = values.reduce(joinValues, values[0] ?? UNDEFINED);
	flow.exits.push(...throws);
	if (!inner.alive && returns.length === 0) {
		flow.alive = false;
		return UNKNOWN;
	}
	if (throws.length > 0) flow.guards = w.dependent(flow.guards, throws);
	return result;
}

export function* bindParameters(
	w: Walker,
	node: ts.FunctionLikeDeclaration,
	args: Args,
	frame: Frame,
	flow: Flow,
): Step<void> {
	let at = 0;
	for (const parameter of node.parameters) {
		if (ts.isIdentifier(parameter.name) && parameter.name.text === "this") continue;
		if (!flow.alive) return;
		if (parameter.dotDotDotToken !== undefined) {
			const rest: Value = args.open ? UNKNOWN : { kind: "array", elements: args.values.slice(at) };
			yield* bindPattern(w, parameter.name, rest, parameter, frame, flow, !args.open);
			return;
		}
		const arg = args.values[at] ?? (args.open ? UNKNOWN : UNDEFINED);
		at++;
		const value = yield* withDefault(w, arg, parameter.initializer, frame, flow);
		yield* bindPattern(w, parameter.name, value, parameter, frame, flow);
		if (ts.isParameterPropertyDeclaration(parameter, parameter.parent) && ts.isIdentifier(parameter.name)) {
			yield* writeMember(w, frame.thisValue, parameter.name.text, value, parameter, frame, flow);
		}
	}
}
