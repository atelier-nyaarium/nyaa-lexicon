import type { Position, Range } from "@nyaa-lexicon/protocol";

/** Syntax only. Derived facts live in `environment.ts`. */
export interface SyntaxNode {
	type: string;
	named: boolean;
	missing: boolean;
	field: string | null;
	start: number;
	end: number;
	parent: SyntaxNode | null;
	children: SyntaxNode[];
}

export interface SyntaxTree {
	root: SyntaxNode;
	/** Source-order leaves, comments included. */
	leaves: SyntaxNode[];
}

export const COMMENT_TYPES: ReadonlySet<string> = new Set(["line_comment", "block_comment", "shebang"]);

export const STRING_TYPES: ReadonlySet<string> = new Set([
	"string_literal",
	"multiline_string_literal",
	"character_literal",
]);

/** Parents first. */
export function nodesOf(node: SyntaxNode): SyntaxNode[] {
	const found: SyntaxNode[] = [];
	const stack = [node];
	while (stack.length > 0) {
		const current = stack.pop() as SyntaxNode;
		found.push(current);
		for (const child of current.children) stack.push(child);
	}
	return found;
}

/** Backticks quote, not the name. */
export function nameText(text: string, node: SyntaxNode): string {
	const raw = text.slice(node.start, node.end);
	return raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
}

export function childOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
	return node.children.find((child) => child.type === type);
}

export function childrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
	return node.children.filter((child) => child.type === type);
}

export class LineTable {
	private readonly starts: number[] = [0];

	constructor(text: string) {
		for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1))
			this.starts.push(index + 1);
	}

	position(offset: number): Position {
		let low = 0;
		let high = this.starts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((this.starts[middle] as number) <= offset) low = middle;
			else high = middle - 1;
		}
		return { line: low, character: offset - (this.starts[low] as number) };
	}

	range(start: number, end: number): Range {
		return { start: this.position(start), end: this.position(end) };
	}
}
