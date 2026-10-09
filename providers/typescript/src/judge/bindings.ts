// Bindings and properties: when each is initialized, what it holds, and what a write on some paths makes of it.

import ts from "typescript";
import { exportedNames, initializeExports } from "./loader.js";
import {
	conditional,
	type Flow,
	type Frame,
	type Guard,
	held,
	joinValues,
	type TrackedObject,
	UNDEFINED,
	UNKNOWN,
	underGuards,
	type Value,
	written,
} from "./model.js";
import { isRuntimeName } from "./names.js";
import {
	bindingKind,
	declarationOf,
	isExternal,
	isModuleScoped,
	nameOfDeclaration,
	valueDeclaration,
} from "./symbols.js";
import type { Read, Walker } from "./walker.js";

////////////////////////////////
//  Functions & Helpers

/**
 * What a write on this path stores where `base`, the guards its target came with, held. Under further
 * conditions it may not happen, so it joins what was there, and depends on those conditions.
 */
export function stored(before: Value | undefined, value: Value, flow: Flow, base: readonly Guard[]): Value {
	const extra = base.length === 0 ? flow.guards : flow.guards.filter((guard) => !base.includes(guard));
	const uncertain = conditional(extra);
	if (!uncertain && !extra.some((guard) => guard.repeats === true)) return held(value);
	const here = underGuards(held(value), extra);
	return uncertain && before !== undefined ? joinValues(before, here) : here;
}

////////////////////////////////
//  Bindings

/** An initialization event: a declarator, a class definition, an import's capture. */
export function initialize(w: Walker, binding: ts.Node, value: Value, frame: Frame, flow: Flow): void {
	// A binding other code reassigns holds no value the walk can name, nor do the exports it sets.
	const kept = w.writes.bindings.has(binding) ? UNKNOWN : value;
	if (isModuleScoped(binding)) {
		const before = w.bindings.get(binding);
		w.bindings.set(binding, {
			init: written(before?.init, w.conditional(flow)),
			value: stored(before?.init === "no" ? undefined : before?.value, kept, flow, []),
		});
		initializeExports(w, binding, kept, flow);
		return;
	}
	// A local exists from here, or for a `var` from its function's start, holding undefined.
	const isVar = bindingKind(binding) === "var";
	const home = isVar ? (frame.base ?? []) : flow.guards;
	frame.vars.set(binding, stored(frame.vars.get(binding) ?? (isVar ? UNDEFINED : undefined), kept, flow, home));
	const namespace = w.namespaceOf(frame, binding);
	if (namespace !== undefined) setProp(w, namespace, nameOfDeclaration(binding), kept, flow);
}

export function setProp(w: Walker, object: TrackedObject, name: string, value: Value, flow: Flow): void {
	const before = object.props.get(name);
	const base = object.base ?? [];
	object.props.set(name, {
		state: written(before?.state, w.conditional(flow, base)),
		value: stored(before === undefined || before.state === "no" ? undefined : before.value, value, flow, base),
	});
}

/** A module-level binding's state at a read; a hazard when the walk proves it unset. */
export function readBinding(w: Walker, declaration: ts.Node, read: Read, flow: Flow): Value {
	w.touch(declaration);
	const state = w.bindings.get(declaration);
	if (state?.init === "yes") return state.value;
	if (state?.init === "maybe") {
		w.uncertain(read);
		return UNKNOWN;
	}
	const kind = bindingKind(declaration);
	const module = w.pinned.moduleOf(declaration.getSourceFile()) ?? read.module;
	// A function exists before its module runs; one the walk never instantiated is simply unknown.
	if (kind === "function") return state?.value ?? UNKNOWN;
	// Other code may have written a `var` already.
	if (kind === "var" && w.writes.bindings.has(declaration)) {
		w.uncertain(read);
		return UNKNOWN;
	}
	// An `import = require()` names the declaration its value comes from.
	const named = ts.isImportEqualsDeclaration(declaration)
		? valueDeclaration(w.checker, w.checker.getSymbolAtLocation(declaration.name))
		: declaration;
	const bad = w.hazard(read, { module, name: nameOfDeclaration(declaration), kind }, flow, named);
	if (temporalDeadZone(w, declaration, kind, module)) w.throwExit(flow, !bad);
	return UNDEFINED;
}

/** Whether reading the binding early throws, rather than answering undefined. */
function temporalDeadZone(w: Walker, declaration: ts.Node, kind: string, module: string): boolean {
	if (kind !== "let" && kind !== "const" && kind !== "class" && kind !== "default" && kind !== "import") return false;
	const record = w.modules.get(module);
	if (record?.runtime !== "cjs" || !record.esmSyntax || kind === "class" || kind === "import") return true;
	// A compiled CommonJS module reads its own exported variables as `exports` properties.
	return exportedNames(w, declaration).length === 0;
}

/** Writes a name: a module-level binding's value, a local, or CommonJS `exports`. */
export function writeName(w: Walker, node: ts.Identifier, value: Value, frame: Frame, flow: Flow): void {
	const record = w.modules.get(frame.module);
	if (isRuntimeName(w, node)) {
		if (node.text === "exports" && record?.runtime === "cjs") record.exportsVariable = value;
		return;
	}
	const symbol = ts.isShorthandPropertyAssignment(node.parent)
		? w.checker.getShorthandAssignmentValueSymbol(node.parent)
		: w.checker.getSymbolAtLocation(node);
	const declaration = declarationOf(symbol);
	if (declaration === undefined || isExternal(w.pinned, declaration)) return;
	// A reassigned binding holds what the walk cannot name: code it does not see may assign it too.
	if (isModuleScoped(declaration)) {
		const before = w.bindings.get(declaration);
		if (before !== undefined) w.bindings.set(declaration, { init: before.init, value: UNKNOWN });
		initializeExports(w, declaration, UNKNOWN, flow);
		return;
	}
	for (let scope: Frame | null = frame; scope !== null; scope = scope.parent) {
		if (scope.vars.has(declaration)) {
			scope.vars.set(declaration, UNKNOWN);
			return;
		}
	}
}
