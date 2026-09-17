import type { Declaration } from "@nyaa-lexicon/protocol";
import { childrenOfType, type SyntaxNode } from "./tree.js";

export type Context = "module" | "class" | "function";

export const BODY_TYPES: ReadonlySet<string> = new Set(["class_body", "enum_class_body"]);

export const LANGUAGE_MODIFIERS: ReadonlySet<string> = new Set([
	"data",
	"sealed",
	"abstract",
	"inner",
	"enum",
	"annotation",
	"value",
]);

export function identifiers(node: SyntaxNode | undefined): SyntaxNode[] {
	return node === undefined ? [] : childrenOfType(node, "identifier").filter((item) => item.end > item.start);
}

export function contextOf(node: SyntaxNode): Context {
	let parent = node.parent;
	while (parent !== null && parent.type === "ERROR") parent = parent.parent;
	if (parent === null || parent.type === "source_file") return "module";
	if (BODY_TYPES.has(parent.type) && parent.parent !== null && parent.parent.type !== "object_literal")
		return "class";
	return "function";
}

export function leadingAnnotationsSkipped(node: SyntaxNode): SyntaxNode[] {
	const out: SyntaxNode[] = [];
	let leading = true;
	for (const child of node.children) {
		if (child.type === "modifiers") {
			for (const modifier of child.children) {
				if (leading && modifier.type === "annotation") continue;
				leading = false;
				out.push(modifier);
			}
			continue;
		}
		leading = false;
		out.push(child);
	}
	return out;
}

export function until(nodes: SyntaxNode[], stop: (node: SyntaxNode) => boolean): SyntaxNode[] {
	const index = nodes.findIndex(stop);
	return index < 0 ? nodes : nodes.slice(0, index);
}

export function modifiersOf(text: string, node: SyntaxNode | undefined): string[] {
	if (node === undefined) return [];
	return node.children
		.filter((child) => child.type !== "annotation")
		.map((child) => text.slice(child.start, child.end));
}

export function accessOf(modifiers: string[], context: Context): Pick<Declaration, "visibility" | "exported"> {
	if (context === "function") return { visibility: "local", exported: false };
	if (modifiers.includes("private")) return { visibility: "private", exported: false };
	if (modifiers.includes("protected")) return { visibility: "protected", exported: false };
	if (modifiers.includes("internal")) return { visibility: "internal", exported: true };
	return { visibility: "public", exported: true };
}

export function initializerOf(node: SyntaxNode): SyntaxNode | undefined {
	const equals = node.children.findIndex((child) => child.type === "=");
	return equals < 0 ? undefined : node.children.slice(equals + 1).find((child) => child.named);
}
