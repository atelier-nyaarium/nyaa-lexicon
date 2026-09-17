import { type Declaration, defined } from "@nyaa-lexicon/protocol";
import type { DeclarationWalk, Scope } from "./declarationScope.js";
import {
	accessOf,
	BODY_TYPES,
	contextOf,
	identifiers,
	LANGUAGE_MODIFIERS,
	leadingAnnotationsSkipped,
	modifiersOf,
	until,
} from "./declarationShape.js";
import { bodyMetrics } from "./metrics.js";
import { render } from "./render.js";
import { childOfType, nameText, type SyntaxNode } from "./tree.js";
import { supertypePaths, TYPE_NODES } from "./typePaths.js";

export function typeDeclaration(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const companion = node.type === "companion_object";
	const object = companion || node.type === "object_declaration";
	const nameNode = node.children.find((child) => child.field === "name" && child.end > child.start);
	const keyword = childOfType(node, companion ? "object" : object ? "object" : "class");
	const interfaceKeyword = childOfType(node, "interface");
	const selection = nameNode ?? (companion ? keyword : undefined);
	if (selection === undefined) return scope;
	const name = nameNode === undefined ? "Companion" : nameText(walk.text, nameNode);
	const modifiers = modifiersOf(walk.text, childOfType(node, "modifiers"));
	const context = contextOf(node);
	const kind: Declaration["kind"] = modifiers.includes("enum")
		? "enum"
		: interfaceKeyword !== undefined
			? "interface"
			: "class";
	const languageParts = [
		...modifiers.filter((modifier) => LANGUAGE_MODIFIERS.has(modifier)),
		...(object ? [companion ? "companionObject" : "object"] : []),
		...(interfaceKeyword !== undefined ? ["interface"] : []),
	];
	const body = node.children.find((child) => BODY_TYPES.has(child.type));
	const added = walk.sink.add({
		node,
		nameNode: selection,
		name,
		kind,
		...defined({ languageKind: languageParts.length === 0 ? undefined : languageParts.join(" ") }),
		descriptorKind: "type",
		scope,
		access: accessOf(modifiers, context),
		signature: render(
			walk.text,
			until(leadingAnnotationsSkipped(node), (child) => BODY_TYPES.has(child.type)),
			walk.lines,
		),
		owns: true,
		metrics: bodyMetrics(walk.tree.leaves, body),
	});
	walk.sink.supertypes(added.symbolId, supertypePaths(walk.text, node));
	return {
		descriptors: added.descriptors,
		containerId: added.symbolId,
		classId: added.symbolId,
		className: name,
	};
}

export function typeAlias(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const nameNode = node.children.find((child) => child.field === "type");
	if (nameNode === undefined || nameNode.end === nameNode.start) return scope;
	const context = contextOf(node);
	const added = walk.sink.add({
		node,
		nameNode,
		name: nameText(walk.text, nameNode),
		kind: "class",
		languageKind: "typealias",
		descriptorKind: "type",
		scope,
		access: accessOf(modifiersOf(walk.text, childOfType(node, "modifiers")), context),
		signature: render(walk.text, leadingAnnotationsSkipped(node), walk.lines),
		owns: true,
	});
	const equals = node.children.findIndex((child) => child.type === "=");
	walk.sink.declaredType(
		added.symbolId,
		node.children.slice(equals + 1).find((child) => TYPE_NODES.has(child.type)),
	);
	return { ...scope, descriptors: added.descriptors, containerId: added.symbolId };
}

export function enumEntry(walk: DeclarationWalk, node: SyntaxNode, scope: Scope): Scope {
	const nameNode = identifiers(node)[0];
	if (nameNode === undefined) return scope;
	const name = nameText(walk.text, nameNode);
	const added = walk.sink.add({
		node,
		nameNode,
		name,
		kind: "constant",
		languageKind: "enumEntry",
		descriptorKind: "term",
		scope,
		access: accessOf([], "class"),
		signature: render(walk.text, [node], walk.lines),
		owns: true,
	});
	return {
		descriptors: added.descriptors,
		containerId: added.symbolId,
		classId: added.symbolId,
		className: name,
	};
}
