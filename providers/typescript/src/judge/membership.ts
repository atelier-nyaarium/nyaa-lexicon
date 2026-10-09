// Membership: what `instanceof` and `in` run, and what they answer.

import ts from "typescript";
import { toKey } from "./conversions.js";
import { has } from "./members.js";
import {
	type ClassValue,
	type Flow,
	type Frame,
	isObject,
	literal,
	MAX_DEPTH,
	provOf,
	truthiness,
	UNKNOWN,
	VARIES,
	type Value,
	withProv,
} from "./model.js";
import { hasModifier, isExternal, isStatic, unwrapExpression } from "./symbols.js";
import type { Step, Walker } from "./walker.js";

////////////////////////////////
//  Symbol.hasInstance

/** Whether a function has a `prototype`: a plain function or a generator, not an arrow, method or async function. */
function hasPrototype(fn: ts.FunctionLikeDeclaration): boolean {
	if (fn.asteriskToken !== undefined) return true;
	return (
		(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && !hasModifier(fn, ts.SyntaxKind.AsyncKeyword)
	);
}

/** Whether a value is the language's `Symbol.hasInstance`, as a computed key names it. */
function isHasInstance(w: Walker, key: ts.Expression): boolean {
	const held = unwrapExpression(key);
	if (!ts.isPropertyAccessExpression(held) || held.name.text !== "hasInstance") return false;
	if (!ts.isIdentifier(held.expression) || held.expression.text !== "Symbol") return false;
	const declarations = w.checker.getSymbolAtLocation(held.expression)?.declarations ?? [];
	return declarations.length > 0 && declarations.every((declaration) => isExternal(w.pinned, declaration));
}

/** Whether a value of the node's type may have a workspace `Symbol.hasInstance`. */
function typeHasInstance(w: Walker, node: ts.Node): boolean {
	const visit = (type: ts.Type): boolean => {
		if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
		if (type.isUnionOrIntersection()) return type.types.some(visit);
		return w.checker
			.getPropertiesOfType(type)
			.some(
				(property) =>
					property.escapedName.toString().startsWith("__@hasInstance") &&
					(property.declarations ?? []).some((declaration) => !isExternal(w.pinned, declaration)),
			);
	};
	return visit(w.checker.getTypeAtLocation(node));
}

/** A class's static `Symbol.hasInstance` method up its base chain; "unknown" where the walk cannot tell. */
function hasInstance(w: Walker, owner: ClassValue): Value | "unknown" | undefined {
	let current = owner;
	for (let depth = 0; depth < MAX_DEPTH * 4; depth++) {
		if (w.objectOf(current)?.open === true) return "unknown";
		for (const member of current.node.members) {
			if (!isStatic(member) || member.name === undefined || !ts.isComputedPropertyName(member.name)) continue;
			const key = member.name.expression;
			if (isHasInstance(w, key))
				return ts.isMethodDeclaration(member) && member.body !== undefined
					? { kind: "function", node: member, scope: current.scope }
					: "unknown";
			// A computed key the walk cannot name may be it.
			if (!ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)) return "unknown";
		}
		const base = w.bases.get(current.id);
		if (base === undefined || base === null) return undefined;
		if (base.kind !== "class") {
			const heritage = current.node.heritageClauses?.find(
				(clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
			)?.types[0]?.expression;
			return heritage === undefined || typeHasInstance(w, heritage) ? "unknown" : undefined;
		}
		current = base;
	}
	return "unknown";
}

////////////////////////////////
//  Operators

/** `x instanceof C`: a class's static `Symbol.hasInstance` runs; a right side that is no object throws. */
export function* instanceOf(
	w: Walker,
	node: ts.BinaryExpression,
	left: Value,
	right: Value,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	switch (right.kind) {
		case "class": {
			const found = hasInstance(w, right);
			if (found === undefined) return ordinaryHasInstance(w, left, right);
			if (found === "unknown") {
				w.unseen(node);
				return UNKNOWN;
			}
			const result = yield* w.invoke(found, right, { values: [left], open: false }, node, frame, flow);
			const truth = truthiness(result);
			return truth === undefined ? UNKNOWN : literal(truth);
		}
		case "function": {
			// A primitive is no instance; past that, a function with no `prototype` throws.
			const object = isObject(left);
			if (object === false) return literal(false);
			if (hasPrototype(right.node)) return UNKNOWN;
			if (object === true) {
				w.throwExit(flow, false);
				return UNKNOWN;
			}
			w.mayThrow(flow);
			return literal(false);
		}
		case "builtin":
			return UNKNOWN;
		case "object": {
			// A plain object needs its own `Symbol.hasInstance`, which only a computed key gives it.
			const object = w.objectOf(right);
			const plain = object !== undefined && !object.open && object.proto === undefined;
			if (plain && object.instanceOf === undefined) w.throwExit(flow, false);
			else w.unseen(node);
			return UNKNOWN;
		}
		case "prototype":
			w.unseen(node);
			return UNKNOWN;
		case "unknown":
			if (typeHasInstance(w, node.right)) {
				w.unseen(node);
				return UNKNOWN;
			}
			w.mayThrow(flow);
			return VARIES;
		case "deferred":
			w.mayThrow(flow);
			return UNKNOWN;
		default:
			w.throwExit(flow, false);
			return UNKNOWN;
	}
}

/** `x instanceof C` with no `Symbol.hasInstance` of C's own: whether C's prototype is on x's chain. */
function ordinaryHasInstance(w: Walker, left: Value, right: ClassValue): Value {
	// A reassigned `prototype` the walk does not follow.
	if (w.writes.names.has("prototype")) return UNKNOWN;
	let current: Value = left;
	for (let depth = 0; depth < MAX_DEPTH * 4; depth++) {
		if (current.kind === "unknown") return withProv(VARIES, provOf(current));
		const object = w.objectOf(current);
		if (object?.lost === true || w.hooked(current)) return UNKNOWN;
		// An instance's chain goes on at its class's prototype; a prototype's, at its base's.
		let owner = object?.instanceOf;
		if (current.kind === "prototype") {
			const base = w.bases.get(current.owner.id);
			if (base === undefined || base === null) return literal(false);
			if (base.kind !== "class") return UNKNOWN;
			owner = base;
		}
		if (owner !== undefined) {
			const is = extendsClass(w, owner, right);
			return is === undefined ? UNKNOWN : literal(is);
		}
		if (object === undefined || current.kind === "class" || object.proto === undefined)
			return current.kind === "object" && object?.open === true ? UNKNOWN : literal(false);
		current = object.proto;
	}
	return UNKNOWN;
}

/** Whether `owner` is `target` or extends it; undefined past a base the walk cannot read. */
function extendsClass(w: Walker, owner: ClassValue, target: ClassValue): boolean | undefined {
	let current: ClassValue = owner;
	for (let depth = 0; depth < MAX_DEPTH * 4; depth++) {
		if (current.id === target.id) return true;
		const base = w.bases.get(current.id);
		if (base === undefined || base === null) return false;
		if (base.kind !== "class") return undefined;
		current = base;
	}
	return undefined;
}

/** `key in object`: what is no object throws; the key converts, then the one lookup answers. */
export function* inOperator(
	w: Walker,
	node: ts.BinaryExpression,
	left: Value,
	right: Value,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	// `in` throws on anything but an object.
	const object = isObject(right);
	if (object === false) {
		w.throwExit(flow, false);
		return UNKNOWN;
	}
	if (object === undefined) {
		w.mayThrow(flow);
		return VARIES;
	}
	// A private brand the walk does not track.
	if (ts.isPrivateIdentifier(node.left)) return UNKNOWN;
	const key = yield* toKey(w, left, node.left, frame, flow);
	if (!flow.alive) return UNKNOWN;
	if (key === undefined) return left.kind === "unknown" ? VARIES : UNKNOWN;
	const found = has(w, right, key);
	return found === undefined ? UNKNOWN : literal(found);
}
