// Conversions: a value to a primitive or a property key, running the hooks the one lookup finds.

import ts from "typescript";
import { lookup, NO_ARGS } from "./members.js";
import {
	type ClassValue,
	EXACT,
	type Flow,
	type Frame,
	isNullish,
	isObject,
	literal,
	MAX_DEPTH,
	MAX_TEXT,
	provOf,
	UNDEFINED,
	UNKNOWN,
	unionProv,
	VARIES,
	type Value,
	withProv,
} from "./model.js";
import { typeConverts } from "./symbols.js";
import type { Step, Walker } from "./walker.js";

////////////////////////////////
//  Interfaces & Types

/** Which hook a conversion tries first: `toString` for a string, `valueOf` otherwise. */
export type Hint = "default" | "number" | "string";

/** Where a prototype chain ends: `Object.prototype`, `Function.prototype`, or null. */
type ChainEnd = "object" | "function" | "null";

////////////////////////////////
//  Conversions

/**
 * Converts a value to a primitive as the language does: `valueOf` and `toString`, found by the one
 * lookup, run in the hint's order until one gives a primitive; when none does, it throws. A member
 * that may be `Symbol.toPrimitive`, or a hook the walk cannot see, runs unseen.
 */
export function* toPrimitive(
	w: Walker,
	value: Value,
	hint: Hint,
	node: ts.Expression,
	frame: Frame,
	flow: Flow,
	type: ts.Type | undefined = w.checker.getTypeAtLocation(node),
	depth = 0,
): Step<Value> {
	switch (value.kind) {
		case "literal":
			return value;
		case "unknown":
			if (type === undefined || typeConverts(w.pinned, type)) w.unseen(node);
			return value;
		case "array": {
			if (value.held !== true) return yield* joinArray(w, value.elements, node, frame, flow, type, depth);
			// Elements the walk no longer knows convert as their type says, unless a hook replaced the join.
			const itemType = type === undefined ? undefined : w.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
			if (w.hooked(value) || itemType === undefined || typeConverts(w.pinned, itemType)) w.unseen(node);
			w.mayThrow(flow);
			return UNKNOWN;
		}
		case "object":
		case "class":
		case "prototype":
			return yield* ordinaryToPrimitive(w, value, hint, node, frame, flow);
		case "function":
			// Its own `valueOf` or `toString`, where something gave it one.
			if (w.hooked(value)) {
				w.unseen(node);
				w.mayThrow(flow);
			}
			return UNKNOWN;
		case "builtin":
		case "deferred":
			// A function's source text, or a promise's or generator's tag, which the walk does not compute.
			return UNKNOWN;
		default:
			w.unseen(node);
			return UNKNOWN;
	}
}

/** `Array.prototype.toString`: each element converted to a string, null and undefined as empty. */
function* joinArray(
	w: Walker,
	elements: readonly Value[],
	node: ts.Expression,
	frame: Frame,
	flow: Flow,
	type: ts.Type | undefined,
	depth: number,
): Step<Value> {
	if (depth > MAX_DEPTH) {
		w.unseen(node);
		return UNKNOWN;
	}
	const itemType = type === undefined ? undefined : w.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
	let text: string | undefined = "";
	let prov = EXACT;
	for (const [at, element] of elements.entries()) {
		const part = isNullish(element)
			? literal("")
			: yield* toPrimitive(w, element, "string", node, frame, flow, itemType, depth + 1);
		if (!flow.alive) return UNKNOWN;
		prov = unionProv(prov, provOf(part));
		text =
			text !== undefined && part.kind === "literal"
				? `${text}${at > 0 ? "," : ""}${String(part.value)}`
				: undefined;
		if (text !== undefined && text.length > MAX_TEXT) return UNKNOWN;
	}
	return withProv(text === undefined ? VARIES : literal(text), prov);
}

function* ordinaryToPrimitive(
	w: Walker,
	value: Value,
	hint: Hint,
	node: ts.Expression,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	if (computedMembers(w, value)) {
		w.unseen(node);
		w.mayThrow(flow);
		return UNKNOWN;
	}
	const end = chainEnd(w, value);
	for (const name of hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"]) {
		const found = lookup(w, value, name);
		let method: Value;
		switch (found.kind) {
			case "own":
				if (found.prop.state !== "yes") {
					w.unseen(node);
					return UNKNOWN;
				}
				method =
					found.prop.getter === undefined
						? found.prop.value
						: yield* w.invoke(found.prop.getter, value, NO_ARGS, node, frame, flow);
				break;
			case "value":
				method = found.value;
				break;
			case "accessor":
				method =
					found.getter === undefined
						? UNDEFINED
						: yield* w.invoke(found.getter, value, NO_ARGS, node, frame, flow);
				break;
			case "unknown":
				w.unseen(node);
				w.mayThrow(flow);
				return UNKNOWN;
			case "absent":
				if (end === undefined) {
					w.unseen(node);
					return UNKNOWN;
				}
				// `Object.prototype.valueOf` gives the object back; `toString` gives a tag or a function's source.
				if (end === "null" || name === "valueOf") continue;
				return end === "object" ? literal("[object Object]") : UNKNOWN;
		}
		if (!flow.alive) return UNKNOWN;
		// What is not callable is skipped; a class throws called.
		if (method.kind === "literal" || method.kind === "object" || method.kind === "array") continue;
		if (method.kind === "class") {
			w.throwExit(flow, false);
			return UNKNOWN;
		}
		if (method.kind !== "function") {
			w.unseen(node);
			w.mayThrow(flow);
			return UNKNOWN;
		}
		const result = yield* w.invoke(method, value, NO_ARGS, node, frame, flow);
		if (!flow.alive) return UNKNOWN;
		const object = isObject(result);
		if (object === false) return result;
		// An object result moves on to the next hook, which an unknown one may or may not.
		if (object === undefined) {
			w.unseen(node);
			return UNKNOWN;
		}
	}
	w.throwExit(flow, false);
	return UNKNOWN;
}

/**
 * A property key as the language computes one: an object converted to a string first. Undefined
 * when the walk cannot name it.
 */
export function* toKey(
	w: Walker,
	value: Value,
	node: ts.Expression,
	frame: Frame,
	flow: Flow,
): Step<string | undefined> {
	if (value.kind === "unknown") {
		// An untyped key is taken as a primitive; a typed object's own hook still runs unseen.
		const type = w.checker.getTypeAtLocation(node);
		if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 && typeConverts(w.pinned, type))
			w.unseen(node);
		return undefined;
	}
	const key = isObject(value) === true ? yield* toPrimitive(w, value, "string", node, frame, flow) : value;
	return key.kind === "literal" ? String(key.value) : undefined;
}

/**
 * Whether converting a value may run workspace code: a hook the lookup finds anywhere up its chain,
 * or a computed member that may be `Symbol.toPrimitive`. For where a conversion may not happen at all.
 */
export function converts(w: Walker, value: Value, node: ts.Expression): boolean {
	switch (value.kind) {
		case "literal":
		case "function":
		case "builtin":
		case "deferred":
			return false;
		case "array":
			return value.held === true || value.elements.some((element) => element.kind !== "literal");
		case "object":
		case "class":
		case "prototype":
			return (
				computedMembers(w, value) ||
				["valueOf", "toString"].some((name) => lookup(w, value, name).kind !== "absent") ||
				chainEnd(w, value) === undefined
			);
		case "unknown":
			return typeConverts(w.pinned, w.checker.getTypeAtLocation(node));
		default:
			return true;
	}
}

////////////////////////////////
//  Chains

/** Whether a class on the value's chain has a member whose computed name the walk cannot read. */
function computedMembers(w: Walker, value: Value): boolean {
	const object = w.objectOf(value);
	let owner: ClassValue | undefined =
		value.kind === "prototype" ? value.owner : value.kind === "class" ? value : object?.instanceOf;
	for (let depth = 0; owner !== undefined && depth < MAX_DEPTH * 4; depth++) {
		const named = owner.node.members.every(
			(member) =>
				member.name === undefined ||
				!ts.isComputedPropertyName(member.name) ||
				ts.isStringLiteralLike(member.name.expression),
		);
		if (!named) return true;
		const base: Value | null | undefined = w.bases.get(owner.id);
		owner = base !== null && base?.kind === "class" ? base : undefined;
	}
	return false;
}

/** Where a value's prototype chain ends; undefined where the walk cannot follow it. */
export function chainEnd(w: Walker, value: Value, depth = 0): ChainEnd | undefined {
	if (depth > MAX_DEPTH * 4) return undefined;
	switch (value.kind) {
		case "class":
			return "function";
		case "prototype": {
			const base = w.bases.get(value.owner.id);
			// No base is `Object.prototype`, unless the class extends null.
			if (base === null) {
				const heritage = value.owner.node.heritageClauses?.some(
					(clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
				);
				return heritage === true ? "null" : "object";
			}
			return base?.kind === "class" ? chainEnd(w, { kind: "prototype", owner: base }, depth + 1) : undefined;
		}
		case "object": {
			const object = w.objectOf(value);
			if (object === undefined || object.lost === true) return undefined;
			if (object.proto !== undefined)
				return object.proto.kind === "literal" && object.proto.value === null
					? "null"
					: chainEnd(w, object.proto, depth + 1);
			return object.instanceOf === undefined
				? "object"
				: chainEnd(w, { kind: "prototype", owner: object.instanceOf }, depth + 1);
		}
		default:
			return undefined;
	}
}
