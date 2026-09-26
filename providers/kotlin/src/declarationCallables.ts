import { defined } from "@nyaa-lexicon/protocol";
import type { DeclarationWalk, Scope } from "./declarationScope.js";
import { accessOf, contextOf, identifiers, initializerOf, modifiersOf, until } from "./declarationShape.js";
import { headerOf, parameterHeaderOf } from "./header.js";
import { bodyMetrics } from "./metrics.js";
import { childOfType, childrenOfType, nameText, type SyntaxNode } from "./tree.js";
import { TYPE_NODES } from "./typePaths.js";

export function primaryConstructor(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const owner = node.parent;
	const className = owner?.children.find((child) => child.field === "name");
	if (owner === null || className === undefined || scope.classId === undefined) return scope;
	const keyword = childOfType(node, "constructor");
	const parameters = childrenOfType(childOfType(node, "class_parameters") ?? node, "class_parameter");
	const signatureNodes =
		keyword === undefined
			? owner.children.slice(owner.children.indexOf(className), owner.children.indexOf(node) + 1)
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
		signature: headerOf(walk.text, signatureNodes),
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
			signature: headerOf(walk.text, [node]),
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
		signature: parameterHeaderOf(walk.text, [node]),
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
		signature: headerOf(walk.text, [node], body),
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
		signature: headerOf(walk.text, [node], block),
		owns: true,
		metrics: {
			parameters: parameters === undefined ? 0 : childrenOfType(parameters, "parameter").length,
			...bodyMetrics(walk.tree.leaves, block),
		},
	});
	return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
}

/** Modifiers before and a default after sit beside the parameter node, the `index`th of its list. */
export function parameter(walk: DeclarationWalk, node: SyntaxNode, index: number, scope: Scope): void {
	const nameNode = identifiers(node)[0];
	const list = node.parent;
	if (nameNode === undefined || list === null) return;
	const from = list.children[index - 1]?.type === "parameter_modifiers" ? index - 1 : index;
	let to = index;
	for (let next = index + 1; next < list.children.length; next++) {
		const sibling = list.children[next] as SyntaxNode;
		if (
			sibling.type === "," ||
			sibling.type === ")" ||
			sibling.type === "parameter_modifiers" ||
			sibling.type === "parameter"
		)
			break;
		to = next;
	}
	const siblings = list.children.slice(from, to + 1);
	const first = siblings[0] ?? node;
	const last = siblings.at(-1) ?? node;
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
		signature: parameterHeaderOf(walk.text, siblings),
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
		signature: parameterHeaderOf(walk.text, [node]),
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
		signature: parameterHeaderOf(walk.text, [nameNode]),
		owns: false,
	});
	walk.sink.declaredType(
		added.symbolId,
		node.children.find((child) => TYPE_NODES.has(child.type)),
	);
}
