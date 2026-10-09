// Classes, enums and namespaces: when each definition runs, what it reads, and what it initializes.

import ts from "typescript";
import {
	decorate,
	decorated,
	decoratesParameters,
	evaluateDecorators,
	fieldDefined,
	fieldValue,
	legacyDecorators,
	type Pending,
	runInitializers,
} from "./decorators.js";
import {
	type ClassValue,
	type Flow,
	type Frame,
	isConstructor,
	isObject,
	joinValues,
	literal,
	MAX_DEPTH,
	type TrackedObject,
	type Tri,
	UNDEFINED,
	UNKNOWN,
	type Value,
} from "./model.js";
import { callSite } from "./sites.js";
import { declarationOf, hasModifier, isAmbient, isStatic, memberName } from "./symbols.js";
import type { Args, Step, Walker } from "./walker.js";

////////////////////////////////
//  Interfaces & Types

/** A class member found by name: a method, an accessor pair, or a base the walk cannot read. */
export interface Member {
	readonly method?: Value;
	readonly getter?: Value;
	readonly setter?: Value;
	readonly unknown?: boolean;
}

////////////////////////////////
//  Functions & Helpers

/** Whether fields are defined, rather than assigned through inherited setters. */
function definesFields(options: ts.CompilerOptions): boolean {
	return options.useDefineForClassFields ?? (options.target ?? ts.ScriptTarget.ES5) >= ts.ScriptTarget.ES2022;
}

/** Finds a method or accessor by name up a class's base chain; one a decorator replaced is unknown. */
export function classMember(w: Walker, owner: ClassValue, name: string, statics: boolean): Member | undefined {
	let current: ClassValue = owner;
	for (let depth = 0; depth < MAX_DEPTH * 4; depth++) {
		if (w.decorations.get(current.id)?.replaced.has(`${statics ? "static " : ""}${name}`) === true)
			return { unknown: true };
		let found: Member | undefined;
		for (const member of current.node.members) {
			if (isStatic(member) !== statics || memberName(member.name) !== name) continue;
			const value: Value = { kind: "function", node: member as ts.FunctionLikeDeclaration, scope: current.scope };
			if (ts.isMethodDeclaration(member) && member.body !== undefined) found = { ...found, method: value };
			else if (ts.isGetAccessorDeclaration(member) && member.body !== undefined)
				found = { ...found, getter: value };
			else if (ts.isSetAccessorDeclaration(member) && member.body !== undefined)
				found = { ...found, setter: value };
		}
		if (found !== undefined) return found;
		const base = w.bases.get(current.id);
		if (base === undefined || base === null) return undefined;
		if (base.kind !== "class") return { unknown: true };
		current = base;
	}
	return { unknown: true };
}

////////////////////////////////
//  Classes

export function* classDeclaration(w: Walker, node: ts.ClassDeclaration, frame: Frame, flow: Flow): Step<void> {
	if (isAmbient(node)) return;
	const value = yield* defineClass(w, node, frame, flow);
	if (!flow.alive) return;
	const replaced = w.decorations.get(value.id)?.replacedClass === true;
	w.initialize(node, replaced ? UNKNOWN : value, frame, flow);
	yield* legacyDecorators(w, node, value, frame, flow);
}

export function* classExpression(w: Walker, node: ts.ClassExpression, frame: Frame, flow: Flow): Step<Value> {
	const value = yield* defineClass(w, node, frame, flow);
	return w.decorations.get(value.id)?.replacedClass === true ? UNKNOWN : value;
}

/**
 * A class definition: standard class decorators, its base, computed names, standard decorators
 * applied, then static fields and blocks in order. Its own name reads as the class inside its body
 * from the start; outside, only once the definition completes.
 */
function* defineClass(w: Walker, node: ts.ClassLikeDeclaration, frame: Frame, flow: Flow): Step<ClassValue> {
	const module = w.touch(node) ?? frame.module;
	const statics = w.newObject({ label: "object", base: [...flow.guards] });
	const value: ClassValue = { kind: "class", node, scope: frame, id: statics.id };
	const options = w.pinned.options(module);
	const standard = decorated(node) && options.experimentalDecorators !== true;
	// Native decorators evaluate with their member; TypeScript's emit, a named member's after every key.
	const native = (options.target ?? ts.ScriptTarget.ES5) >= ts.ScriptTarget.ESNext;
	const pending: Pending[] = [];
	if (standard) {
		if (decoratesParameters(node)) w.unseen(node);
		pending.push({ member: undefined, decorators: yield* evaluateDecorators(w, node, frame, flow) });
	}
	let base: Value | null = null;
	const heritage = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
	const extended = heritage?.types[0]?.expression;
	if (extended !== undefined && flow.alive) {
		const read = yield* w.expr(extended, frame, flow);
		base = read.kind === "literal" && read.value === null ? null : read;
		// Extending what is neither a constructor nor null throws before the body runs.
		if (base !== null && isConstructor(base) === false) w.throwExit(flow, false);
	}
	if (!flow.alive) return value;
	w.bases.set(value.id, base);
	w.classes.set(node, value);
	const evaluated = new Set<ts.ClassElement>();
	for (const member of node.members) {
		if (!flow.alive) return value;
		const computed = member.name !== undefined && ts.isComputedPropertyName(member.name);
		if (standard && (computed || native) && ts.canHaveDecorators(member)) {
			pending.push({ member, decorators: yield* evaluateDecorators(w, member, frame, flow) });
			evaluated.add(member);
		}
		if (member.name !== undefined && ts.isComputedPropertyName(member.name))
			yield* w.expr(member.name.expression, frame, flow);
	}
	if (standard) {
		for (const member of node.members) {
			if (!flow.alive) return value;
			if (!evaluated.has(member) && ts.canHaveDecorators(member))
				pending.push({ member, decorators: yield* evaluateDecorators(w, member, frame, flow) });
		}
		if (flow.alive) yield* decorate(w, value, pending, frame, flow);
	}
	const decoration = w.decorations.get(value.id);
	const self: Value = decoration?.replacedClass === true ? UNKNOWN : value;
	const start: Frame = { module, vars: new Map(), parent: frame, thisValue: value, fn: node, base: [...flow.guards] };
	if (decoration !== undefined && flow.alive) yield* runInitializers(w, decoration.statics, self, node, start, flow);
	for (const member of node.members) {
		if (!flow.alive) return value;
		const inner: Frame = { ...start, vars: new Map(), fn: member };
		if (ts.isClassStaticBlockDeclaration(member)) {
			yield* w.statements(member.body.statements, inner, flow);
		} else if (ts.isPropertyDeclaration(member) && isStatic(member) && !isAmbient(member)) {
			let initial = member.initializer === undefined ? UNDEFINED : yield* w.expr(member.initializer, inner, flow);
			if (decoration !== undefined) initial = yield* fieldValue(w, value, member, initial, self, inner, flow);
			const key = memberName(member.name);
			if (key === undefined) statics.open = true;
			else w.setProp(statics, key, initial, flow);
			if (decoration !== undefined) yield* fieldDefined(w, value, member, self, inner, flow);
		}
	}
	if (decoration !== undefined && flow.alive) yield* runInitializers(w, decoration.classes, self, node, start, flow);
	return value;
}

////////////////////////////////
//  Construction

/** `new C(...)`: a fresh instance through the constructor chain, fields as each class defines them. */
export function* construct(w: Walker, owner: ClassValue, args: Args, site: ts.Node, flow: Flow): Step<Value> {
	const instance = w.newObject({ label: "instance", instanceOf: owner, base: [...flow.guards] });
	const self: Value = { kind: "object", id: instance.id };
	return yield* runConstructor(w, owner, self, args, site, flow);
}

/** Runs a class's constructor on `self`, and answers what `new` gives: `self`, or an object a `return` gave. */
function* runConstructor(
	w: Walker,
	owner: ClassValue,
	self: Value,
	args: Args,
	site: ts.Node,
	flow: Flow,
): Step<Value> {
	const node = owner.node;
	if (w.active.has(node) || w.stack.length >= MAX_DEPTH) {
		w.unseen(site);
		w.throwExit(flow, true);
		return UNKNOWN;
	}
	const module = w.touch(node) ?? owner.scope.module;
	const initializer = node.members.find(
		(member): member is ts.ConstructorDeclaration =>
			ts.isConstructorDeclaration(member) && member.body !== undefined,
	);
	const base = w.bases.get(owner.id) ?? null;
	// A derived constructor's `this` is bound by its `super()` call.
	const derived = base !== null && initializer !== undefined;
	const frame: Frame = {
		module,
		vars: new Map(),
		parent: owner.scope,
		thisValue: self,
		fn: initializer ?? node,
		base: [...flow.guards],
		...(derived ? { thisInit: { state: "no" as const } } : {}),
	};
	const inner = w.branch(flow);
	w.active.add(node);
	w.stack.push(callSite(site, w));
	try {
		if (initializer === undefined) {
			if (base !== null) yield* constructBase(w, base, self, args, site, inner);
			if (inner.alive) yield* initializeFields(w, owner, self, inner);
		} else {
			if (base === null) yield* initializeFields(w, owner, self, inner);
			if (inner.alive) yield* w.bindParameters(initializer, args, frame, inner);
			if (inner.alive) yield* w.statements(initializer.body?.statements ?? [], frame, inner);
		}
	} finally {
		w.active.delete(node);
		w.stack.pop();
	}
	const throws = inner.exits.filter((exit) => exit.kind === "throw");
	const returns = inner.exits.filter((exit) => exit.kind === "return");
	flow.exits.push(...throws);
	if (!inner.alive && returns.length === 0) {
		flow.alive = false;
		return UNKNOWN;
	}
	if (throws.length > 0) flow.guards = w.dependent(flow.guards, throws);
	const bound = frame.thisInit?.state ?? "yes";
	const completions = [...returns.map((exit) => exit.value ?? UNDEFINED), ...(inner.alive ? [UNDEFINED] : [])];
	const outcomes = completions.map((value) => completion(value, self, derived, bound));
	const kept = outcomes.flatMap((outcome) => (outcome.throws === "yes" ? [] : [outcome.value]));
	if (outcomes.length > 0 && kept.length === 0) {
		w.throwExit(flow, false);
		return UNKNOWN;
	}
	if (outcomes.some((outcome) => outcome.throws !== "no")) w.throwExit(flow, true);
	return kept.reduce(joinValues, kept[0] ?? self);
}

/**
 * What `new` gives for one way a constructor completes. A returned object replaces the instance; a
 * base class ignores a returned primitive. A derived class's must be an object, or undefined once
 * `super()` bound `this`; anything else throws.
 */
function completion(value: Value, self: Value, derived: boolean, bound: Tri): { value: Value; throws: Tri } {
	const object = isObject(value);
	if (object === true) return { value, throws: "no" };
	if (object === undefined) return { value: UNKNOWN, throws: derived ? "maybe" : "no" };
	if (!derived) return { value: self, throws: "no" };
	if (!(value.kind === "literal" && value.value === undefined)) return { value: self, throws: "yes" };
	return { value: self, throws: bound === "yes" ? "no" : bound === "no" ? "yes" : "maybe" };
}

function* constructBase(w: Walker, base: Value, self: Value, args: Args, site: ts.Node, flow: Flow): Step<void> {
	if (base.kind === "class") {
		const made = yield* runConstructor(w, base, self, args, site, flow);
		// A base that returns another object makes it this class's `this`, which the walk does not follow.
		const same = made.kind === "object" && self.kind === "object" && made.id === self.id;
		if (flow.alive && !same) w.halt(site);
		return;
	}
	// A base the walk cannot see runs with this instance, whose overrides it may call.
	w.opaqueCall(site, self, args, flow);
}

/** `super(...)` in a derived constructor: the base's construction, then this class's fields. */
export function* superCall(w: Walker, node: ts.CallExpression, frame: Frame, flow: Flow): Step<Value> {
	let initializer: ts.ConstructorDeclaration | undefined;
	let self: Value = frame.thisValue;
	let constructing: Frame | undefined;
	for (let scope: Frame | null = frame; scope !== null; scope = scope.parent) {
		if (scope.fn !== null && ts.isConstructorDeclaration(scope.fn)) {
			initializer = scope.fn;
			self = scope.thisValue;
			constructing = scope;
			break;
		}
	}
	const owner = initializer === undefined ? undefined : w.classes.get(initializer.parent);
	const values: Value[] = [];
	let open = false;
	for (const argument of node.arguments) {
		if (ts.isSpreadElement(argument)) {
			yield* w.expr(argument.expression, frame, flow);
			w.unseen(argument);
			open = true;
			break;
		}
		values.push(yield* w.expr(argument, frame, flow));
	}
	if (owner === undefined || !flow.alive) {
		w.unseen(node);
		return UNKNOWN;
	}
	const base = w.bases.get(owner.id) ?? null;
	if (base !== null) yield* constructBase(w, base, self, { values, open }, node, flow);
	if (!flow.alive) return UNKNOWN;
	// Binding `this` a second time throws once the base has run.
	const init = constructing?.thisInit;
	if (init !== undefined) {
		if (init.state === "yes") {
			w.throwExit(flow, false);
			return UNKNOWN;
		}
		if (init.state === "maybe") w.throwExit(flow, true);
		init.state = w.conditional(flow, constructing?.base) ? "maybe" : "yes";
	}
	yield* initializeFields(w, owner, self, flow);
	return self;
}

/** Instance fields in order: defined, or assigned through inherited setters when emit assigns them. */
function* initializeFields(w: Walker, owner: ClassValue, self: Value, flow: Flow): Step<void> {
	const node = owner.node;
	const module = w.pinned.moduleOf(node.getSourceFile()) ?? owner.scope.module;
	const defines = definesFields(w.pinned.options(module));
	const instance = w.objectOf(self);
	const decoration = w.decorations.get(owner.id);
	const start: Frame = {
		module,
		vars: new Map(),
		parent: owner.scope,
		thisValue: self,
		fn: node,
		base: [...flow.guards],
	};
	if (decoration !== undefined) yield* runInitializers(w, decoration.instances, self, node, start, flow);
	for (const member of node.members) {
		if (!flow.alive) return;
		if (!ts.isPropertyDeclaration(member) || isStatic(member) || isAmbient(member)) continue;
		if (hasModifier(member, ts.SyntaxKind.AbstractKeyword) || hasModifier(member, ts.SyntaxKind.DeclareKeyword))
			continue;
		const frame: Frame = { ...start, vars: new Map(), fn: member };
		let initial = member.initializer === undefined ? UNDEFINED : yield* w.expr(member.initializer, frame, flow);
		if (decoration !== undefined) initial = yield* fieldValue(w, owner, member, initial, self, frame, flow);
		const key = memberName(member.name);
		if (key === undefined) {
			if (instance !== undefined) instance.open = true;
		} else if (!defines && member.initializer !== undefined) {
			yield* w.setMember(self, key, initial, member, frame, flow);
		} else if (instance !== undefined && (defines || member.initializer !== undefined))
			instance.props.set(key, { state: "yes", value: initial });
		if (decoration !== undefined) yield* fieldDefined(w, owner, member, self, frame, flow);
	}
}

////////////////////////////////
//  Enums and namespaces

/** The object a merged enum or namespace's first declaration made, or a new one. */
function mergedObject(
	w: Walker,
	first: ts.Node,
	frame: Frame,
	create: () => TrackedObject,
): { object: TrackedObject; fresh: boolean } {
	const held = w.bindings.get(first)?.value ?? frame.vars.get(first);
	const existing = held === undefined ? undefined : w.objectOf(held);
	return existing === undefined ? { object: create(), fresh: true } : { object: existing, fresh: false };
}

/** An enum's object exists from its statement; each member is set as its initializer runs. */
export function* enumDeclaration(w: Walker, node: ts.EnumDeclaration, frame: Frame, flow: Flow): Step<void> {
	if (isAmbient(node)) return;
	const module = w.touch(node) ?? frame.module;
	const options = w.pinned.options(module);
	const constant = hasModifier(node, ts.SyntaxKind.ConstKeyword);
	if (constant && options.preserveConstEnums !== true && options.isolatedModules !== true) return;
	const symbol = w.checker.getSymbolAtLocation(node.name);
	const first = declarationOf(symbol) ?? node;
	const names = new Set(
		(symbol?.declarations ?? []).flatMap((declaration) =>
			ts.isEnumDeclaration(declaration)
				? declaration.members.flatMap((member) => memberName(member.name) ?? [])
				: [],
		),
	);
	const { object, fresh } = mergedObject(w, first, frame, () =>
		w.newObject({ label: "enum", owner: module, symbol, assigns: names }),
	);
	if (fresh) w.initialize(first, { kind: "object", id: object.id }, frame, flow);
	const inner: Frame = {
		module,
		vars: new Map(),
		parent: frame,
		thisValue: UNDEFINED,
		fn: node,
		namespace: object.id,
	};
	let next: Value = literal(0);
	for (const member of node.members) {
		if (!flow.alive) return;
		const value = member.initializer === undefined ? next : yield* w.expr(member.initializer, inner, flow);
		const key = memberName(member.name);
		if (key !== undefined) w.setProp(object, key, value, flow);
		next = value.kind === "literal" && typeof value.value === "number" ? literal(value.value + 1) : UNKNOWN;
	}
}

/** An instantiated namespace's object exists from its statement; each export is set where it stands. */
export function* namespaceDeclaration(w: Walker, node: ts.ModuleDeclaration, frame: Frame, flow: Flow): Step<void> {
	if (isAmbient(node) || !ts.isIdentifier(node.name) || node.body === undefined) return;
	const symbol = w.checker.getSymbolAtLocation(node.name);
	if (symbol === undefined || (symbol.flags & ts.SymbolFlags.ValueModule) === 0) return;
	const module = w.touch(node) ?? frame.module;
	const merged = (symbol.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) !== 0;
	if (merged) {
		// A namespace merged with a function, class or enum writes onto that value: not modeled.
		w.unseen(node);
		return;
	}
	const first = declarationOf(symbol) ?? node;
	const names = new Set(w.checker.getExportsOfModule(symbol).map((exported) => exported.name));
	const { object, fresh } = mergedObject(w, first, frame, () =>
		w.newObject({ label: "namespace", owner: module, symbol, assigns: names }),
	);
	if (fresh) {
		w.initialize(first, { kind: "object", id: object.id }, frame, flow);
		const parent = node.parent;
		if (ts.isModuleDeclaration(parent)) {
			const outer = w.namespaceObject(frame, parent);
			if (outer !== undefined) w.setProp(outer, node.name.text, { kind: "object", id: object.id }, flow);
		}
	}
	const inner: Frame = {
		module,
		vars: new Map(),
		parent: frame,
		thisValue: UNDEFINED,
		fn: node,
		namespace: object.id,
	};
	const body = node.body;
	if (ts.isModuleBlock(body)) yield* w.statements(body.statements, inner, flow);
	else if (ts.isModuleDeclaration(body)) yield* namespaceDeclaration(w, body, inner, flow);
}
