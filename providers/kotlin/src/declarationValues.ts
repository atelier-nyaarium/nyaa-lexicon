import { defined } from "@nyaa-lexicon/protocol";
import type { DeclarationWalk, Scope } from "./declarationScope.js";
import {
	accessOf,
	contextOf,
	identifiers,
	initializerOf,
	leadingAnnotationsSkipped,
	modifiersOf,
	until,
} from "./declarationShape.js";
import { render } from "./render.js";
import { childOfType, childrenOfType, nameText, type SyntaxNode } from "./tree.js";
import { TYPE_NODES } from "./typePaths.js";

export function property(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const keyword = node.children.find((child) => child.type === "val" || child.type === "var");
	const multiple = childOfType(node, "multi_variable_declaration");
	const context = contextOf(node);
	if (multiple !== undefined) {
		for (const variable of childrenOfType(multiple, "variable_declaration"))
			binder(walk, variable, scope, "destructured");
		return scope;
	}
	const variable = childOfType(node, "variable_declaration");
	const nameNode = identifiers(variable)[0];
	if (variable === undefined || nameNode === undefined) return scope;
	const modifiers = modifiersOf(walk.text, childOfType(node, "modifiers"));
	const constant = modifiers.includes("const");
	const header = until(
		leadingAnnotationsSkipped(node),
		(child) =>
			child.type === "=" ||
			child.type === "property_delegate" ||
			child.type === "getter" ||
			child.type === "setter",
	);
	const added = walk.sink.add({
		node,
		nameNode,
		name: nameText(walk.text, nameNode),
		kind: context === "function" ? "variable" : constant ? "constant" : "property",
		...defined({ languageKind: constant ? "constVal" : keyword?.type }),
		descriptorKind: "term",
		scope,
		access: accessOf(modifiers, context),
		signature: render(walk.text, header, walk.lines),
		owns: true,
	});
	const beforeName = node.children.slice(0, node.children.indexOf(variable));
	if (beforeName.some((child) => child.type === ".")) walk.sink.receiverType(added.symbolId, beforeName);
	const type = variable.children.find((child) => TYPE_NODES.has(child.type));
	if (type !== undefined) walk.sink.declaredType(added.symbolId, type);
	else walk.sink.inferredType(added.symbolId, initializerOf(node));
	// A local's initializer binds into its function, as a block does.
	if (context === "function") return scope;
	walk.sink.holdsValues(added.declaration);
	return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
}

export function boundVariables(node: SyntaxNode): SyntaxNode[] {
	return node.children.flatMap((child) =>
		child.type === "variable_declaration"
			? [child]
			: child.type === "multi_variable_declaration"
				? childrenOfType(child, "variable_declaration")
				: [],
	);
}

/** A parameter descriptor unless the binder is a `val`, so no new binder renumbers a `val` local. */
export function binder(
	walk: DeclarationWalk,
	variable: SyntaxNode,
	scope: Scope,
	languageKind: string,
	descriptorKind: "parameter" | "term" = "parameter",
): void {
	const nameNode = identifiers(variable)[0];
	if (nameNode === undefined) return;
	const name = nameText(walk.text, nameNode);
	// `_` binds nothing.
	if (name === "_") return;
	const added = walk.sink.add({
		node: variable,
		nameNode,
		name,
		kind: "variable",
		languageKind,
		descriptorKind,
		scope,
		access: { visibility: "local", exported: false },
		signature: render(walk.text, [variable], walk.lines),
		owns: false,
	});
	walk.sink.declaredType(
		added.symbolId,
		variable.children.find((child) => TYPE_NODES.has(child.type)),
	);
}

export function catchParameter(walk: DeclarationWalk, node: SyntaxNode, nameNode: SyntaxNode, scope: Scope): void {
	const type = node.children.find((child) => TYPE_NODES.has(child.type));
	const added = walk.sink.add({
		node: nameNode,
		end: type?.end ?? nameNode.end,
		nameNode,
		name: nameText(walk.text, nameNode),
		kind: "variable",
		languageKind: "catch",
		descriptorKind: "parameter",
		scope,
		access: { visibility: "local", exported: false },
		signature: render(
			walk.text,
			type === undefined
				? [nameNode]
				: node.children.slice(node.children.indexOf(nameNode), node.children.indexOf(type) + 1),
			walk.lines,
		),
		owns: false,
	});
	walk.sink.declaredType(added.symbolId, type);
}
