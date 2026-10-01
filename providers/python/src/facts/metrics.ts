// Size and shape of a declaration: its lines, and for a function its parameters, deepest block and
// branch count.

import type * as A from "../syntax/ast.js";
import { isFunction, NodeVisitor, parameters } from "./nodes.js";
import type { Range, RawMetrics } from "./types.js";

////////////////////////////////
//  Constants

/** Blocks and the branches each adds. */
const BLOCKS: ReadonlyMap<A.Node["type"], number> = new Map([
	["If", 1],
	["For", 1],
	["AsyncFor", 1],
	["While", 1],
	["With", 0],
	["AsyncWith", 0],
	["Try", 0],
	["TryStar", 0],
	["ExceptHandler", 1],
]);

const SCOPES: ReadonlySet<A.Node["type"]> = new Set(["FunctionDef", "AsyncFunctionDef", "ClassDef", "Lambda"]);

////////////////////////////////
//  Classes

class MetricsVisitor extends NodeVisitor {
	private depth = 0;
	nesting = 0;
	branches = 1;

	override visit(node: A.Node): void {
		if (SCOPES.has(node.type)) return;
		const branches = node.type === "Match" ? node.cases.length : BLOCKS.get(node.type);
		if (branches !== undefined) {
			this.depth++;
			this.nesting = Math.max(this.nesting, this.depth);
			this.branches += branches;
			this.genericVisit(node);
			this.depth--;
			return;
		}
		if (node.type === "IfExp") this.branches++;
		else if (node.type === "BoolOp") this.branches += Math.max(0, node.values.length - 1);
		else if (node.type === "comprehension") this.branches += 1 + node.ifs.length;
		this.genericVisit(node);
	}
}

////////////////////////////////
//  Main

export function metricsOf(node: A.Node, range: Range): RawMetrics {
	const metrics: RawMetrics = { lines: range.end.line - range.start.line + 1 };
	if (isFunction(node)) {
		metrics.parameters = parameters(node.args).length;
		const visitor = new MetricsVisitor();
		for (const statement of node.body) visitor.visit(statement);
		metrics.nesting = visitor.nesting;
		metrics.branches = visitor.branches;
	}
	return metrics;
}
