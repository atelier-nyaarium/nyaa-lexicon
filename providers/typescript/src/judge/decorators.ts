// Decorators: legacy ones as `experimentalDecorators` emit runs them, standard ones as TypeScript's emit applies them.

import ts from "typescript";
import { type ClassValue, type Flow, type Frame, literal, UNDEFINED, UNKNOWN, type Value } from "./model.js";
import { hasModifier, isStatic, memberName, metadataRead } from "./symbols.js";
import type { Args, Step, Walker } from "./walker.js";

////////////////////////////////
//  Interfaces & Types

/** Callbacks `addInitializer` collected, run together at one point of a class's life. */
export interface Initializers {
	readonly entries: Array<{ readonly fn: Value; readonly site: ts.Node }>;
	/** Something the walk cannot name may have been added. */
	open: boolean;
}

/** One element's decorator contexts' `addInitializer`: it adds to `list` until that decoration completes. */
export interface Gate {
	readonly list: Initializers;
	done: boolean;
}

/** A decorated field or auto-accessor: what its decorators returned for its initial value, and its callbacks. */
interface Field {
	/** Run in order on the initial value. */
	readonly transforms: Value[];
	/** A decorator returned something the walk cannot run. */
	open: boolean;
	/** Run once the field is defined. */
	readonly after: Initializers;
}

/** What standard decorators did to one class definition. */
export interface Decoration {
	/** Methods and accessors a decorator replaced, as `static name` or `name`; lookups of them are unknown. */
	readonly replaced: Set<string>;
	/** A class decorator replaced the class itself. */
	replacedClass: boolean;
	/** Static method and accessor decorators' callbacks, run before the static elements. */
	readonly statics: Initializers;
	/** Instance method and accessor decorators' callbacks, run at construction before the fields. */
	readonly instances: Initializers;
	/** Class decorators' callbacks, run after the static elements. */
	readonly classes: Initializers;
	readonly fields: Map<ts.ClassElement, Field>;
}

/** An element's decorators, evaluated where the class definition reaches them; the class's own when no member. */
export interface Pending {
	readonly member: ts.ClassElement | undefined;
	readonly decorators: ReadonlyArray<{ readonly node: ts.Decorator; readonly fn: Value }>;
}

type ElementKind = "class" | "method" | "getter" | "setter" | "field" | "accessor";

////////////////////////////////
//  Functions & Helpers

export function decorated(node: ts.ClassLikeDeclaration): boolean {
	if ((ts.getDecorators(node) ?? []).length > 0) return true;
	return (
		node.members.some((member) => ts.canHaveDecorators(member) && (ts.getDecorators(member) ?? []).length > 0) ||
		decoratesParameters(node)
	);
}

export function decoratesParameters(node: ts.ClassLikeDeclaration): boolean {
	return node.members.some(
		(member) =>
			(ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) &&
			member.parameters.some((parameter) => (ts.getDecorators(parameter) ?? []).length > 0),
	);
}

function initializers(): Initializers {
	return { entries: [], open: false };
}

function kindOf(member: ts.ClassElement | undefined): ElementKind | undefined {
	if (member === undefined) return "class";
	if (ts.isMethodDeclaration(member)) return member.body === undefined ? undefined : "method";
	if (ts.isGetAccessorDeclaration(member)) return "getter";
	if (ts.isSetAccessorDeclaration(member)) return "setter";
	if (!ts.isPropertyDeclaration(member)) return undefined;
	if (hasModifier(member, ts.SyntaxKind.DeclareKeyword) || hasModifier(member, ts.SyntaxKind.AbstractKeyword))
		return undefined;
	return hasModifier(member, ts.SyntaxKind.AccessorKeyword) ? "accessor" : "field";
}

/** Whether a function can stand where a decorator's result must be one. */
function callable(value: Value): boolean {
	return value.kind === "function" || value.kind === "class" || value.kind === "builtin";
}

/** Application order: static then instance methods and accessors, static then instance fields, the class. */
function rank(member: ts.ClassElement | undefined): number {
	const kind = kindOf(member);
	if (member === undefined || kind === undefined) return 4;
	const field = kind === "field";
	return (field ? 2 : 0) + (isStatic(member) ? 0 : 1);
}

////////////////////////////////
//  Standard decorators

/** Evaluates decorator expressions in order. */
export function* evaluateDecorators(
	w: Walker,
	node: ts.HasDecorators,
	frame: Frame,
	flow: Flow,
): Step<Array<{ node: ts.Decorator; fn: Value }>> {
	const evaluated: Array<{ node: ts.Decorator; fn: Value }> = [];
	for (const decorator of ts.getDecorators(node) ?? []) {
		if (!flow.alive) break;
		evaluated.push({ node: decorator, fn: yield* w.expr(decorator.expression, frame, flow) });
	}
	return evaluated;
}

/**
 * Calls every decorator a class definition evaluated, each element's last to first, in the order
 * TypeScript's emit applies them, and records what they did for the rest of the class's life.
 */
export function* decorate(
	w: Walker,
	value: ClassValue,
	pending: readonly Pending[],
	frame: Frame,
	flow: Flow,
): Step<void> {
	const decoration: Decoration = {
		replaced: new Set(),
		replacedClass: false,
		statics: initializers(),
		instances: initializers(),
		classes: initializers(),
		fields: new Map(),
	};
	w.decorations.set(value.id, decoration);
	// Within a category, in source order, whenever each one's expressions were evaluated.
	const ordered = [...pending].sort(
		(a, b) => rank(a.member) - rank(b.member) || (a.member?.pos ?? 0) - (b.member?.pos ?? 0),
	);
	for (const element of ordered) {
		if (!flow.alive) return;
		if (element.decorators.length > 0) yield* applyElement(w, value, decoration, element, frame, flow);
	}
}

function* applyElement(
	w: Walker,
	owner: ClassValue,
	decoration: Decoration,
	element: Pending,
	frame: Frame,
	flow: Flow,
): Step<void> {
	const { member } = element;
	const kind = kindOf(member);
	if (kind === undefined) {
		w.unseen(member);
		return;
	}
	const statics = member !== undefined && isStatic(member);
	const name = member === undefined ? owner.node.name?.text : memberName(member.name);
	let field: Field | undefined;
	if (member !== undefined && (kind === "field" || kind === "accessor")) {
		field = { transforms: [], open: false, after: initializers() };
		decoration.fields.set(member, field);
	}
	const list =
		field?.after ?? (kind === "class" ? decoration.classes : statics ? decoration.statics : decoration.instances);
	const gate: Gate = { list, done: false };
	const id = w.newGate(gate);
	const replacedKey = name === undefined ? undefined : `${statics ? "static " : ""}${name}`;
	let current: Value =
		kind === "class"
			? owner
			: kind === "method" || kind === "getter" || kind === "setter"
				? { kind: "function", node: member as ts.FunctionLikeDeclaration, scope: owner.scope }
				: kind === "field"
					? UNDEFINED
					: UNKNOWN;
	for (const { node, fn } of [...element.decorators].reverse()) {
		if (!flow.alive) break;
		const context = contextValue(w, kind, name, statics, member, id, flow);
		const args: Args = { values: [current, context], open: false };
		const result = yield* w.invoke(fn, UNDEFINED, args, node, frame, flow);
		if (!flow.alive) break;
		if (result.kind === "literal" && result.value === undefined) continue;
		// A result of the wrong kind throws; one the walk cannot name may.
		const wrong = kind === "accessor" ? result.kind === "literal" || callable(result) : !callable(result);
		if (wrong && result.kind !== "unknown") {
			w.throwExit(flow, false);
			break;
		}
		if (result.kind === "unknown") w.throwExit(flow, true);
		if (kind === "class") {
			decoration.replacedClass = true;
			current = result;
		} else if (kind === "field" && field !== undefined) {
			if (result.kind === "unknown") field.open = true;
			else field.transforms.unshift(result);
		} else {
			if (replacedKey !== undefined) decoration.replaced.add(replacedKey);
			if (field !== undefined) field.open = true;
			current = result;
		}
	}
	gate.done = true;
}

/** A decorator's context: its element's kind, name and placement, and `addInitializer`. */
function contextValue(
	w: Walker,
	kind: ElementKind,
	name: string | undefined,
	statics: boolean,
	member: ts.ClassElement | undefined,
	gate: number,
	flow: Flow,
): Value {
	const object = w.newObject({ label: "object", base: [...flow.guards] });
	const set = (key: string, value: Value) => object.props.set(key, { state: "yes", value });
	set("kind", literal(kind));
	set("name", name === undefined ? UNKNOWN : literal(name));
	if (member !== undefined) {
		set("static", literal(statics));
		set("private", literal(member.name !== undefined && ts.isPrivateIdentifier(member.name)));
		set("access", UNKNOWN);
	}
	set("metadata", UNKNOWN);
	set("addInitializer", { kind: "builtin", name: "addInitializer", gate });
	return { kind: "object", id: object.id };
}

/** A context's `addInitializer(f)`: adds `f` until its decoration completes, then throws. */
export function addInitializer(w: Walker, id: number, args: Args, site: ts.Node, flow: Flow): Value {
	const gate = w.gates.get(id);
	if (gate === undefined) return UNKNOWN;
	if (gate.done) {
		w.throwExit(flow, false);
		return UNKNOWN;
	}
	const fn = args.values[0] ?? (args.open ? UNKNOWN : UNDEFINED);
	if (fn.kind === "unknown") {
		gate.list.open = true;
		w.throwExit(flow, true);
	} else if (fn.kind === "function" || fn.kind === "class") gate.list.entries.push({ fn, site });
	else w.throwExit(flow, false);
	return UNDEFINED;
}

/** Runs the callbacks one list collected, each with `thisValue`. */
export function* runInitializers(
	w: Walker,
	list: Initializers,
	thisValue: Value,
	site: ts.Node,
	frame: Frame,
	flow: Flow,
): Step<void> {
	if (list.open) w.unseen(site);
	for (const { fn, site: added } of list.entries) {
		if (!flow.alive) return;
		yield* w.invoke(fn, thisValue, { values: [], open: false }, added, frame, flow);
	}
}

/** A decorated field's initial value, through the functions its decorators returned. */
export function* fieldValue(
	w: Walker,
	owner: ClassValue,
	member: ts.ClassElement,
	initial: Value,
	thisValue: Value,
	frame: Frame,
	flow: Flow,
): Step<Value> {
	const field = w.decorations.get(owner.id)?.fields.get(member);
	if (field === undefined) return initial;
	if (field.open) {
		w.unseen(member);
		return UNKNOWN;
	}
	let value = initial;
	for (const fn of field.transforms) {
		if (!flow.alive) return UNKNOWN;
		value = yield* w.invoke(fn, thisValue, { values: [value], open: false }, member, frame, flow);
	}
	return value;
}

/** A decorated field's callbacks, once it is defined. */
export function* fieldDefined(
	w: Walker,
	owner: ClassValue,
	member: ts.ClassElement,
	thisValue: Value,
	frame: Frame,
	flow: Flow,
): Step<void> {
	const field = w.decorations.get(owner.id)?.fields.get(member);
	if (field !== undefined) yield* runInitializers(w, field.after, thisValue, member, frame, flow);
}

////////////////////////////////
//  Legacy decorators

/**
 * `experimentalDecorators`, as emit runs them after the class: instance members, then static
 * members, then the class. Each member's decorator expressions and design metadata are evaluated
 * in order, then the decorators are called last to first.
 */
export function* legacyDecorators(
	w: Walker,
	node: ts.ClassDeclaration,
	value: ClassValue,
	frame: Frame,
	flow: Flow,
): Step<void> {
	const module = w.pinned.moduleOf(node.getSourceFile()) ?? frame.module;
	const options = w.pinned.options(module);
	if (options.experimentalDecorators !== true || !decorated(node)) return;
	const metadata = options.emitDecoratorMetadata === true;
	const prototype: Value = { kind: "prototype", owner: value };
	const ordered = [
		...node.members.filter((member) => !isStatic(member)),
		...node.members.filter((member) => isStatic(member)),
	];
	for (const member of ordered) {
		if (!flow.alive || ts.isConstructorDeclaration(member)) continue;
		const own = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
		const parameters = ts.isMethodDeclaration(member) ? member.parameters : [];
		const byParameter = parameters.flatMap((parameter, index) =>
			(ts.getDecorators(parameter) ?? []).map((decorator) => ({ decorator, index })),
		);
		if (own.length === 0 && byParameter.length === 0) continue;
		const target = isStatic(member) ? value : prototype;
		const key = literal(memberName(member.name) ?? "");
		const calls: Array<{ decorator: ts.Decorator; fn: Value; args: Value[] }> = [];
		for (const decorator of own) {
			const fn = yield* w.expr(decorator.expression, frame, flow);
			calls.push({ decorator, fn, args: [target, key, ts.isPropertyDeclaration(member) ? UNDEFINED : UNKNOWN] });
		}
		for (const { decorator, index } of byParameter) {
			const fn = yield* w.expr(decorator.expression, frame, flow);
			calls.push({ decorator, fn, args: [target, key, literal(index)] });
		}
		if (metadata)
			for (const annotation of memberAnnotations(member)) yield* readMetadata(w, annotation, frame, flow);
		yield* apply(w, calls, frame, flow);
	}
	const initializer = node.members.find(ts.isConstructorDeclaration);
	const own = ts.getDecorators(node) ?? [];
	const byParameter = (initializer?.parameters ?? []).flatMap((parameter, index) =>
		(ts.getDecorators(parameter) ?? []).map((decorator) => ({ decorator, index })),
	);
	if (!flow.alive || (own.length === 0 && byParameter.length === 0)) return;
	const calls: Array<{ decorator: ts.Decorator; fn: Value; args: Value[] }> = [];
	for (const decorator of own)
		calls.push({ decorator, fn: yield* w.expr(decorator.expression, frame, flow), args: [value] });
	for (const { decorator, index } of byParameter)
		calls.push({
			decorator,
			fn: yield* w.expr(decorator.expression, frame, flow),
			args: [value, UNDEFINED, literal(index)],
		});
	if (metadata)
		for (const parameter of initializer?.parameters ?? []) yield* readMetadata(w, parameter.type, frame, flow);
	yield* apply(w, calls, frame, flow);
	// A class decorator may return a replacement for the class.
	if (own.length > 0) w.replaceBinding(node, frame);
}

function memberAnnotations(member: ts.ClassElement): Array<ts.TypeNode | undefined> {
	if (ts.isPropertyDeclaration(member)) return [member.type];
	if (ts.isGetAccessorDeclaration(member)) return [member.type];
	if (ts.isSetAccessorDeclaration(member)) return [member.parameters[0]?.type];
	if (ts.isMethodDeclaration(member)) return [...member.parameters.map((parameter) => parameter.type), member.type];
	return [];
}

/** Reads the binding a design metadata annotation names, when it names one. */
function* readMetadata(w: Walker, annotation: ts.TypeNode | undefined, frame: Frame, flow: Flow): Step<void> {
	const read = metadataRead(w.pinned, annotation);
	if (read.kind === "none") return;
	if (read.kind === "unknown") {
		w.note(annotation);
		return;
	}
	yield* w.read(read.name, frame, flow);
}

function* apply(
	w: Walker,
	calls: ReadonlyArray<{ decorator: ts.Decorator; fn: Value; args: Value[] }>,
	frame: Frame,
	flow: Flow,
): Step<void> {
	for (const { decorator, fn, args } of [...calls].reverse()) {
		if (!flow.alive) return;
		yield* w.invoke(fn, UNDEFINED, { values: args, open: false }, decorator, frame, flow);
	}
}
