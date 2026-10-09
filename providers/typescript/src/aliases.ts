// One step along an import or export alias.

import type ts from "typescript";

/**
 * The symbol an alias names directly. A synthetic alias, such as the `default` the checker gives a
 * CommonJS module's dynamic import, has no declaration and so no step; the checker asserts on one.
 */
export function immediateAliasTarget(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined {
	if ((symbol.declarations ?? []).length === 0) return undefined;
	return checker.getImmediateAliasedSymbol(symbol);
}
