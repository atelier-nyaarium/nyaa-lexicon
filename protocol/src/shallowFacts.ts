import type { FileFacts, IndexDepth } from "./project.js";

export function shallowFacts<T extends FileFacts>(
	facts: T,
	depth: IndexDepth | undefined,
	options: { includeFullDepth?: boolean } = {},
): T & { depth?: IndexDepth | undefined } {
	if (depth !== "outline" && depth !== "surface") {
		return depth === "full" && options.includeFullDepth ? { ...facts, depth } : facts;
	}

	const projected: FileFacts = { ...facts, depth };
	projected.references = [];
	projected.imports = [];
	projected.literals = [];
	if (facts.comments === undefined) delete projected.comments;
	else projected.comments = [];
	if (facts.docs === undefined) delete projected.docs;
	else projected.docs = [];
	delete projected.blankLines;
	return projected as T & { depth?: IndexDepth | undefined };
}
