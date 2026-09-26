import { COMMENT_TYPES, type LineTable, STRING_TYPES, type SyntaxNode } from "./tree.js";

const TIGHT_BEFORE: ReadonlySet<string> = new Set([
	"(",
	",",
	")",
	"]",
	"}",
	".",
	"?.",
	"::",
	":",
	"?",
	"!",
	"!!",
	";",
	"<",
	">",
]);

const TIGHT_AFTER: ReadonlySet<string> = new Set(["(", "[", "{", ".", "?.", "::", "@", "<"]);

/** Type text, spaced, comments dropped. */
export function renderType(text: string, nodes: SyntaxNode[], lines: LineTable): string {
	const parts: string[] = [];
	let previous = "";
	let lastLine = -1;
	const stack = [...nodes].reverse();
	while (stack.length > 0) {
		const node = stack.pop() as SyntaxNode;
		if (COMMENT_TYPES.has(node.type) || node.end === node.start) continue;
		if (node.children.length > 0 && !STRING_TYPES.has(node.type)) {
			for (let index = node.children.length - 1; index >= 0; index--)
				stack.push(node.children[index] as SyntaxNode);
			continue;
		}
		const value = text.slice(node.start, node.end);
		const line = lines.position(node.start).line;
		if (lastLine >= 0 && line > lastLine) {
			parts.push("\n".repeat(line - lastLine));
			previous = "";
		}
		if (parts.length > 0 && previous !== "" && !TIGHT_BEFORE.has(value) && !TIGHT_AFTER.has(previous))
			parts.push(" ");
		parts.push(value);
		previous = value;
		lastLine = lines.position(node.end).line;
	}
	return parts.join("").trim();
}
