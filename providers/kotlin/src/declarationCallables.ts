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
import { bodyMetrics } from "./metrics.js";
import { render } from "./render.js";
import { childOfType, childrenOfType, nameText, type SyntaxNode } from "./tree.js";
import { TYPE_NODES } from "./typePaths.js";

export function primaryConstructor(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const owner = node.parent;
	const className = owner?.children.find((child) => child.field === "name");
	if (owner === null || className === undefined || scope.classId === undefined) return scope;
	const keyword = childOfType(node, "constructor");
	const parameters = childrenOfType(childOfType(node, "class_parameters") ?? node, "class_parameter");
	const typeParameters = childOfType(owner, "type_parameters");
	const signatureNodes =
		keyword === undefined
			? [className, ...(typeParameters === undefined ? [] : [typeParameters]), node]
			: node.children.slice(node.children.indexOf(keyword));
	const added = walk.sink.add({
		node,
		start: keyword === undefined ? className.start : node.start,
		nameNode: keyword ?? className,
		name: scope.className ?? nameText(walk.text, className),
		kind: "constructor",
		languageKind: "primaryConstructor",
		descriptorKind: "method",
		scope,
		access: accessOf(modifiersOf(walk.text, childOfType(node, "modifiers")), "class"),
		signature: render(walk.text, signatureNodes, walk.lines),
		owns: true,
		metrics: { parameters: parameters.length },
	});
	return { ...scope, descriptors: added.descriptors, containerId: added.symbolId, classScope: scope };
}

export function classParameter(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): void {
	const nameNode = identifiers(node)[0];
	if (nameNode === undefined) return;
	const name = nameText(walk.text, nameNode);
	const keyword = node.children.find((child) => child.type === "val" || child.type === "var");
	const type = node.children.find((child) => TYPE_NODES.has(child.type));
	const signature = render(walk.text, [node], walk.lines);
	if (keyword !== undefined && scope.classScope !== undefined) {
		const added = walk.sink.add({
			node,
			nameNode,
			name,
			kind: "property",
			languageKind: keyword.type === "var" ? "constructorVar" : "constructorVal",
			descriptorKind: "term",
			scope: scope.classScope,
			access: accessOf(modifiersOf(walk.text, childOfType(node, "modifiers")), "class"),
			signature,
			owns: false,
		});
		if (type !== undefined) walk.sink.declaredType(added.symbolId, type);
		else walk.sink.inferredType(added.symbolId, initializerOf(node));
		return;
	}
	const added = walk.sink.add({
		node,
		nameNode,
		name,
		kind: "variable",
		languageKind: "parameter",
		descriptorKind: "parameter",
		scope,
		access: { visibility: "local", exported: false },
		signature,
		owns: false,
	});
	walk.sink.declaredType(added.symbolId, type);
}

export function functionDeclaration(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const nameNode = node.children.find((child) => child.field === "name" && child.end > child.start);
	if (nameNode === undefined) return scope;
	const modifiers = modifiersOf(walk.text, childOfType(node, "modifiers"));
	const context = contextOf(node);
	const parameters = childOfType(node, "function_value_parameters");
	const nameIndex = node.children.indexOf(nameNode);
	const dot = node.children.slice(0, nameIndex).findLastIndex((child) => child.type === ".");
	const receiver = dot >= 0;
	const body = childOfType(node, "function_body");
	const languageParts = [
		...(modifiers.includes("suspend") ? ["suspend"] : []),
		...(receiver ? ["extensionFunction"] : []),
	];
	const added = walk.sink.add({
		node,
		nameNode,
		name: nameText(walk.text, nameNode),
		kind: context === "class" ? "method" : "function",
		...defined({ languageKind: languageParts.length === 0 ? undefined : languageParts.join(" ") }),
		descriptorKind: "method",
		scope,
		access: accessOf(modifiers, context),
		signature: render(
			walk.text,
			until(leadingAnnotationsSkipped(node), (child) => child.type === "function_body"),
			walk.lines,
		),
		owns: true,
		metrics: {
			parameters: parameters === undefined ? 0 : childrenOfType(parameters, "parameter").length,
			...bodyMetrics(walk.tree.leaves, childOfType(body ?? node, "block")),
		},
	});
	if (receiver) walk.sink.receiverType(added.symbolId, node.children.slice(0, dot));
	if (parameters !== undefined) {
		const after = node.children.slice(node.children.indexOf(parameters) + 1);
		walk.sink.declaredType(
			added.symbolId,
			until(after, (child) => child.type === "function_body").find((child) => TYPE_NODES.has(child.type)),
		);
	}
	return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
}

export function secondaryConstructor(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const keyword = childOfType(node, "constructor");
	if (keyword === undefined) return scope;
	const parameters = childOfType(node, "function_value_parameters");
	const block = childOfType(node, "block");
	const added = walk.sink.add({
		node,
		nameNode: keyword,
		name: scope.className ?? "constructor",
		kind: "constructor",
		languageKind: "secondaryConstructor",
		descriptorKind: "method",
		scope,
		access: accessOf(modifiersOf(walk.text, childOfType(node, "modifiers")), contextOf(node)),
		signature: render(
			walk.text,
			until(leadingAnnotationsSkipped(node), (child) => child.type === "block"),
			walk.lines,
		),
		owns: true,
		metrics: {
			parameters: parameters === undefined ? 0 : childrenOfType(parameters, "parameter").length,
			...bodyMetrics(walk.tree.leaves, block),
		},
	});
	return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
}

/** Modifiers before and a default after sit beside the parameter node. */
export function parameter(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): void {
	const nameNode = identifiers(node)[0];
	const list = node.parent;
	if (nameNode === undefined || list === null) return;
	const index = list.children.indexOf(node);
	const before = list.children[index - 1];
	const first = before?.type === "parameter_modifiers" ? before : node;
	let last = node;
	for (let next = index + 1; next < list.children.length; next++) {
		const sibling = list.children[next] as SyntaxNode;
		if (
			sibling.type === "," ||
			sibling.type === ")" ||
			sibling.type === "parameter_modifiers" ||
			sibling.type === "parameter"
		)
			break;
		last = sibling;
	}
	const siblings = list.children.slice(list.children.indexOf(first), list.children.indexOf(last) + 1);
	const added = walk.sink.add({
		node,
		start: first.start,
		end: last.end,
		nameNode,
		name: nameText(walk.text, nameNode),
		kind: "variable",
		languageKind: "parameter",
		descriptorKind: "parameter",
		scope,
		access: { visibility: "local", exported: false },
		signature: render(walk.text, siblings, walk.lines),
		owns: false,
	});
	walk.sink.declaredType(
		added.symbolId,
		node.children.find((child) => TYPE_NODES.has(child.type)),
	);
}

export function typeParameter(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): void {
	const nameNode = identifiers(node)[0];
	if (nameNode === undefined) return;
	walk.sink.add({
		node,
		nameNode,
		name: nameText(walk.text, nameNode),
		kind: "typeParameter",
		languageKind: "typeParameter",
		descriptorKind: "typeParameter",
		scope,
		access: { visibility: "local", exported: false },
		signature: render(walk.text, [node], walk.lines),
		owns: false,
	});
}

export function setterParameter(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): void {
	const nameNode = identifiers(node)[0];
	if (nameNode === undefined) return;
	const added = walk.sink.add({
		node: nameNode,
		nameNode,
		name: nameText(walk.text, nameNode),
		kind: "variable",
		languageKind: "parameter",
		descriptorKind: "parameter",
		scope,
		access: { visibility: "local", exported: false },
		signature: render(walk.text, [nameNode], walk.lines),
		owns: false,
	});
	walk.sink.declaredType(
		added.symbolId,
		node.children.find((child) => TYPE_NODES.has(child.type)),
	);
}
