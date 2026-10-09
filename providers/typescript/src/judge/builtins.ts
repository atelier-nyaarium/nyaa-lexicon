// Built-in prototypes: what a chain the walk follows to its end inherits, as the lib declares it.

import ts from "typescript";
import { UNDEFINED, UNKNOWN, type Value } from "./model.js";
import type { Walker } from "./walker.js";

////////////////////////////////
//  Built-in prototypes

/** Each built-in prototype's chain, by its global's name. */
function builtinChain(global: string): readonly string[] {
	return global === "Object" ? ["Object"] : [global, "Object"];
}

/** A built-in prototype's declared member, through the lib's interfaces up its chain. */
function builtinProperty(w: Walker, global: string, key: string): ts.Symbol | "missing" | undefined {
	// Names the lib leaves out, which hosts still define.
	if (key.startsWith("__")) return undefined;
	for (const name of builtinChain(global)) {
		const symbol = w.checker.resolveName(name, undefined, ts.SymbolFlags.Type, false);
		if (symbol === undefined) return undefined;
		const property = w.checker.getPropertyOfType(w.checker.getDeclaredTypeOfSymbol(symbol), key);
		if (property !== undefined) {
			const declarations = property.declarations ?? [];
			if (
				declarations.length === 0 ||
				!declarations.every((declaration) =>
					w.pinned.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
				)
			)
				return undefined;
			return property;
		}
	}
	return "missing";
}

/** Whether a built-in prototype holds a member; undefined where the lib does not say. */
export function builtinHas(w: Walker, global: string, key: string): boolean | undefined {
	const property = builtinProperty(w, global, key);
	if (property !== "missing") return undefined;
	return w.writes.opaqueBuiltinMissing || w.writes.untrackedNames.has(key) ? undefined : false;
}

/**
 * A built-in prototype's member, as the lib declares it: a library function where its type is
 * callable, else unknown; undefined where none is declared.
 */
export function builtinMember(w: Walker, global: string, key: string | undefined): Value {
	const property = key === undefined ? undefined : builtinProperty(w, global, key);
	if (property === undefined) return UNKNOWN;
	if (property === "missing")
		return key !== undefined && (w.writes.opaqueBuiltinMissing || w.writes.untrackedNames.has(key))
			? UNKNOWN
			: UNDEFINED;
	return UNKNOWN;
}

/** The built-in prototype a primitive's member comes from. */
export function boxOf(value: string | number | boolean | bigint): string {
	return typeof value === "string"
		? "String"
		: typeof value === "number"
			? "Number"
			: typeof value === "boolean"
				? "Boolean"
				: "BigInt";
}
