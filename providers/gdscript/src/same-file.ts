// Owns which same-file declarations an unqualified name binds to.

import type { Declaration, Reference } from "@nyaa-lexicon/protocol";

//////// Types

/** The fields same-file binding reads. */
export type ScopedDeclaration = Pick<Declaration, "symbolId" | "kind" | "name" | "containerId" | "visibility">;

type ScopedReference = Pick<Reference, "name" | "role" | "fromId" | "qualified">;

//////// Helpers

function sameFileKind(role: Reference["role"], declaration: ScopedDeclaration): boolean {
	if (declaration.visibility === "local") return false;
	if (role === "call") return declaration.kind === "method" || declaration.kind === "function";
	if (role === "write") return declaration.kind === "property";
	if (role === "extends") return declaration.kind === "class";
	if (role === "typeUse") return declaration.kind === "class" || declaration.kind === "enum";
	return true;
}

function sameFileContainer(declarations: readonly ScopedDeclaration[], reference: ScopedReference): string | undefined {
	const root = declarations.find(
		(declaration) => declaration.kind === "class" && declaration.containerId === undefined,
	);
	if (root === undefined || reference.fromId === root.symbolId) return root?.symbolId;
	const owner = declarations.find((declaration) => declaration.symbolId === reference.fromId);
	if (owner?.kind === "class") return owner.symbolId;
	return owner?.containerId ?? root.symbolId;
}

function lexicallyVisible(
	declarations: readonly ScopedDeclaration[],
	reference: ScopedReference,
	candidate: ScopedDeclaration,
): boolean {
	const visibleContainers = new Set<string>();
	let current = reference.fromId;
	while (current !== undefined) {
		visibleContainers.add(current);
		current = declarations.find((declaration) => declaration.symbolId === current)?.containerId;
	}
	const root = declarations.find((declaration) => declaration.containerId === undefined);
	return (
		candidate.containerId === undefined ||
		candidate.symbolId === root?.symbolId ||
		visibleContainers.has(candidate.containerId ?? "")
	);
}

//////// Binding

/** Same-file declarations an unqualified name binds to. */
export function sameFileCandidates<D extends ScopedDeclaration>(
	declarations: readonly D[],
	reference: ScopedReference,
): D[] {
	if (reference.qualified === true) return [];
	const containerId = sameFileContainer(declarations, reference);
	return declarations.filter(
		(declaration) =>
			declaration.name === reference.name &&
			(reference.role === "extends"
				? lexicallyVisible(declarations, reference, declaration)
				: declaration.containerId === containerId) &&
			sameFileKind(reference.role, declaration),
	);
}
