// Members: one lookup up the prototype chain, and the reads, writes, copies and tests that use it.

import ts from "typescript";
import { stored } from "./bindings.js";
import { boxOf, builtinHas, builtinMember } from "./builtins.js";
import { chainEnd } from "./conversions.js";
import { classMember } from "./definitions.js";
import {
	type ClassValue,
	type Flow,
	type Frame,
	forget,
	isNullish,
	literal,
	MAX_DEPTH,
	ownKeys,
	type Prop,
	provOf,
	type TrackedObject,
	UNDEFINED,
	UNKNOWN,
	type Value,
	withProv,
} from "./model.js";
import { readExport } from "./names.js";
import { inputDomain, isExternal, isStrict, memberDeclaration, typeCarriesCode } from "./symbols.js";
import type { Read, Step, Walker } from "./walker.js";

////////////////////////////////
//  Interfaces & Types

/** What a property lookup finds, running none of it. */
export type Found =
	/** An own property that exists, or may. */
	| { readonly kind: "own"; readonly prop: Prop }
	/** Inherited: a method, or a literal prototype's property. */
	| { readonly kind: "value"; readonly value: Value }
	| { readonly kind: "accessor"; readonly getter: Value | undefined; readonly setter: Value | undefined }
	/** Nowhere the walk can see, up a chain it knows to the end. */
	| { readonly kind: "absent" }
	/** The walk cannot tell; `hidden` when what it cannot see may hold a getter or setter. */
	| { readonly kind: "unknown"; readonly hidden: boolean };

////////////////////////////////
//  Lookup

/**
 * Looks a property up as the language does: own properties, then a literal's `__proto__` chain, or a
 * class's members up its bases. The one lookup reads, writes, conversions and `in` share.
 */
export function lookup(w: Walker, receiver: Value, key: string, depth = 0): Found {
	if (depth > MAX_DEPTH * 4) return { kind: "unknown", hidden: true };
	if (receiver.kind === "literal" && receiver.value === null) return { kind: "absent" };
	if (receiver.kind === "prototype") return classLookup(w, receiver.owner, key, false);
	const object = w.objectOf(receiver);
	if (object === undefined || object.lost === true) return { kind: "unknown", hidden: true };
	const prop = object.props.get(key);
	if (prop !== undefined && prop.state !== "no") return { kind: "own", prop };
	if (object.proto !== undefined) {
		const found = lookup(w, object.proto, key, depth + 1);
		return found.kind === "absent" && object.open ? { kind: "unknown", hidden: false } : found;
	}
	const owner = object.instanceOf ?? (receiver.kind === "class" ? receiver : undefined);
	const found =
		owner === undefined ? { kind: "absent" as const } : classLookup(w, owner, key, receiver.kind === "class");
	return found.kind === "absent" && object.open ? { kind: "unknown", hidden: false } : found;
}

function classLookup(w: Walker, owner: ClassValue, key: string, statics: boolean): Found {
	if (!statics && w.hooked({ kind: "prototype", owner })) return { kind: "unknown", hidden: true };
	// A class's prototype holds the class itself as its `constructor`.
	if (!statics && key === "constructor") {
		const member = classMember(w, owner, key, false);
		if (member?.unknown === true) return { kind: "unknown", hidden: true };
		if (member !== undefined)
			return member.method === undefined ? { kind: "absent" } : { kind: "value", value: member.method };
		return { kind: "value", value: owner };
	}
	const member = classMember(w, owner, key, statics);
	if (member === undefined) return { kind: "absent" };
	if (member.unknown === true) return { kind: "unknown", hidden: true };
	if (member.getter !== undefined || member.setter !== undefined)
		return { kind: "accessor", getter: member.getter, setter: member.setter };
	return member.method === undefined ? { kind: "absent" } : { kind: "value", value: member.method };
}

/** `key in receiver` for a value whose chain the walk knows; undefined when it cannot tell. */
export function has(w: Walker, receiver: Value, key: string): boolean | undefined {
	if (receiver.kind === "array") return key === "length" ? true : undefined;
	if (receiver.kind !== "object" && receiver.kind !== "class" && receiver.kind !== "prototype") return undefined;
	const found = lookup(w, receiver, key);
	if (found.kind === "own") return found.prop.state === "yes" ? true : undefined;
	if (found.kind === "value" || found.kind === "accessor") return true;
	if (found.kind === "unknown") return undefined;
	// A class's own built-in properties, then the built-in prototype its chain ends at.
	if (receiver.kind === "class" && READ_ONLY.has(key)) return true;
	const end = chainEnd(w, receiver);
	if (end === "null") return false;
	return end === undefined ? undefined : builtinHas(w, end === "object" ? "Object" : "Function", key);
}

////////////////////////////////
//  Reads and writes

/**
 * Reads a member: a tracked object's own property, a class's method or accessor, a namespace's
 * export. A property its owner assigns but has not yet is a hazard. The value depends on what the
 * receiver came from. A getter runs with `self`, the receiver unless `super` names another.
 */
export function* readMember(
	w: Walker,
	receiver: Value,
	key: string | undefined,
	node: ts.Node,
	frame: Frame,
	flow: Flow,
	self: Value = receiver,
): Step<Value> {
	const value = yield* memberOf(w, receiver, key, node, frame, flow, self);
	return withProv(value, provOf(receiver));
}

function* memberOf(
	w: Walker,
	receiver: Value,
	key: string | undefined,
	node: ts.Node,
	frame: Frame,
	flow: Flow,
	self: Value,
): Step<Value> {
	const read: Read = { node, module: frame.module, name: key ?? "[]" };
	switch (receiver.kind) {
		case "literal": {
			if (isNullish(receiver)) {
				w.throwExit(flow, false);
				return UNKNOWN;
			}
			// A string's own properties: its length and a character at each index; then its prototype's.
			const at = indexOf(key);
			if (typeof receiver.value === "string") {
				if (key === "length") return literal(receiver.value.length);
				if (at !== undefined) return at < receiver.value.length ? literal(receiver.value[at]) : UNDEFINED;
			}
			return builtinMember(w, boxOf(receiver.value as string | number | boolean | bigint), key);
		}
		case "object":
		case "class":
		case "prototype":
			return yield* trackedMember(w, receiver, key, read, frame, flow, self);
		case "array": {
			// What code since may have changed: an element, its length, or a method replaced.
			if (receiver.held === true) return hookedMember(w, receiver, node, flow);
			if (key === "length") return literal(receiver.elements.length);
			const at = indexOf(key);
			return at === undefined ? builtinMember(w, "Array", key) : (receiver.elements[at] ?? UNDEFINED);
		}
		case "function":
			if (w.hooked(receiver)) return hookedMember(w, receiver, node, flow);
			return builtinMember(w, "Function", key);
		case "builtin":
			// The global object a sloppy call's `this` is: the walk follows none of it.
			if (receiver.name === "global") {
				w.unseen(node);
				w.mayThrow(flow);
			}
			return UNKNOWN;
		case "namespace":
			if (key === undefined) {
				w.note(node);
				return UNKNOWN;
			}
			return readExport(w, receiver.module, key, node, frame, flow);
		case "module":
			if (key !== "exports") return UNKNOWN;
			return w.modules.get(receiver.module)?.exportsValue ?? UNKNOWN;
		case "unknown":
			return unknownMember(w, receiver, node, flow);
		default:
			return UNKNOWN;
	}
}

/** A canonical array index a key names. */
function indexOf(key: string | undefined): number | undefined {
	const at = key === undefined ? Number.NaN : Number(key);
	return Number.isInteger(at) && at >= 0 && String(at) === key ? at : undefined;
}

/** A member of what may hold a hook the walk never saw written: a function's, or a stored array's. */
function hookedMember(w: Walker, receiver: Value, node: ts.Node, flow: Flow): Value {
	if (w.hooked(receiver)) {
		w.unseen(node);
		w.mayThrow(flow);
	}
	return UNKNOWN;
}

/**
 * A member of a value the walk lost track of, or of an input: as unknown as it, unless a workspace
 * getter runs. An input's member is an input too, over its own declared type.
 */
function unknownMember(w: Walker, receiver: Value, node: ts.Node, flow: Flow): Value {
	const symbol =
		ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? w.checker.getSymbolAtLocation(node) : undefined;
	const getter = (symbol?.declarations ?? []).some(
		(declaration) => ts.isGetAccessorDeclaration(declaration) && !isExternal(w.pinned, declaration),
	);
	// Reading through an unknown value may throw.
	w.mayThrow(flow);
	if (getter) {
		w.unseen(node);
		return UNKNOWN;
	}
	if (receiver.kind !== "unknown" || receiver.direct !== true) return { kind: "unknown", prov: provOf(receiver) };
	return { kind: "unknown", prov: provOf(receiver), direct: true, domain: inputDomain(w.checker, node) };
}

function* trackedMember(
	w: Walker,
	receiver: Value & { kind: "object" | "class" | "prototype" },
	key: string | undefined,
	read: Read,
	frame: Frame,
	flow: Flow,
	self: Value,
): Step<Value> {
	const object = w.objectOf(receiver);
	if (receiver.kind === "class" && key === "prototype" && object?.lost !== true)
		return { kind: "prototype", owner: receiver };
	if (key === undefined) {
		const hidden =
			object === undefined ||
			object.open ||
			object.owner !== undefined ||
			object.proto !== undefined ||
			[...object.props.values()].some((prop) => prop.getter !== undefined);
		if (hidden) {
			w.unseen(read.node);
			w.mayThrow(flow);
		}
		return UNKNOWN;
	}
	const found = lookup(w, receiver, key);
	switch (found.kind) {
		case "own": {
			const { prop } = found;
			let value: Value = prop.value;
			if (prop.getter !== undefined) value = yield* w.invoke(prop.getter, self, NO_ARGS, read.node, frame, flow);
			else if (prop.forward !== undefined) {
				const target = w.objects.get(prop.forward.object);
				value =
					target === undefined
						? UNKNOWN
						: yield* readMember(
								w,
								{ kind: "object", id: target.id },
								prop.forward.name,
								read.node,
								frame,
								flow,
							);
			}
			if (prop.state === "yes") return value;
			if (object?.assigns?.has(key) === true || object?.open === true) w.uncertain(read);
			return UNKNOWN;
		}
		case "value":
			return found.value;
		case "accessor":
			return found.getter === undefined
				? UNDEFINED
				: yield* w.invoke(found.getter, self, NO_ARGS, read.node, frame, flow);
		case "unknown":
			if (found.hidden) {
				w.unseen(read.node);
				w.mayThrow(flow);
			} else if (object?.owner !== undefined) w.uncertain(read);
			return UNKNOWN;
		case "absent":
			// Only an owner still loading has the property ahead of it; one that finished never set it at load.
			if (object?.owner !== undefined && object.assigns?.has(key) === true) {
				if (w.modules.get(object.owner)?.status !== "evaluated") {
					const declaration = memberDeclaration(w.checker, object.symbol, key);
					w.hazard(read, { module: object.owner, name: key, kind: "property" }, flow, declaration);
				}
				return UNDEFINED;
			}
			// A class's own `name` and `length` are not modeled; past them, the built-in prototype the chain ends at.
			if (receiver.kind === "class" && READ_ONLY.has(key)) return UNKNOWN;
			return inherited(w, receiver, key);
	}
}

/** What the built-in prototype a chain ends at holds; undefined past a null prototype. */
function inherited(w: Walker, receiver: Value, key: string): Value {
	const end = chainEnd(w, receiver);
	// A class decorator may put another class in its place.
	const decorated =
		receiver.kind === "class" &&
		ts.canHaveDecorators(receiver.node) &&
		ts.getDecorators(receiver.node) !== undefined;
	if (end === undefined || decorated) return UNKNOWN;
	return end === "null" ? UNDEFINED : builtinMember(w, end === "object" ? "Object" : "Function", key);
}

export const NO_ARGS = { values: [], open: false } as const;

/** A function's or class's own properties no assignment changes. */
const READ_ONLY = new Set(["prototype", "name", "length"]);

/** Writes a member: a setter's call, a tracked property's assignment, or an escape into the unknown. */
export function* writeMember(
	w: Walker,
	receiver: Value,
	key: string | undefined,
	value: Value,
	node: ts.Node,
	frame: Frame,
	flow: Flow,
): Step<void> {
	switch (receiver.kind) {
		case "object":
		case "class": {
			const object = w.objects.get(receiver.id);
			if (object === undefined) return;
			if (key === undefined) {
				object.open = true;
				w.escape([value]);
				return;
			}
			const found = lookup(w, receiver, key);
			const setter =
				found.kind === "own" ? found.prop.setter : found.kind === "accessor" ? found.setter : undefined;
			if (setter !== undefined) {
				yield* w.invoke(setter, receiver, { values: [value], open: false }, node, frame, flow);
				return;
			}
			if (found.kind === "unknown" && found.hidden) {
				w.unseen(node);
				w.mayThrow(flow);
				object.open = true;
				return;
			}
			// An assignment fails on an accessor without a setter, and on a class's own read-only
			// `prototype`, `name` and `length`: strict code throws, sloppy code does nothing.
			const fails =
				found.kind === "accessor" ||
				(found.kind === "own" && found.prop.getter !== undefined) ||
				(receiver.kind === "class" && found.kind === "absent" && READ_ONLY.has(key));
			if (fails) {
				if (isStrict(w.pinned, node)) w.throwExit(flow, false);
				return;
			}
			// The inherited `__proto__` setter replaces the prototype, which the walk does not follow.
			if (key === "__proto__") {
				forget(object);
				return;
			}
			w.setProp(object, key, value, flow);
			return;
		}
		case "module": {
			if (key !== "exports") return;
			const record = w.modules.get(receiver.module);
			if (record !== undefined) record.exportsValue = stored(record.exportsValue, value, flow, []);
			return;
		}
		case "literal":
			// A primitive holds no property: strict code throws setting one, sloppy code does nothing.
			if (isNullish(receiver) || isStrict(w.pinned, node)) w.throwExit(flow, false);
			return;
		case "namespace":
			// A module namespace object refuses every write.
			if (isStrict(w.pinned, node)) w.throwExit(flow, false);
			return;
		case "prototype": {
			const found = key === undefined ? undefined : lookup(w, receiver, key);
			if (found?.kind === "accessor" && found.setter !== undefined) {
				yield* w.invoke(found.setter, receiver, { values: [value], open: false }, node, frame, flow);
				return;
			}
			hookedWrite(w, receiver, node, flow);
			w.alter(receiver);
			w.escape([value]);
			return;
		}
		case "function":
			// A function's own `name` and `length` are read-only.
			if (!w.hooked(receiver) && key !== undefined && READ_ONLY.has(key) && key !== "prototype") {
				if (isStrict(w.pinned, node)) w.throwExit(flow, false);
				return;
			}
			hookedWrite(w, receiver, node, flow);
			w.alter(receiver);
			w.escape([value]);
			return;
		case "array":
			hookedWrite(w, receiver, node, flow);
			if (indexOf(key) === undefined && key !== "length") w.alter(receiver);
			w.escape([value]);
			return;
		case "builtin":
			// The global object, or the library's: what the walk does not follow, which may refuse it.
			if (receiver.name === "global") w.unseen(node);
			w.mayThrow(flow);
			w.escape([value]);
			return;
		case "unknown":
			// A primitive, a frozen object or a setter may refuse it.
			w.mayThrow(flow);
			w.escape([value]);
			return;
		default:
			return;
	}
}

/** A write to what may hold a hook or refuse it: a setter defined or a freeze the walk never saw. */
function hookedWrite(w: Walker, receiver: Value, node: ts.Node, flow: Flow): void {
	if (!w.hooked(receiver)) return;
	w.unseen(node);
	w.mayThrow(flow);
}

/**
 * Copies a value's own enumerable properties onto a new object, as object spread and object rest
 * do, in the language's key order, running each getter. `skip` names those a rest's other elements took.
 */
export function* copyOwn(
	w: Walker,
	source: Value,
	into: TrackedObject,
	skip: ReadonlySet<string>,
	node: ts.Node,
	frame: Frame,
	flow: Flow,
): Step<void> {
	const from = w.objectOf(source);
	// A primitive converts to an object first: a string's own properties are its characters.
	if (source.kind === "literal") {
		const units = typeof source.value === "string" ? source.value.split("") : [];
		for (const [at, unit] of units.entries())
			if (!skip.has(String(at))) into.props.set(String(at), { state: "yes", value: literal(unit) });
		return;
	}
	if (from === undefined || from.lost === true) {
		// Getters on what the walk lost track of, or a namespace's exports, run unseen.
		const unseen =
			from !== undefined ||
			w.hooked(source) ||
			(source.kind !== "array" &&
				source.kind !== "function" &&
				(source.kind !== "unknown" || typeCarriesCode(w.pinned, w.checker.getTypeAtLocation(node))));
		if (unseen) {
			w.unseen(node);
			w.mayThrow(flow);
		}
		into.open = true;
		return;
	}
	if (from.open) into.open = true;
	const names = [...from.props].flatMap(([name, prop]) => (prop.state === "no" || skip.has(name) ? [] : [name]));
	for (const name of ownKeys(names)) {
		if (!flow.alive) return;
		const state = from.props.get(name)?.state ?? "maybe";
		const value = yield* readMember(w, source, name, node, frame, flow);
		into.props.set(name, { state, value });
	}
}
