// A declaration's header spans, handed to the protocol's one renderer.

import { type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";
import { COMMENT_TYPES, childOfType, STRING_TYPES, type SyntaxNode } from "./tree.js";

////////////////////////////////
//  Functions & Helpers

/** The folded span of a literal container written as a value. */
function containerOf(node: SyntaxNode): SyntaxNode | undefined {
	switch (node.type) {
		case "lambda_literal":
		case "collection_literal":
			return node;
		case "anonymous_function": {
			const body = childOfType(node, "function_body");
			return body === undefined ? undefined : childOfType(body, "block");
		}
		case "object_literal":
			return childOfType(node, "class_body");
		default:
			return undefined;
	}
}

/** Comments, literals and outermost containers between `start` and `end`, never inside a fold or literal. */
function rendered(text: string, nodes: readonly SyntaxNode[], start: number, end: number, fold: boolean) {
	const folds: OffsetRange[] = [];
	const omit: OffsetRange[] = [];
	const verbatim: OffsetRange[] = [];
	const stack = [...nodes];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (node.end <= start || node.start >= end) continue;
		if (COMMENT_TYPES.has(node.type)) {
			omit.push({ start: node.start, end: node.end });
			continue;
		}
		// Templates stay whole.
		if (STRING_TYPES.has(node.type)) {
			verbatim.push({ start: node.start, end: node.end });
			continue;
		}
		const container = fold ? containerOf(node) : undefined;
		if (container !== undefined) folds.push({ start: container.start, end: container.end });
		for (const child of node.children) if (child !== container) stack.push(child);
	}
	return renderHeader(text, { start, end, folds, omit, verbatim });
}

/**
 * One line from the first of `nodes`, contiguous siblings, to where `body` begins, else to the
 * last node's end. Literal containers fold.
 */
export function headerOf(text: string, nodes: readonly SyntaxNode[], body?: SyntaxNode): string | undefined {
	const first = nodes[0];
	const last = nodes.at(-1);
	if (first === undefined || last === undefined) return undefined;
	return rendered(text, nodes, first.start, body?.start ?? last.end, true);
}

/** A parameter or binder: its contiguous siblings on one line, containers kept. */
export function parameterHeaderOf(text: string, nodes: readonly SyntaxNode[]): string | undefined {
	const first = nodes[0];
	const last = nodes.at(-1);
	if (first === undefined || last === undefined) return undefined;
	return rendered(text, nodes, first.start, last.end, false);
}
