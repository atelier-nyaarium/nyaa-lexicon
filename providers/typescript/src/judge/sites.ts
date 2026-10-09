// Call sites: how a call on the walk's stack is named, and where its callee and arguments sit.

import ts from "typescript";
import { rangeOf } from "../ranges.js";
import type { CallSite } from "./model.js";
import { unwrapExpression } from "./symbols.js";
import type { Walker } from "./walker.js";

////////////////////////////////
//  Functions & Helpers

export function calleeName(site: ts.Node): ts.Identifier | ts.PrivateIdentifier | undefined {
	const expression =
		ts.isCallExpression(site) || ts.isNewExpression(site)
			? unwrapExpression(site.expression)
			: ts.isTaggedTemplateExpression(site)
				? unwrapExpression(site.tag)
				: ts.isDecorator(site)
					? unwrapExpression(site.expression)
					: undefined;
	if (expression === undefined) return undefined;
	if (ts.isIdentifier(expression)) return expression;
	if (ts.isPropertyAccessExpression(expression)) return expression.name;
	if (ts.isCallExpression(expression)) return calleeName(expression);
	return undefined;
}

export function argumentNode(site: ts.Node, at: number): ts.Node | undefined {
	if (at < 0) {
		const callee = ts.isCallExpression(site) ? unwrapExpression(site.expression) : undefined;
		return callee !== undefined && ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
	}
	if (ts.isCallExpression(site) || ts.isNewExpression(site)) return site.arguments?.[at];
	return undefined;
}

/** A call on the stack, named by its callee as written. */
export function callSite(site: ts.Node, walker: Walker): CallSite {
	const source = site.getSourceFile();
	const name = ts.isIdentifier(site) || ts.isPrivateIdentifier(site) ? site : calleeName(site);
	const at = name ?? site;
	return {
		module: walker.pinned.moduleOf(source) ?? "",
		range: rangeOf(at, source),
		name: name?.text ?? "anonymous",
		node: site,
	};
}
