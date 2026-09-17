import type { Metrics } from "@nyaa-lexicon/protocol";
import type { SyntaxNode } from "./tree.js";

const BRANCH_KEYWORDS: ReadonlySet<string> = new Set(["if", "when", "for", "while", "catch"]);

/** The body's own braces are excluded. */
export function bodyMetrics(leaves: SyntaxNode[], body: SyntaxNode | undefined): Pick<Metrics, "nesting" | "branches"> {
	if (body === undefined) return {};
	let low = 0;
	let high = leaves.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((leaves[middle] as SyntaxNode).start <= body.start) low = middle + 1;
		else high = middle;
	}
	let depth = 0;
	let nesting = 0;
	let branches = 1;
	for (let index = low; index < leaves.length; index++) {
		const leaf = leaves[index] as SyntaxNode;
		if (leaf.start >= body.end - 1) break;
		if (leaf.type === "{") nesting = Math.max(nesting, ++depth);
		else if (leaf.type === "}") depth = Math.max(0, depth - 1);
		else if (BRANCH_KEYWORDS.has(leaf.type)) branches++;
	}
	return { nesting, branches };
}
