import type { TypePath } from "./facts.js";
import { childOfType, childrenOfType, nameText, type SyntaxNode } from "./tree.js";

export const TYPE_NODES: ReadonlySet<string> = new Set([
	"user_type",
	"nullable_type",
	"non_nullable_type",
	"function_type",
	"parenthesized_type",
	"dynamic",
]);

const TYPE_WRAPPERS: ReadonlySet<string> = new Set(["nullable_type", "non_nullable_type", "parenthesized_type"]);

/** A named type's segments; undefined for a function type. */
export function typePath(text: string, node: SyntaxNode | undefined): TypePath | undefined {
	let current = node;
	while (current !== undefined && current.type !== "user_type") {
		if (!TYPE_WRAPPERS.has(current.type)) return undefined;
		current = current.children.find((child) => child.named);
	}
	if (current === undefined) return undefined;
	const segments = childrenOfType(current, "identifier").map((item) => nameText(text, item));
	return segments.length === 0 ? undefined : segments;
}

export function supertypePaths(text: string, node: SyntaxNode): TypePath[] {
	const list = childOfType(node, "delegation_specifiers");
	if (list === undefined) return [];
	const paths: TypePath[] = [];
	for (const specifier of childrenOfType(list, "delegation_specifier")) {
		const inner = specifier.children.find((child) => child.named);
		const type =
			inner?.type === "constructor_invocation" || inner?.type === "explicit_delegation"
				? inner.children.find((child) => TYPE_NODES.has(child.type))
				: inner;
		const path = typePath(text, type);
		if (path !== undefined) paths.push(path);
	}
	return paths;
}
