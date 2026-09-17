import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Position, Range } from "@nyaa-lexicon/protocol";
import { Language, Parser } from "web-tree-sitter";

/** Bundled path, else installed package. */
function runtimeWasm(): string {
	const beside = fileURLToPath(new URL("./web-tree-sitter.wasm", import.meta.url));
	if (existsSync(beside)) return beside;
	return createRequire(import.meta.url).resolve("web-tree-sitter/web-tree-sitter.wasm");
}

await Parser.init({ locateFile: () => runtimeWasm() });
const KOTLIN = await Language.load(readFileSync(fileURLToPath(new URL("./tree-sitter-kotlin.wasm", import.meta.url))));
const parser = new Parser();
parser.setLanguage(KOTLIN);

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

const MISREAD_WORDS: ReadonlySet<string> = new Set([
	"class",
	"do",
	"else",
	"for",
	"fun",
	"if",
	"import",
	"interface",
	"object",
	"package",
	"try",
	"typealias",
	"val",
	"var",
	"when",
	"while",
]);

/** Plain nodes; offsets count `text`. */
export function readMask(text: string, mask: string): SyntaxTree {
	// Scanner stalls at EOF post-annotation.
	const tree = parser.parse(mask.endsWith("\n") ? mask : `${mask}\n`);
	if (tree === null) throw new Error("the Kotlin grammar produced no tree");
	const cursor = tree.walk();
	const make = (parent: SyntaxNode | null): SyntaxNode => ({
		type: cursor.nodeType,
		named: cursor.nodeIsNamed,
		missing: cursor.nodeIsMissing,
		field: cursor.currentFieldName,
		start: Math.min(cursor.startIndex, text.length),
		end: Math.min(cursor.endIndex, text.length),
		parent,
		children: [],
	});
	const root = make(null);
	const leaves: SyntaxNode[] = [];
	let current = root;
	for (;;) {
		if (cursor.gotoFirstChild()) {
			const child = make(current);
			current.children.push(child);
			current = child;
			continue;
		}
		leaves.push(current);
		let advanced = false;
		while (!advanced) {
			if (cursor.gotoNextSibling()) {
				const parent = current.parent as SyntaxNode;
				const sibling = make(parent);
				parent.children.push(sibling);
				current = sibling;
				advanced = true;
			} else if (cursor.gotoParent()) {
				current = current.parent as SyntaxNode;
			} else {
				cursor.delete();
				tree.delete();
				return { root, leaves };
			}
		}
	}
}

export function leavesOf(node: SyntaxNode): SyntaxNode[] {
	const leaves: SyntaxNode[] = [];
	const stack = [node];
	while (stack.length > 0) {
		const current = stack.pop() as SyntaxNode;
		if (current.children.length === 0) leaves.push(current);
		for (let index = current.children.length - 1; index >= 0; index--)
			stack.push(current.children[index] as SyntaxNode);
	}
	return leaves;
}

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

export function isProblem(node: SyntaxNode): boolean {
	return node.type === "ERROR" || node.missing;
}

/** Outermost only, source order. */
export function outermostProblems(root: SyntaxNode): SyntaxNode[] {
	const found: SyntaxNode[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (isProblem(node)) {
			found.push(node);
			continue;
		}
		for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index] as SyntaxNode);
	}
	return found;
}

/** For a window's reading. */
export function shift(root: SyntaxNode, by: number): void {
	for (const node of nodesOf(root)) {
		node.start += by;
		node.end += by;
	}
}

/** Deepest spanning node only. */
export function insertLeaf(root: SyntaxNode, leaf: SyntaxNode): void {
	let parent = root;
	for (;;) {
		const inner = parent.children.find((child) => child.start <= leaf.start && leaf.end <= child.end);
		if (inner === undefined || inner.children.length === 0) break;
		parent = inner;
	}
	const copy: SyntaxNode = { ...leaf, field: null, parent, children: [] };
	const at = parent.children.findIndex((child) => child.start >= leaf.end);
	if (at < 0) parent.children.push(copy);
	else parent.children.splice(at, 0, copy);
}

export function nodeAt(root: SyntaxNode, type: string, start: number): SyntaxNode | undefined {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (node.type === type && node.start === start) return node;
		for (const child of node.children) if (child.start <= start && start < child.end) stack.push(child);
	}
	return undefined;
}

/** No grammar reading names it. */
export function misreadKeyword(text: string, leaf: SyntaxNode): boolean {
	if (leaf.type !== "identifier") return false;
	const word = text.slice(leaf.start, leaf.end);
	if (!MISREAD_WORDS.has(word)) return false;
	const siblings = leaf.parent?.children ?? [];
	return !(word === "class" && siblings[siblings.indexOf(leaf) - 1]?.type === "::");
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
